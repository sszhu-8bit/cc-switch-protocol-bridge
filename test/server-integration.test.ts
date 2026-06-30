// P2-2: server 层集成测试（用 fastify app.inject()）
//
// 之前所有测试都是单元测试 / mock 上游。集成测试用 fastify.inject() 直接
// 通过内存中的 HTTP 请求打 server（不绑真实端口，毫秒级运行）。

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.ts";
import { assertValidConfig } from "../src/config.ts";
import {
  _resetForTests,
  openDatabase,
  saveProvider,
  setCurrentProvider,
  setSetting,
} from "../src/store/db.ts";
import type { AppConfig } from "../src/types.ts";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let counter = 0;
const TEST_DIR_HOLDER: { path: string; db: string } = { path: "", db: "" };

async function setupServer(
  providerConfig: Parameters<typeof saveProvider>[0]
): Promise<{ app: FastifyInstance; config: AppConfig }> {
  const dir = join(tmpdir(), `cc-switch-int-${counter++}`);
  TEST_DIR_HOLDER.path = dir;
  TEST_DIR_HOLDER.db = join(dir, "cc-switch.db");
  process.env.CC_SWITCH_MASTER_KEY = TEST_KEY;
  process.env.CC_SWITCH_DB = TEST_DIR_HOLDER.db;
  _resetForTests();

  openDatabase(TEST_DIR_HOLDER.db);
  await saveProvider(providerConfig);
  setCurrentProvider(providerConfig.id);
  setSetting("listen_address", "127.0.0.1");
  setSetting("listen_port", "17821");

  const providers = (await import("../src/store/db.ts")).listProviders();
  const config: AppConfig = {
    listen_address: "127.0.0.1",
    listen_port: 17821,
    current_provider: providerConfig.id,
    providers: await providers,
  };

  const app = await buildServer(config);
  return { app, config };
}

afterEach(() => {
  _resetForTests();
  delete process.env.CC_SWITCH_MASTER_KEY;
  delete process.env.CC_SWITCH_DB;
});

describe("GET /health", () => {
  test("无 provider：返回 200 + status=ok + current_provider=null", async () => {
    // 不写任何 provider
    process.env.CC_SWITCH_DB = join(tmpdir(), `cc-switch-int-${counter++}`, "cc-switch.db");
    _resetForTests();
    openDatabase(process.env.CC_SWITCH_DB!);
    setSetting("listen_address", "127.0.0.1");
    setSetting("listen_port", "17821");

    const config: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [],
    };
    const app = await buildServer(config);

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.current_provider).toBeNull();
  });

  test("有 provider：current_provider 正确", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-test",
      models: { sonnet: "deepseek-chat" },
    });

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.current_provider).toBe("deepseek");
  });
});

describe("GET /stats", () => {
  test("无请求时：全部 0", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-test",
      models: {},
    });

    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totals.requests).toBe(0);
    expect(body.current_provider).toBe("deepseek");
  });

  test("记录 1 个成功请求：totals.requests=1", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "http://127.0.0.1:9999", // 不存在，会 502
      api_key: "sk-test",
      models: {},
    });

    // 1 个请求
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "sonnet", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    });

    const res = await app.inject({ method: "GET", url: "/stats" });
    const body = JSON.parse(res.body);
    expect(body.totals.requests).toBe(1);
    expect(body.by_provider.deepseek.requests).toBe(1);
  });

  test("记录混合成功/失败：状态码分布正确", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "http://127.0.0.1:9999",
      api_key: "sk-test",
      models: {},
    });

    // 3 个有效请求（都失败因为上游不存在）
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: { model: "sonnet", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      });
    }

    // 1 个无效请求
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { bad: "data" },
    });

    const res = await app.inject({ method: "GET", url: "/stats" });
    const body = JSON.parse(res.body);
    expect(body.totals.requests).toBe(4);
    expect(body.by_status_code["502"]).toBe(3);
    expect(body.by_status_code["400"]).toBe(1);
  });
});

describe("GET /v1/models", () => {
  test("有 provider：返回 3 个角色模型", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://x",
      api_key: "k",
      models: { sonnet: "deepseek-chat", opus: "deepseek-reasoner", haiku: "deepseek-chat" },
    });

    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(3);
    expect(body.data.map((m: { id: string }) => m.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-chat",
    ]);
  });

  test("无 provider：返回空数组", async () => {
    const dir = join(tmpdir(), `cc-switch-int-${counter++}`);
    process.env.CC_SWITCH_DB = join(dir, "cc-switch.db");
    process.env.CC_SWITCH_MASTER_KEY = TEST_KEY;
    _resetForTests();
    openDatabase(process.env.CC_SWITCH_DB!);
    setSetting("listen_address", "127.0.0.1");
    setSetting("listen_port", "17821");

    const config: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [],
    };
    const app = await buildServer(config);

    const res = await app.inject({ method: "GET", url: "/v1/models" });
    const body = JSON.parse(res.body);
    expect(body.data).toEqual([]);
  });
});

describe("POST /v1/messages", () => {
  test("无 provider：返回 503 service_unavailable", async () => {
    const dir = join(tmpdir(), `cc-switch-int-${counter++}`);
    process.env.CC_SWITCH_DB = join(dir, "cc-switch.db");
    process.env.CC_SWITCH_MASTER_KEY = TEST_KEY;
    _resetForTests();
    openDatabase(process.env.CC_SWITCH_DB!);
    setSetting("listen_address", "127.0.0.1");
    setSetting("listen_port", "17821");

    const config: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [],
    };
    const app = await buildServer(config);

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "sonnet", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("service_unavailable");
  });

  test("无 body：返回 400 invalid_request_error", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://x",
      api_key: "k",
      models: {},
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { bad: "data" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("缺少 messages 字段：返回 400", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://x",
      api_key: "k",
      models: {},
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "sonnet", max_tokens: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  test("有效请求 + 上游不可达：返回 502 + Anthropic 错误格式", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "http://127.0.0.1:9999", // 不存在
      api_key: "sk-test",
      models: { sonnet: "deepseek-chat" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "sonnet", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("upstream_unreachable");
  });

  test("Content-Type 头正确（Anthropic 协议）", async () => {
    const { app } = await setupServer({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "http://127.0.0.1:9999",
      api_key: "k",
      models: {},
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "sonnet", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("buildServer config 校验", () => {
  test("current_provider 引用不存在：startServer 抛错（这里仅校验逻辑）", () => {
    const bad: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "ghost",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          vendor: "openai-compatible",
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
      ],
    };
    expect(() => assertValidConfig(bad)).toThrow(/ghost/);
  });

  test("current_provider 在 providers 中：通过", () => {
    const ok: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "deepseek",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          vendor: "openai-compatible",
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
      ],
    };
    expect(() => assertValidConfig(ok)).not.toThrow();
  });

  test("listen_port 超过 65535：抛错", () => {
    const bad: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 99999,
      current_provider: "",
      providers: [],
    };
    expect(() => assertValidConfig(bad)).toThrow();
  });
});
