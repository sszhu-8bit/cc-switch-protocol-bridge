// ~/.claude/settings.json 管理器测试
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildClaudeSettings, writeClaudeSettings, readClaudeEnv } from "../src/claude-config.ts";
import type { ProviderConfig } from "../src/types.ts";

const TEST_DIR = join(tmpdir(), `cc-switch-test-${Date.now()}`);
const TEST_SETTINGS = join(TEST_DIR, "settings.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

const sampleProvider: ProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  vendor: "openai-compatible",
  base_url: "https://api.deepseek.com",
  api_key: "sk-test",
  models: { sonnet: "deepseek-chat", opus: "deepseek-chat", haiku: "deepseek-chat" },
};

describe("buildClaudeSettings", () => {
  test("returns settings pointing to local proxy", () => {
    const settings = buildClaudeSettings(sampleProvider, "http://127.0.0.1:17821");
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("cc-switch-managed");
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("sonnet");
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("haiku");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus");
  });
});

describe("writeClaudeSettings", () => {
  test("creates new file when none exists", () => {
    const settings = buildClaudeSettings(sampleProvider, "http://127.0.0.1:17821");
    writeClaudeSettings(TEST_SETTINGS, settings);
    expect(existsSync(TEST_SETTINGS)).toBe(true);
    const parsed = JSON.parse(readFileSync(TEST_SETTINGS, "utf-8"));
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
  });

  test("preserves unrelated top-level fields", () => {
    // 模拟用户已有的 settings.json（含 mcpServers / permissions）
    const existing = {
      mcpServers: { foo: { command: "bar" } },
      permissions: { allow: ["Bash"] },
      env: { OTHER_VAR: "keep-me" },
    };
    writeFileSync(TEST_SETTINGS, JSON.stringify(existing));

    const settings = buildClaudeSettings(sampleProvider, "http://127.0.0.1:17821");
    writeClaudeSettings(TEST_SETTINGS, settings);

    const parsed = JSON.parse(readFileSync(TEST_SETTINGS, "utf-8"));
    expect(parsed.mcpServers).toEqual({ foo: { command: "bar" } });
    expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    // ANTHROPIC_* 字段被覆盖
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
    // 自定义 env 字段保留
    expect(parsed.env.OTHER_VAR).toBe("keep-me");
  });

  test("overwrites old ANTHROPIC_* env vars", () => {
    const existing = {
      env: {
        ANTHROPIC_BASE_URL: "http://old-proxy:9999",
        ANTHROPIC_AUTH_TOKEN: "old-token",
        ANTHROPIC_MODEL: "old-model",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "old-sonnet",
      },
    };
    writeFileSync(TEST_SETTINGS, JSON.stringify(existing));

    const settings = buildClaudeSettings(sampleProvider, "http://127.0.0.1:17821");
    writeClaudeSettings(TEST_SETTINGS, settings);

    const parsed = JSON.parse(readFileSync(TEST_SETTINGS, "utf-8"));
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("cc-switch-managed");
    expect(parsed.env.ANTHROPIC_MODEL).toBe("sonnet");
    expect(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("sonnet");
    // 旧的字段值不再存在
    expect(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toBe("old-sonnet");
  });
});

describe("readClaudeEnv", () => {
  test("returns env when present", () => {
    const existing = { env: { FOO: "bar" } };
    writeFileSync(TEST_SETTINGS, JSON.stringify(existing));
    const env = readClaudeEnv(TEST_SETTINGS);
    expect(env).toEqual({ FOO: "bar" });
  });

  test("returns null when file missing", () => {
    const env = readClaudeSettingsOrNull("/nonexistent/path");
    expect(env).toBeNull();
  });

  test("returns null when env field missing", () => {
    writeFileSync(TEST_SETTINGS, JSON.stringify({ other: "field" }));
    const env = readClaudeEnv(TEST_SETTINGS);
    expect(env).toBeNull();
  });
});

function readClaudeSettingsOrNull(path: string) {
  return readClaudeEnv(path);
}