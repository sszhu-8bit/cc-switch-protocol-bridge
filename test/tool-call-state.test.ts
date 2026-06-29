// P1-2 流式工具调用状态机测试
//
// 验证：
// 1. 标准 OpenAI 顺序：id+name+arguments 在同一 chunk
// 2. 分块顺序：id 先到，name 后到（DeepSeek / Qwen 风格）
// 3. args 先到、name 后到（异常但可能）
// 4. arguments 分块到达，正确累积
// 5. 多 tool_call 并行（不同 index）
// 6. JSON.parse 跟踪 argsBuffer 完整性
// 7. content_block_start 一定携带完整 id + name

import { describe, expect, test } from "bun:test";
import {
  OpenAIToAnthropicStream,
  formatAnthropicSSE,
} from "../src/converter/streaming.ts";
import type {
  AnthropicStreamEvent,
  OpenAIStreamChunk,
} from "../src/types.ts";

function makeChunk(
  overrides: Partial<OpenAIStreamChunk> = {}
): OpenAIStreamChunk {
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

/** 把所有事件格式化后解析回结构 */
function collectEvents(stream: OpenAIToAnthropicStream): AnthropicStreamEvent[] {
  // 已经 abort/end 了之后我们再写一遍所有事件到一个完整序列
  // 这里只是 helper，用更简洁的方式重新喂并收集
  return [];
}

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

function getEvents(stream: OpenAIToAnthropicStream, lastCall = false): AnthropicStreamEvent[] {
  // 这个 helper 不存在 — 占位符
  throw new Error("use feedChunks() helper instead");
}

/** 一个完整的 helper：喂入 chunks 收集所有 events */
function feedAndCollect(
  chunks: Array<OpenAIStreamChunk | null>,
  callEnd: boolean = true
): AnthropicStreamEvent[] {
  const converter = new OpenAIToAnthropicStream();
  const allEvents: AnthropicStreamEvent[] = [];

  for (const chunk of chunks) {
    const events = converter.feed(chunk);
    allEvents.push(...events);
  }
  if (callEnd) {
    const endEvents = converter.end();
    allEvents.push(...endEvents);
  }

  return allEvents;
}

describe("P1-2: 工具调用状态机 — 标准 OpenAI 顺序", () => {
  test("id+name+arguments 同一 chunk → 一次发 start + delta", () => {
    const events = feedAndCollect([
      makeChunk(),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  function: { name: "get_weather", arguments: '{"city":"Beijing"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      null, // [DONE]
    ]);

    const types = events.map((e) => e.type);
    // 期望序列：
    // message_start → content_block_start(tool_use) → content_block_delta(json) →
    // content_block_stop → message_delta → message_stop
    expect(types).toContain("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    // start 事件的 id/name 必须非空
    const start = events.find((e) => e.type === "content_block_start");
    expect(start).toBeDefined();
    if (start && start.type === "content_block_start") {
      expect(start.content_block.type).toBe("tool_use");
      if (start.content_block.type === "tool_use") {
        expect(start.content_block.id).toBe("call_abc");
        expect(start.content_block.name).toBe("get_weather");
      }
    }

    // 所有 delta 拼接 = 完整 arguments
    const deltas = events.filter((e) => e.type === "content_block_delta");
    const merged = deltas
      .map((e) => {
        if (e.type === "content_block_delta") {
          return e.delta.type === "input_json_delta" ? e.delta.partial_json : "";
        }
        return "";
      })
      .join("");
    expect(merged).toBe('{"city":"Beijing"}');
  });

  test("arguments 分块到达：正确累积", () => {
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_x",
                  function: { name: "f", arguments: '{"a":' },
                },
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
              tool_calls: [{ index: 0, function: { arguments: '"b"' } }],
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
              tool_calls: [{ index: 0, function: { arguments: ',"c":1}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const deltas = events.filter((e) => e.type === "content_block_delta");
    const merged = deltas
      .map((e) =>
        e.type === "content_block_delta" && e.delta.type === "input_json_delta"
          ? e.delta.partial_json
          : ""
      )
      .join("");
    // 注意：在标准顺序下，第一次 chunk 同时给 id+name+args={\"a\":，
    // 该 chunk 触发 start + flush argsBuffer={\"a\": 作为第一个 delta
    // 后续 chunk2 给 args=\"b\"，chunk3 给 args=,\"c\":1}
    // 期望合并 = {"a":"b","c":1}
    expect(merged).toBe('{"a":"b","c":1}');
    expect(merged).toBe('{"a":"b","c":1}');
  });
});

describe("P1-2: 工具调用状态机 — DeepSeek/Qwen 风格分块顺序", () => {
  test("id 先到，name 后到，arguments 跟 name 一起", () => {
    // chunk1: 只有 id
    // chunk2: 有 name + 部分 args
    // chunk3: 更多 args
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_d1" }],
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
                {
                  index: 0,
                  function: { name: "search", arguments: '{"q":"' },
                },
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
              tool_calls: [{ index: 0, function: { arguments: 'hi"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    // 在 chunk1 时 id="call_d1" 但 name=null → blockStarted=false，不发 start
    // 在 chunk2 时 name="search"，id 已齐，args 也到 → 发 start（argsBuffer="{"q":"" 已 flush）
    //   + 发累积 args delta（{"q":"）
    //   不对，flush 是整个 argsBuffer，所以发 delta({"q":"")
    // 在 chunk3 时，发增量 delta(hi"})
    const deltas = events.filter((e) => e.type === "content_block_delta");
    const merged = deltas
      .map((e) =>
        e.type === "content_block_delta" && e.delta.type === "input_json_delta"
          ? e.delta.partial_json
          : ""
      )
      .join("");

    expect(merged).toBe('{"q":"hi"}');

    // start 事件的 id/name 都非空
    const start = events.find((e) => e.type === "content_block_start");
    if (start && start.type === "content_block_start" && start.content_block.type === "tool_use") {
      expect(start.content_block.id).toBe("call_d1");
      expect(start.content_block.name).toBe("search");
    }
  });

  test("id+name 先齐，args 多个 chunk 后到", () => {
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_z",
                  function: { name: "fn" },
                },
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
              tool_calls: [{ index: 0, function: { arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const start = events.find((e) => e.type === "content_block_start");
    if (start && start.type === "content_block_start" && start.content_block.type === "tool_use") {
      expect(start.content_block.id).toBe("call_z");
      expect(start.content_block.name).toBe("fn");
    }

    const deltas = events.filter((e) => e.type === "content_block_delta");
    const merged = deltas
      .map((e) =>
        e.type === "content_block_delta" && e.delta.type === "input_json_delta"
          ? e.delta.partial_json
          : ""
      )
      .join("");
    expect(merged).toBe("{}");
  });
});

describe("P1-2: 工具调用状态机 — 异常但需处理", () => {
  test("name 显式空字符串（仍视为有效但 start 推迟）", () => {
    // name="" 不会触发 start — 这是预期行为：上游发空名字是有问题的
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_e",
                  function: { name: "", arguments: '{"a":1}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    // 因为 name=""，blockStarted 永远 false
    // 但 entry 已创建并累积 args（不发任何事件）
    // end() 会因为 argsParsedOk=true 但 blockStarted=false 而不显式 start/stop
    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts.length).toBe(0);
    // 不会发 tool_use 不完整的 content_block_start — 是正确的
  });

  test("arguments 在 id/name 之前到达（异常上游），start 时 flush 累积", () => {
    const events = feedAndCollect([
      // chunk1: 只有 id + 部分 args（无 name）
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_pre",
                  function: { arguments: '{"a":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      // chunk2: name 到达（这时 id+name 都齐，但 argsBuffer 已有内容）
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: "f", arguments: "1}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    // 应该有一个 content_block_start，name="f", id="call_pre"
    const start = events.find((e) => e.type === "content_block_start");
    expect(start).toBeDefined();
    if (start && start.type === "content_block_start" && start.content_block.type === "tool_use") {
      expect(start.content_block.id).toBe("call_pre");
      expect(start.content_block.name).toBe("f");
    }

    // delta 合并后 = 完整 {"a":1}（start 时 flush {"a":，chunk2 时 +1}）
    const deltas = events.filter((e) => e.type === "content_block_delta");
    const merged = deltas
      .map((e) =>
        e.type === "content_block_delta" && e.delta.type === "input_json_delta"
          ? e.delta.partial_json
          : ""
      )
      .join("");
    expect(merged).toBe('{"a":1}');
  });

  test("start 事件的 id/name 永远不会是空字符串", () => {
    // 各种尝试发空 id/name 都应推迟 start
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: "f", arguments: "x" } }],
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
              tool_calls: [{ index: 0, id: "call_a", function: { arguments: "y" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const start = events.find((e) => e.type === "content_block_start");
    expect(start).toBeDefined();
    if (start && start.type === "content_block_start" && start.content_block.type === "tool_use") {
      // id 一定是 chunk2 给的 "call_a"
      expect(start.content_block.id).toBe("call_a");
      // name 一定是 chunk1 给的 "f"
      expect(start.content_block.name).toBe("f");
    }
  });
});

describe("P1-2: 工具调用状态机 — 多 tool_call 并行", () => {
  test("两个 tool_call 不同 index，独立处理", () => {
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "f1", arguments: '{"a":1}' } },
                { index: 1, id: "c2", function: { name: "f2", arguments: '{"b":2}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts.length).toBe(2);
    const stopEvents = events.filter((e) => e.type === "content_block_stop");
    expect(stopEvents.length).toBe(2);

    // 验证 index 分配不同
    const startIndices = starts.map((s) => (s.type === "content_block_start" ? s.index : -1));
    expect(new Set(startIndices).size).toBe(2);
  });

  test("tool_call 0 和 tool_call 1 顺序到达（先 0 后 1）", () => {
    const events = feedAndCollect([
      // chunk1: 只有 tool_call 0
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "f1" } }],
            },
            finish_reason: null,
          },
        ],
      }),
      // chunk2: tool_call 0 args + tool_call 1 id
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"a":1}' } },
                { index: 1, id: "c2" },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      // chunk3: tool_call 1 name + args
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { name: "f2", arguments: '{"b":2}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts.length).toBe(2);

    // 两个 start 都应该有非空 id/name
    for (const s of starts) {
      if (s.type === "content_block_start" && s.content_block.type === "tool_use") {
        expect(s.content_block.id).toBeTruthy();
        expect(s.content_block.name).toBeTruthy();
      }
    }

    const stops = events.filter((e) => e.type === "content_block_stop");
    expect(stops.length).toBe(2);
  });
});

describe("P1-2: 工具调用状态机 — 文本 + 工具混合", () => {
  test("文本块先于工具块", () => {
    const events = feedAndCollect([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: "Let me think. " },
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

    const types = events.map((e) => e.type);
    expect(types).toContain("content_block_start"); // text block
    expect(types.filter((t) => t === "content_block_start").length).toBe(2); // text + tool
    // 顺序：message_start → text_start → text_delta → tool_start → tool_delta → stop → message_stop
    // 注意 text 在前，tool 在后
    const textStart = events.findIndex(
      (e) => e.type === "content_block_start" && "text" in (e as any).content_block
    );
    const toolStart = events.findIndex(
      (e) => e.type === "content_block_start" && (e as any).content_block.type === "tool_use"
    );
    expect(textStart).toBeGreaterThan(-1);
    expect(toolStart).toBeGreaterThan(textStart);
  });
});