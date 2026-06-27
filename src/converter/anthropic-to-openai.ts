// Anthropic Messages API -> OpenAI Chat Completions API 转换器
// 单请求（非流式）方向

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
} from "../types.js";

/**
 * 将 Anthropic system 字段（string 或 array）压平成 OpenAI 单条 system 消息
 */
function flattenSystem(
  system: AnthropicMessagesRequest["system"]
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  // array 形式，提取所有 text 字段拼接，丢弃 cache_control
  return system.map((b) => b.text).join("");
}

/**
 * 将 Anthropic content block 数组转换为 OpenAI content 字符串
 * 多模态/工具调用会在 tool_calls / 多条消息里表达
 */
function convertAssistantContent(
  content: AnthropicContentBlock[]
): { text: string | null; tool_calls: NonNullable<OpenAIMessage["tool_calls"]> } {
  const textParts: string[] = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
    // 助手消息里出现 image 在 Anthropic 是允许的，但 OpenAI 助手消息通常不带 image。
    // 这种情况实际很少见，遇到时丢弃。
  }
  return {
    text: textParts.length > 0 ? textParts.join("") : null,
    tool_calls: toolCalls,
  };
}

/**
 * 将 Anthropic 单条消息转换为 OpenAI 消息列表
 * tool_result 消息需要展开为独立的 tool 消息
 */
function convertMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  // 文本+多模态+工具混合情况
  if (msg.role === "user") {
    const textParts: string[] = [];
    const toolResults: OpenAIMessage[] = [];
    const imageBlocks: Array<{ media_type: string; data: string }> = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        imageBlocks.push(block.source);
      } else if (block.type === "tool_result") {
        const resultText =
          typeof block.content === "string"
            ? block.content
            : block.content
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("");
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `[error] ${resultText}` : resultText,
        });
      }
    }

    const userContent =
      imageBlocks.length > 0
        ? [
            { type: "text" as const, text: textParts.join("") || "(see image)" },
            ...imageBlocks.map((img) => ({
              type: "image_url" as const,
              image_url: {
                url: `data:${img.media_type};base64,${img.data}`,
              },
            })),
          ]
        : textParts.join("");

    return [{ role: "user", content: userContent }, ...toolResults];
  }

  // assistant 消息
  const { text, tool_calls } = convertAssistantContent(msg.content);
  const result: OpenAIMessage = { role: "assistant", content: text };
  if (tool_calls.length > 0) {
    result.tool_calls = tool_calls;
  }
  return [result];
}

/**
 * 主转换入口：Anthropic Messages Request -> OpenAI Chat Request
 */
export function anthropicToOpenAI(req: AnthropicMessagesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];

  const systemText = flattenSystem(req.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const m of req.messages) {
    messages.push(...convertMessage(m));
  }

  const result: OpenAIChatRequest = {
    model: req.model,
    messages,
    stream: req.stream,
  };

  if (req.max_tokens !== undefined) result.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stop_sequences !== undefined) result.stop = req.stop_sequences;

  if (req.tools && req.tools.length > 0) {
    result.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
    if (req.tool_choice) {
      if (req.tool_choice.type === "auto") result.tool_choice = "auto";
      else if (req.tool_choice.type === "any") result.tool_choice = "required";
      else if (req.tool_choice.type === "tool" && req.tool_choice.name) {
        result.tool_choice = { type: "function", function: { name: req.tool_choice.name } };
      }
    }
  }

  if (req.metadata?.user_id) {
    result.user = req.metadata.user_id;
  }

  return result;
}

/**
 * OpenAI Chat Response -> Anthropic Messages Response
 */
export function openAIToAnthropic(resp: OpenAIChatResponse): AnthropicMessagesResponse {
  const choice = resp.choices[0];
  if (!choice) {
    throw new Error("OpenAI response has no choices");
  }

  const content: AnthropicContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  const stopReason = mapFinishReason(choice.finish_reason);

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content,
    model: resp.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(
  reason: OpenAIChatResponse["choices"][0]["finish_reason"]
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
      return null;
  }
}