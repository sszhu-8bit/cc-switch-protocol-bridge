// SSE 流式转换：OpenAI Chat Completions streaming -> Anthropic Messages streaming
// 这是最复杂的部分。Claude Code 默认发送 stream: true 请求。

import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  OpenAIStreamChunk,
} from "../types.js";

/**
 * 流式转换器：消费 OpenAI SSE chunks，产出 Anthropic SSE events
 *
 * 设计要点：
 * - 状态机：跟踪 message_start / content_block_start / content_block_delta / message_stop
 * - text 块和 tool_calls 块分开计数
 * - 收到 finish_reason 时关闭当前块并发 message_delta + message_stop
 */
export class OpenAIToAnthropicStream {
  private msgId: string = "";
  private model: string = "";
  private inputTokens: number = 0;
  private outputTokens: number = 0;

  /** 当前活跃的 content block index */
  private textBlockIndex: number = -1;
  private textBlockStarted: boolean = false;

  /** 当前 tool_call 块累计 */
  private toolCalls: Map<
    number,
    {
      index: number;
      id: string;
      name: string;
      argsBuffer: string;
      blockStarted: boolean;
    }
  > = new Map();

  /** 已发送的 content_block 总数（用于 index 分配） */
  private nextBlockIndex: number = 0;

  /** 消息是否已开始 */
  private started: boolean = false;

  /** 是否已结束 */
  private finished: boolean = false;

  /** 累计的工具调用最终 finish_reason */
  private finalFinishReason:
    | "end_turn"
    | "max_tokens"
    | "tool_use"
    | "stop_sequence"
    | null = null;

  /** 累积的文本（用于最终 fallback） */
  private textBuffer: string = "";

