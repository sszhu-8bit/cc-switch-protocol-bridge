// 转换器单元测试（不依赖真实网络）
import { describe, expect, test } from "bun:test";
import { anthropicToOpenAI, openAIToAnthropic } from "../src/converter/anthropic-to-openai.ts";
import { OpenAIToAnthropicStream, formatAnthropicSSE } from "../src/converter/streaming.ts";
import type {
  AnthropicMessagesRequest,
  OpenAIChatResponse,
  OpenAIStreamChunk,
} from "../src/types.ts";

describe("anthropic-to-openai single request", () => {
  test("converts simple text message", () => {
    const req: AnthropicMessagesRequest = {
      model: "sonnet",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = anthropicToOpenAI(req);
    expect(result.model).toBe("sonnet");
    expect(result.max_tokens).toBe(100);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("Hello");
  });

  test("flattens system prompt from array", () => {
    const req: AnthropicMessagesRequest = {
      model: "sonnet",
      max_tokens: 100,
      system: [
        { type: "text", text: "You are " },
        { type: "text", text: "helpful." },
      ],
      messages: [{ role: "user", content: "Hi" }],
    };
    const result = anthropicToOpenAI(req);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe("You are helpful.");
  });

  test("converts tool_use assistant message", () => {
    const req: AnthropicMessagesRequest = {
      model: "sonnet",
      max_tokens: 100,
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            {
              type: "tool_use",
              id: "tool_123",
              name: "get_weather",
              input: { city: "Beijing" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_123", content: "Sunny, 25°C" }],
        },
      ],
    };
    const result = anthropicToOpenAI(req);
    // 原始: user, assistant, user(tool_result)
    // 转换后: user, assistant, user(展开), tool (4 条)
    expect(result.messages).toHaveLength(4);
    const assistantMsg = result.messages[1];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).toBe("Let me check.");
    expect(assistantMsg?.tool_calls).toHaveLength(1);
    expect(assistantMsg?.tool_calls?.[0]?.function.name).toBe("get_weather");
    expect(assistantMsg?.tool_calls?.[0]?.function.arguments).toBe('{"city":"Beijing"}');
    const toolMsg = result.messages[3];
    expect(toolMsg?.role).toBe("tool");
    expect(toolMsg?.tool_call_id).toBe("tool_123");
    expect(toolMsg?.content).toBe("Sunny, 25°C");
  });

  test("converts tools definitions", () => {
    const req: AnthropicMessagesRequest = {
      model: "sonnet",
      max_tokens: 100,
      tools: [
        {
          name: "search",
          description: "Search the web",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      tool_choice: { type: "tool", name: "search" },
      messages: [{ role: "user", content: "Find X" }],
    };
    const result = anthropicToOpenAI(req);
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0]?.type).toBe("function");
    expect(result.tools?.[0]?.function.name).toBe("search");
    expect(result.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "search" },
    });
  });
});

describe("openai-to-anthropic single response", () => {
  test("converts simple text response", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "sonnet",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = openAIToAnthropic(resp);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
  });

  test("converts tool_calls response", () => {
    const resp: OpenAIChatResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "sonnet",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc_1",
                type: "function",
                function: { name: "search", arguments: '{"q":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const result = openAIToAnthropic(resp);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("tool_use");
    if (result.content[0]?.type === "tool_use") {
      expect(result.content[0].name).toBe("search");
      expect(result.content[0].input).toEqual({ q: "hi" });
    }
  });
});

describe("openai-to-anthropic streaming", () => {
  test("converts simple text stream", () => {
    const converter = new OpenAIToAnthropicStream();
    const allEvents: string[] = [];

    // 第一个 chunk: 角色开始
    const chunk1: OpenAIStreamChunk = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "sonnet",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    };
    allEvents.push(...converter.feed(chunk1).map((e) => formatAnthropicSSE([e])));

    // 文本增量
    const chunk2: OpenAIStreamChunk = {
      ...chunk1,
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    };
    allEvents.push(...converter.feed(chunk2).map((e) => formatAnthropicSSE([e])));

    const chunk3: OpenAIStreamChunk = {
      ...chunk1,
      choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
    };
    allEvents.push(...converter.feed(chunk3).map((e) => formatAnthropicSSE([e])));

    // 结束
    const chunk4: OpenAIStreamChunk = {
      ...chunk1,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    allEvents.push(...converter.feed(chunk4).map((e) => formatAnthropicSSE([e])));

    allEvents.push(...converter.end().map((e) => formatAnthropicSSE([e])));

    const full = allEvents.join("");
    expect(full).toContain("event: message_start");
    expect(full).toContain("event: content_block_start");
    expect(full).toContain("event: content_block_delta");
    expect(full).toContain('"text":"Hello"');
    expect(full).toContain('"text":" world"');
    expect(full).toContain("event: message_stop");
  });
});
