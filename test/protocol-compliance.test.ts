// 真实模拟：模拟 Anthropic SDK 解析 SSE 流的过程
// 验证：每个事件都符合 Anthropic 协议

import { describe, expect, test } from "bun:test";
import { OpenAIToAnthropicStream, formatAnthropicSSE } from "../src/converter/streaming.ts";
import type { OpenAIStreamChunk } from "../src/types.ts";

function makeChunk(overrides: Partial<OpenAIStreamChunk> = {}): OpenAIStreamChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1234567890,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    ...overrides,
  };
}

/**
 * 验证序列：每个 content_block_start 必须有 content_block_stop 紧随其后
 * 每个 content_block_delta 必须在对应 start 之后、stop 之前
 * message_start 必须在 message_stop 之前
 */
function validateAnthropicSequence(events: Array<{ type: string; data: unknown }>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  let i = 0;

  // 必须以 message_start 开头
  if (events[0]?.type !== "message_start") {
    errors.push(`Expected message_start first, got ${events[0]?.type}`);
  }

  // 必须以 message_stop 结尾
  if (events[events.length - 1]?.type !== "message_stop") {
    errors.push(`Expected message_stop last, got ${events[events.length - 1]?.type}`);
  }

  // 跟踪每个 content block 的状态
  const openBlocks = new Map<number, string>(); // index -> type

  for (i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    const data = e.data as Record<string, unknown>;

    switch (e.type) {
      case "content_block_start": {
        const block = data.content_block as Record<string, unknown>;
        const idx = data.index as number;
        if (openBlocks.has(idx)) {
          errors.push(`Block ${idx} already open at start of new start event`);
        }
        // 关键验证：tool_use 必须有非空 id 和 name
        if (block.type === "tool_use") {
          if (!block.id || (block.id as string).length === 0) {
            errors.push(`tool_use block ${idx} has empty id`);
          }
          if (!block.name || (block.name as string).length === 0) {
            errors.push(`tool_use block ${idx} has empty name`);
          }
        }
        openBlocks.set(idx, block.type as string);
        break;
      }
      case "content_block_delta": {
        const idx = data.index as number;
        if (!openBlocks.has(idx)) {
          errors.push(`Delta for block ${idx} but block not open`);
        }
        break;
      }
      case "content_block_stop": {
        const idx = data.index as number;
        if (!openBlocks.has(idx)) {
          errors.push(`Stop for block ${idx} but block not open`);
        }
        openBlocks.delete(idx);
        break;
      }
      case "message_delta":
      case "message_stop":
        // 不需要校验具体内容
        break;
    }
  }

  // 所有打开的 block 必须被 stop
  for (const [idx, _type] of openBlocks) {
    errors.push(`Block ${idx} never stopped`);
  }

  return { valid: errors.length === 0, errors };
}

function feedToEvents(
  chunks: Array<OpenAIStreamChunk | null>
): Array<{ type: string; data: unknown }> {
  const converter = new OpenAIToAnthropicStream();
  const allSSE: string[] = [];

  for (const chunk of chunks) {
    const events = converter.feed(chunk);
    if (events.length > 0) allSSE.push(formatAnthropicSSE(events));
  }
  const endEvents = converter.end();
  if (endEvents.length > 0) allSSE.push(formatAnthropicSSE(endEvents));

  // parseSSE
  const full = allSSE.join("");
  const out: Array<{ type: string; data: unknown }> = [];
  const blocks = full.split("\n\n").filter(Boolean);
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
        out.push({ type, data: JSON.parse(data) });
      } catch {
        out.push({ type, data });
      }
    }
  }
  return out;
}

describe("P1-2: Anthropic 协议合规验证", () => {
  test("DeepSeek 风格（id 先、name 后）：序列合法", () => {
    const events = feedToEvents([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_d1" }] },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "search", arguments: '{"q":"hi"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const v = validateAnthropicSequence(events);
    if (!v.valid) {
      console.error("Validation errors:", v.errors);
    }
    expect(v.valid).toBe(true);
  });

  test("OpenAI 风格（id+name 同 chunk）：序列合法", () => {
    const events = feedToEvents([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_o1",
                  function: { name: "fn", arguments: '{"x":1}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const v = validateAnthropicSequence(events);
    expect(v.valid).toBe(true);
  });

  test("两个 tool_call 并行（DeepSeek 风格）：序列合法", () => {
    const events = feedToEvents([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c1" },
                { index: 1, id: "c2" },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { name: "f1", arguments: "{}" } },
                { index: 1, function: { name: "f2", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const v = validateAnthropicSequence(events);
    expect(v.valid).toBe(true);
  });

  test("文本 + 工具混合：序列合法", () => {
    const events = feedToEvents([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: "Hello. " },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  function: { name: "search", arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const v = validateAnthropicSequence(events);
    expect(v.valid).toBe(true);
  });
});