  /**
   * 处理一个 OpenAI 流式 chunk，返回一个或多个 Anthropic 事件
   * chunk 可能是 [DONE] 哨兵（用 null 表示）
   */
  feed(chunk: OpenAIStreamChunk | null): AnthropicStreamEvent[] {
    if (this.finished) return [];

    const events: AnthropicStreamEvent[] = [];

    if (chunk === null) {
      // [DONE] 哨兵：确保块已关闭并发送 message_stop
      this.ensureTextBlockClosed(events);
      this.flushStopEvents(events);
      return events;
    }

    this.msgId = chunk.id;
    this.model = chunk.model;

    if (!this.started) {
      this.started = true;
      events.push({
        type: "message_start",
        message: {
          id: chunk.id,
          type: "message",
          role: "assistant",
          content: [],
          model: chunk.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    for (const choice of chunk.choices) {
      const delta = choice.delta;

      // 处理文本增量
      if (delta.content) {
        this.textBuffer += delta.content;
        if (!this.textBlockStarted) {
          this.textBlockStarted = true;
          this.textBlockIndex = this.nextBlockIndex++;
          events.push({
            type: "content_block_start",
            index: this.textBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        events.push({
          type: "content_block_delta",
          index: this.textBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // 处理 tool_calls 增量
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = this.toolCalls.get(idx);
          if (!entry) {
            entry = {
              index: this.nextBlockIndex++,
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              argsBuffer: "",
              blockStarted: false,
            };
            this.toolCalls.set(idx, entry);
          }
          if (!entry.blockStarted) {
            entry.blockStarted = true;
            events.push({
              type: "content_block_start",
              index: entry.index,
              content_block: {
                type: "tool_use",
                id: entry.id,
                name: entry.name,
                input: {},
              },
            });
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.argsBuffer += tc.function.arguments;
            events.push({
              type: "content_block_delta",
              index: entry.index,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            });
          }
        }
      }

      // 处理 finish_reason
      if (choice.finish_reason) {
        this.finalFinishReason = mapFinishReason(choice.finish_reason);
      }
    }

    // 处理 usage（OpenAI 在最后一个 chunk 的独立字段里）
    if ((chunk as unknown as { usage?: { prompt_tokens: number; completion_tokens: number } }).usage) {
      const u = (chunk as unknown as {
        usage: { prompt_tokens: number; completion_tokens: number };
      }).usage;
      this.inputTokens = u.prompt_tokens;
      this.outputTokens = u.completion_tokens;
    }

    return events;
  }

  /**
   * 流结束时调用，确保所有块已关闭并发送终止事件
   */
  end(): AnthropicStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const events: AnthropicStreamEvent[] = [];
    this.ensureTextBlockClosed(events);
    this.flushStopEvents(events);
    return events;
  }

  /**
   * 流中途异常中断时调用（P0-3 修复）
   *
   * 与 end() 区别：
   * - end() 是正常完成，stop_reason 是上游告诉我们的（end_turn 等）
   * - abort() 是异常中断，stop_reason 强制设为 max_tokens（语义：长度截断）
   * - 调用 abort() 后再调用 feed() / end() 是 no-op（状态机已终态）
   *
   * 输出事件顺序（保证客户端能"干净地"收尾）：
   *   1. content_block_stop（关闭未完的文本块 / 工具块）
   *   2. message_delta（带 stop_reason 和 usage）
   *   3. message_stop
   *
   * 调用方在收到这些事件后应**再发**一个 error 事件，让客户端
   * 知道是异常中断而非正常完成。
   */
  abort(): AnthropicStreamEvent[] {
    if (this.finished) return [];
    this.finished = true;
    // 异常中断：stop_reason 用 max_tokens（"被截断"），避免 end_turn
    // 误表达"模型正常完成"
    this.finalFinishReason = "max_tokens";
    const events: AnthropicStreamEvent[] = [];
    this.ensureTextBlockClosed(events);
    this.flushStopEvents(events);
    return events;
  }

  private ensureTextBlockClosed(events: AnthropicStreamEvent[]) {
    if (this.textBlockStarted) {
      events.push({
        type: "content_block_stop",
        index: this.textBlockIndex,
      });
      this.textBlockStarted = false;
    }
  }

  private flushStopEvents(events: AnthropicStreamEvent[]) {
    // 关闭所有未关闭的 tool_use 块
    for (const entry of this.toolCalls.values()) {
      if (entry.blockStarted) {
        events.push({ type: "content_block_stop", index: entry.index });
      }
    }
    events.push({
      type: "message_delta",
      delta: { stop_reason: this.finalFinishReason, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    events.push({ type: "message_stop" });
  }
}

function mapFinishReason(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null
): AnthropicMessagesResponse["stop_reason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * 将 Anthropic 事件数组序列化为 Anthropic 官方 SSE 格式
 */
export function formatAnthropicSSE(events: AnthropicStreamEvent[]): string {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

/**
 * Anthropic 错误类型（参考官方 SDK）
 * https://docs.anthropic.com/en/api/errors
 */
export type AnthropicErrorType =
  | "api_error"           // 通用服务端错误
  | "overloaded_error"    // 429 / 503：上游过载
  | "rate_limit_error"    // 429：限流
  | "authentication_error" // 401 / 403：认证失败
  | "permission_error"    // 403：权限不足
  | "not_found_error"     // 404：模型 / 端点不存在
  | "invalid_request_error" // 400：请求格式错
  | "timeout_error"       // 上游超时
  | "upstream_unavailable" // 502/503/504：上游不可达
  ;

/**
 * 将上游 HTTP 状态码映射到 Anthropic 错误类型
 * 客户端可以基于 type 做智能重试
 */
export function mapUpstreamStatusToErrorType(status: number): AnthropicErrorType {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 408) return "timeout_error";
  if (status === 429) return "rate_limit_error";
  if (status === 400 || status === 422) return "invalid_request_error";
  if (status === 502 || status === 503 || status === 504) return "upstream_unavailable";
  if (status >= 500 && status < 600) return "api_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}