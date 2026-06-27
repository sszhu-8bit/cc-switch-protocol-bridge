// E2E: 模拟 `cc-switch provider use` 流程
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, getProvider } from "../src/config.ts";
import { buildClaudeSettings, writeClaudeSettings } from "../src/claude-config.ts";
import type { AppConfig } from "../src/types.ts";

const TEST_DIR = join(tmpdir(), `cc-switch-e2e-${Date.now()}`);
const TEST_CONFIG = join(TEST_DIR, "cc-switch.yaml");
const TEST_CLAUDE = join(TEST_DIR, ".claude/settings.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, ".claude"), { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("provider use workflow", () => {
  test("switching between providers updates both files correctly", () => {
    // 初始：两个 provider 配置
    const config: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "deepseek",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          vendor: "openai-compatible",
          base_url: "https://api.deepseek.com",
          api_key: "sk-deepseek",
          models: { sonnet: "deepseek-chat", opus: "deepseek-chat", haiku: "deepseek-chat" },
        },
        {
          id: "kimi",
          name: "Kimi",
          vendor: "openai-compatible",
          base_url: "https://api.moonshot.cn",
          api_key: "sk-kimi",
          models: { sonnet: "kimi-k2-0711-preview", opus: "kimi-k2-0711-preview", haiku: "kimi-k2-0711-preview" },
        },
      ],
    };
    saveConfig(config, TEST_CONFIG);

    // 用户切到 kimi
    const c1 = loadConfig(TEST_CONFIG);
    c1.current_provider = "kimi";
    saveConfig(c1, TEST_CONFIG);
    const kimi = getProvider(c1, "kimi")!;
    writeClaudeSettings(
      TEST_CLAUDE,
      buildClaudeSettings(kimi, `http://${c1.listen_address}:${c1.listen_port}`)
    );

    // 验证
    const claudeEnv = JSON.parse(readFileSync(TEST_CLAUDE, "utf-8")).env;
    expect(claudeEnv.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
    expect(claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("sonnet");

    // 验证 config 切到了 kimi
    const c2 = loadConfig(TEST_CONFIG);
    expect(c2.current_provider).toBe("kimi");

    // 切回 deepseek
    const c3 = loadConfig(TEST_CONFIG);
    c3.current_provider = "deepseek";
    saveConfig(c3, TEST_CONFIG);
    const deepseek = getProvider(c3, "deepseek")!;
    writeClaudeSettings(
      TEST_CLAUDE,
      buildClaudeSettings(deepseek, `http://${c3.listen_address}:${c3.listen_port}`)
    );

    // 验证 config 切到了 deepseek
    const c4 = loadConfig(TEST_CONFIG);
    expect(c4.current_provider).toBe("deepseek");
  });

  test("preserves user's mcpServers and permissions across provider switches", () => {
    // 用户先有自定义 settings
    const userSettings = {
      mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
      permissions: { allow: ["Bash(npm install:*)"] },
    };
    writeFileSync(TEST_CLAUDE, JSON.stringify(userSettings));

    // 切到 deepseek
    const config: AppConfig = {
      listen_address: "127.0.0.1",
      listen_port: 17821,
      current_provider: "",
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          vendor: "openai-compatible",
          base_url: "https://api.deepseek.com",
          api_key: "sk-test",
          models: { sonnet: "deepseek-chat" },
        },
      ],
    };
    saveConfig(config, TEST_CONFIG);

    const c = loadConfig(TEST_CONFIG);
    c.current_provider = "deepseek";
    saveConfig(c, TEST_CONFIG);
    const provider = getProvider(c, "deepseek")!;
    writeClaudeSettings(TEST_CLAUDE, buildClaudeSettings(provider, "http://127.0.0.1:17821"));

    // 用户的 mcpServers 和 permissions 必须保留
    const finalSettings = JSON.parse(readFileSync(TEST_CLAUDE, "utf-8"));
    expect(finalSettings.mcpServers).toEqual(userSettings.mcpServers);
    expect(finalSettings.permissions).toEqual(userSettings.permissions);
    // env 字段被正确覆盖
    expect(finalSettings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
  });
});