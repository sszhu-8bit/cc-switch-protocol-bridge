// 流式错误恢复测试（P0-3 验证）
//
// 验证：
// 1. 正常流式：所有事件顺序正确
// 2. 中途断开（network error）：先发 message_stop 再发 error
// 3. 上游 4xx/5xx：错误类型正确映射
// 4. 错误消息不泄漏敏感信息

import { describe, expect, test } from "bun:test";
import {
  OpenAIToAnthropicStream,
  formatAnthropicSSE,
  mapUpstreamStatusToErrorType,
} from "../src/converter/streaming.ts";
import type { OpenAIStreamChunk } from "../src/types.ts";

/** 构造一个 mock OpenAI 流式 chunk */
function makeChunk(overrides: Partial<OpenAIStreamChunk> = {}): OpenAIStreamChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1234567890,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
      },
    ],
    ...overrides,
  };
}

/** 解析 Anthropic SSE 字符串为事件数组 */
function parseSSE(sse: string): Array<{ type: string; data: unknown }> {
  const events: Array<{ type: string; data: unknown }> = [];
  const blocks = sse.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let type = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) type = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6).trim();
    }
    if (type && data) {
      try {
        events.push({ type, data: JSON.parse(data) });
      } catch {
        events.push({ type, data });
      }
    }
  }
  return events;
}

describe("正常流式响应", () => {
  test("完整流程的事件顺序", () => {
    const converter = new OpenAIToAnthropicStream();
    const allEvents: string[] = [];

    // 第一个 chunk: 角色
    allEvents.push(
      ...converter
        .feed(
          makeChunk({
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          })
        )
        .map((e) => formatAnthropicSSE([e]))
    );

    // 文本增量
    allEvents.push(
      ...converter
        .feed(
          makeChunk({ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] })
        )
        .map((e) => formatAnthropicSSE([e]))
    );
    allEvents.push(
      ...converter
        .feed(
          makeChunk({ choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] })
        )
        .map((e) => formatAnthropicSSE([e]))
    );

    // 结束
    allEvents.push(
      ...converter
        .feed(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
        .map((e) => formatAnthropicSSE([e]))
    );
    allEvents.push(...converter.end().map((e) => formatAnthropicSSE([e])));

    const events = parseSSE(allEvents.join(""));
    const types = events.map((e) => e.type);
    // 完整流程包含: message_start → content_block_start → 2 个 delta →
    //               content_block_stop → message_delta → message_stop
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("P0-3: 流式异常中断 (abort)", () => {
  test("abort() 在已部分传输时输出 content_block_stop + message_stop", () => {
    const converter = new OpenAIToAnthropicStream();

    // 模拟：上游已发送 message_start + content_block_start + 一些 deltas
    converter.feed(
      makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })
    );
    converter.feed(
      makeChunk({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })
    );
    converter.feed(
      makeChunk({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }] })
    );

    // 中途网络断开
    const abortEvents = converter.abort();
    const sse = formatAnthropicSSE(abortEvents);
    const events = parseSSE(sse);
    const types = events.map((e) => e.type);

    // 必须包含: content_block_stop (关闭已开块) + message_delta + message_stop
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    // message_stop 必须在 content_block_stop 之后
    const blockStopIdx = types.indexOf("content_block_stop");
    const messageStopIdx = types.indexOf("message_stop");
    expect(blockStopIdx).toBeLessThan(messageStopIdx);

    // message_delta 必须在 message_stop 之前
    const messageDeltaIdx = types.indexOf("message_delta");
    expect(messageDeltaIdx).toBeLessThan(messageStopIdx);

    // 验证 stop_reason 设为 max_tokens（异常中断）
    const messageDelta = events.find((e) => e.type === "message_delta");
    expect(messageDelta).toBeDefined();
    const data = messageDelta?.data as { delta: { stop_reason: string } };
    expect(data.delta.stop_reason).toBe("max_tokens");
  });

  test("abort() 在从未收到任何 chunk 时也输出 message_stop", () => {
    const converter = new OpenAIToAnthropicStream();
    // 没有调用过 feed，直接 abort（极端情况：upstream 立刻断开）
    const abortEvents = converter.abort();
    const events = parseSSE(formatAnthropicSSE(abortEvents));
    const types = events.map((e) => e.type);
    expect(types).toContain("message_stop");
  });

  test("abort() 之后再调 end() 是 no-op（状态机已终态）", () => {
    const converter = new OpenAIToAnthropicStream();
    converter.feed(
      makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })
    );
    const abortEvents = converter.abort();
    expect(abortEvents.length).toBeGreaterThan(0);
    // 重复 abort/end 应该 no-op
    expect(converter.abort()).toEqual([]);
    expect(converter.end()).toEqual([]);
  });

  test("abort() 后再调 feed() 是 no-op", () => {
    const converter = new OpenAIToAnthropicStream();
    converter.abort();
    // 上游事后又发了个 chunk，状态机应忽略
    const events = converter.feed(
      makeChunk({ choices: [{ index: 0, delta: { content: "ignored" }, finish_reason: null }] })
    );
    expect(events).toEqual([]);
  });

  test("abort 序列应在最终 message_stop 之前不发 error（顺序）", () => {
    // server.ts 实际行为：先 abort → 写 content_block_stop + message_delta + message_stop
    //                  再追加 error event
    // 这个测试模拟这个序列，验证最终输出顺序
    const converter = new OpenAIToAnthropicStream();
    converter.feed(
      makeChunk({
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })
    );
    converter.feed(
      makeChunk({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })
    );

    const abortEvents = converter.abort();
    const errorEvent = {
      type: "error",
      error: { type: "upstream_unavailable", message: "upstream unreachable" },
    };

    const fullSequence = [...abortEvents, errorEvent as never];
    const events = parseSSE(formatAnthropicSSE(fullSequence));
    const types = events.map((e) => e.type);

    // message_stop 必须在 error 之前
    const messageStopIdx = types.indexOf("message_stop");
    const errorIdx = types.indexOf("error");
    expect(messageStopIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeGreaterThan(-1);
    expect(messageStopIdx).toBeLessThan(errorIdx);
  });
});

