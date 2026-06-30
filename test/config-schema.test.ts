// P2-1: zod 配置校验测试

import { describe, expect, test } from "bun:test";
import {
  AppConfigSchema,
  formatZodError,
  ProviderConfigSchema,
  validateAppConfig,
  validateCurrentProvider,
  validateForStartup,
  validateProvider,
} from "../src/config-schema.ts";

describe("ProviderConfigSchema", () => {
  test("合法 provider 通过", () => {
    const result = ProviderConfigSchema.safeParse({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-test",
      models: { sonnet: "deepseek-chat" },
    });
    expect(result.success).toBe(true);
  });

  test("vendor 非法值", () => {
    const result = ProviderConfigSchema.safeParse({
      id: "p",
      name: "P",
      vendor: "unknown",
      base_url: "https://x.com",
      api_key: "k",
      models: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("vendor");
    }
  });

  test("base_url 不是合法 URL", () => {
    const result = ProviderConfigSchema.safeParse({
      id: "p",
      name: "P",
      vendor: "openai-compatible",
      base_url: "not-a-url",
      api_key: "k",
      models: {},
    });
    expect(result.success).toBe(false);
  });

  test("id 含非法字符", () => {
    const result = ProviderConfigSchema.safeParse({
      id: "has space",
      name: "P",
      vendor: "openai-compatible",
      base_url: "https://x.com",
      api_key: "k",
      models: {},
    });
    expect(result.success).toBe(false);
  });

  test("id 为空", () => {
    const result = ProviderConfigSchema.safeParse({
      id: "",
      name: "P",
      vendor: "openai-compatible",
      base_url: "https://x.com",
      api_key: "k",
      models: {},
    });
    expect(result.success).toBe(false);
  });

  test("api_key 为空", () => {
    const result = ProviderConfigSchema.safeParse({
      id: "p",
      name: "P",
      vendor: "openai-compatible",
      base_url: "https://x.com",
      api_key: "",
      models: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("AppConfigSchema", () => {
  test("合法 AppConfig", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "deepseek",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          vendor: "openai-compatible",
          base_url: "https://api.deepseek.com",
          api_key: "sk-test",
          models: {},
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("listen_port 超过 65535", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "127.0.0.1",
      listen_port: 70000,
      current_provider: "",
      providers: [],
    });
    expect(result.success).toBe(false);
  });

  test("listen_port 为 0", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "127.0.0.1",
      listen_port: 0,
      current_provider: "",
      providers: [],
    });
    expect(result.success).toBe(false);
  });

  test("listen_address 是非法值", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "not a hostname!@#",
      listen_port: 17821,
      current_provider: "",
      providers: [],
    });
    expect(result.success).toBe(false);
  });

  test("providers 不是数组", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: "not-array",
    });
    expect(result.success).toBe(false);
  });
});

describe("validateCurrentProvider", () => {
  test("current_provider 为空（未设置）：通过", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [],
    };
    expect(validateCurrentProvider(config).ok).toBe(true);
  });

  test("current_provider 在 providers 中：通过", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "deepseek",
      providers: [
        {
          id: "deepseek",
          name: "D",
          vendor: "openai-compatible" as const,
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
      ],
    };
    expect(validateCurrentProvider(config).ok).toBe(true);
  });

  test("current_provider 不在 providers 中：拒绝", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "missing",
      providers: [
        {
          id: "deepseek",
          name: "D",
          vendor: "openai-compatible" as const,
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
      ],
    };
    const result = validateCurrentProvider(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing");
      expect(result.error).toContain("deepseek");
    }
  });
});

describe("validateForStartup（端到端）", () => {
  test("合法配置：通过", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "deepseek",
      providers: [
        {
          id: "deepseek",
          name: "D",
          vendor: "openai-compatible" as const,
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
      ],
    };
    expect(validateForStartup(config).ok).toBe(true);
  });

  test("current_provider 设置但 providers 为空：拒绝", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "deepseek",
      providers: [],
    };
    const result = validateForStartup(config);
    expect(result.ok).toBe(false);
  });

  test("current_provider 引用不存在：拒绝", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "ghost",
      providers: [
        {
          id: "deepseek",
          name: "D",
          vendor: "openai-compatible" as const,
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
      ],
    };
    expect(validateForStartup(config).ok).toBe(false);
  });

  test("listen_port 非法：拒绝", () => {
    const config = {
      listen_address: "127.0.0.1",
      listen_port: 99999,
      current_provider: "",
      providers: [],
    };
    expect(validateForStartup(config).ok).toBe(false);
  });
});

describe("formatZodError", () => {
  test("多个错误全部展示", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "",
      listen_port: 99999,
      current_provider: "x",
      providers: [{ id: "", name: "", vendor: "x", base_url: "x", api_key: "", models: {} }],
    });
    if (!result.success) {
      const formatted = formatZodError(result.error);
      // 至少含 3 个独立错误
      const lines = formatted.split("\n").filter((l) => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(3);
    } else {
      throw new Error("expected validation to fail");
    }
  });

  test("路径正确嵌套", () => {
    const result = AppConfigSchema.safeParse({
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [
        {
          id: "ok",
          name: "D",
          vendor: "openai-compatible",
          base_url: "https://x",
          api_key: "k",
          models: {},
        },
        {
          id: "bad",
          name: "D",
          vendor: "openai-compatible",
          base_url: "not-url",
          api_key: "k",
          models: {},
        },
      ],
    });
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain("providers.1");
    }
  });
});

describe("validateProvider（便利函数）", () => {
  test("返回 ok=true on 合法", () => {
    const r = validateProvider({
      id: "p",
      name: "P",
      vendor: "openai-compatible",
      base_url: "https://x",
      api_key: "k",
      models: {},
    });
    expect(r.ok).toBe(true);
  });

  test("返回 ok=false on 非法", () => {
    const r = validateProvider({ id: "p" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeTruthy();
    }
  });
});

describe("validateAppConfig（便利函数）", () => {
  test("返回 ok=true on 合法", () => {
    const r = validateAppConfig({
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [],
    });
    expect(r.ok).toBe(true);
  });
});