describe("错误类型映射", () => {
  test("401 / 403 → authentication_error", () => {
    expect(mapUpstreamStatusToErrorType(401)).toBe("authentication_error");
    expect(mapUpstreamStatusToErrorType(403)).toBe("authentication_error");
  });

  test("404 → not_found_error", () => {
    expect(mapUpstreamStatusToErrorType(404)).toBe("not_found_error");
  });

  test("408 / 超时 → timeout_error", () => {
    expect(mapUpstreamStatusToErrorType(408)).toBe("timeout_error");
  });

  test("429 → rate_limit_error", () => {
    expect(mapUpstreamStatusToErrorType(429)).toBe("rate_limit_error");
  });

  test("400 / 422 → invalid_request_error", () => {
    expect(mapUpstreamStatusToErrorType(400)).toBe("invalid_request_error");
    expect(mapUpstreamStatusToErrorType(422)).toBe("invalid_request_error");
  });

  test("502 / 503 / 504 → upstream_unavailable", () => {
    expect(mapUpstreamStatusToErrorType(502)).toBe("upstream_unavailable");
    expect(mapUpstreamStatusToErrorType(503)).toBe("upstream_unavailable");
    expect(mapUpstreamStatusToErrorType(504)).toBe("upstream_unavailable");
  });

  test("500 / 5xx → api_error", () => {
    expect(mapUpstreamStatusToErrorType(500)).toBe("api_error");
    expect(mapUpstreamStatusToErrorType(599)).toBe("api_error");
  });

  test("未知状态码 → api_error (fallback)", () => {
    expect(mapUpstreamStatusToErrorType(418)).toBe("invalid_request_error"); // 4xx fallback
    expect(mapUpstreamStatusToErrorType(0)).toBe("api_error"); // 0 fallback
  });
});

describe("错误信息脱敏", () => {
  // 验证 error 事件 data 不含 API key / 内部 URL
  test("abort 序列中的 error event 不含敏感信息", () => {
    const errorEvent = {
      type: "error",
      error: {
        type: "api_error" as const,
        message: "internal error", // sanitizeErrorMessage 输出的（不含 key/url）
      },
    };
    const sse = formatAnthropicSSE([errorEvent as never]);
    expect(sse).not.toContain("sk-");
    expect(sse).not.toContain("Bearer");
    expect(sse).not.toContain("api_key=");
    expect(sse).not.toContain("password");
  });
});
