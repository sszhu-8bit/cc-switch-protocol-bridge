// E2E: 模拟 `cc-switch provider use` 流程（基于新的 SQLite 存储）
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetForTests,
  getDb,
  setCurrentProvider,
  setSetting,
  listProviders,
  saveProvider,
  openDatabase,
} from "../src/store/db.ts";
import { buildClaudeSettings, writeClaudeSettings } from "../src/claude-config.ts";

// 测试用固定 master key（32 字节 hex）
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  // 每个测试用全新目录
  const dir = join(tmpdir(), `cc-switch-e2e-${counter++}`);
  TEST_DIR_HOLDER.path = dir;
  TEST_DIR_HOLDER.db = join(dir, "cc-switch.db");
  TEST_DIR_HOLDER.claude = join(dir, "claude-settings.json");
  mkdirSync(dir, { recursive: true });
  process.env.CC_SWITCH_MASTER_KEY = TEST_KEY;
  process.env.CC_SWITCH_DB = TEST_DIR_HOLDER.db;
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
  delete process.env.CC_SWITCH_MASTER_KEY;
  delete process.env.CC_SWITCH_DB;
  try {
    if (existsSync(TEST_DIR_HOLDER.path)) {
      rmSync(TEST_DIR_HOLDER.path, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

let counter = 0;
const TEST_DIR_HOLDER: { path: string; db: string; claude: string } = {
  path: "",
  db: "",
  claude: "",
};

afterEach(() => {
  _resetForTests();
  delete process.env.CC_SWITCH_MASTER_KEY;
  delete process.env.CC_SWITCH_DB;
  try {
    if (existsSync(TEST_DIR_HOLDER.path)) {
      rmSync(TEST_DIR_HOLDER.path, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

async function setupProviders() {
  await saveProvider({
    id: "deepseek",
    name: "DeepSeek",
    vendor: "openai-compatible",
    base_url: "https://api.deepseek.com",
    api_key: "sk-deepseek-original",
    models: { sonnet: "deepseek-chat", opus: "deepseek-chat", haiku: "deepseek-chat" },
  });
  await saveProvider({
    id: "kimi",
    name: "Kimi",
    vendor: "openai-compatible",
    base_url: "https://api.moonshot.cn",
    api_key: "sk-kimi-original",
    models: {
      sonnet: "kimi-k2-0711-preview",
      opus: "kimi-k2-0711-preview",
      haiku: "kimi-k2-0711-preview",
    },
  });
}

describe("SQLite provider use workflow", () => {
  test("api_key is encrypted on disk, plaintext only in memory", async () => {
    await setupProviders();
    const db = getDb();
    // 验证：DB 中存的是密文（base64 编码），不是明文
    const stored = db
      .query("SELECT encrypted_api_key FROM provider_secrets WHERE provider_id = ?")
      .get("deepseek") as { encrypted_api_key: string };
    expect(stored.encrypted_api_key).toBeTruthy();
    expect(stored.encrypted_api_key).not.toContain("sk-deepseek-original");
    expect(stored.encrypted_api_key.length).toBeGreaterThan(20);

    // 验证：解密后是明文
    const all = await listProviders();
    const deepseek = all.find((p) => p.id === "deepseek");
    expect(deepseek?.api_key).toBe("sk-deepseek-original");
  });

  test("switching current_provider persists across DB reconnections", async () => {
    await setupProviders();
    setCurrentProvider("kimi");

    // 重新打开 DB（模拟新进程）
    _resetForTests();
    openDatabase(TEST_DIR_HOLDER.db); // 不直接调用，但清空缓存
    // 实际行为：listProviders 会从新 DB 读
    const providers = await listProviders();
    expect(providers.length).toBe(2);
    // 注意：getCurrentProviderId 仍然从 settings 读
    const { getCurrentProviderId } = await import("../src/store/db.ts");
    expect(getCurrentProviderId()).toBe("kimi");
  });

  test("provider use updates DB + Claude settings", async () => {
    await setupProviders();
    setCurrentProvider("kimi");
    const { getMasterKey } = await import("../src/store/db.ts");
    const key = getMasterKey();
    const all = await listProviders(key);
    const kimi = all.find((p) => p.id === "kimi")!;

    setSetting("listen_address", "127.0.0.1");
    setSetting("listen_port", "17821");
    const settings = buildClaudeSettings("http://127.0.0.1:17821");
    writeClaudeSettings(TEST_DIR_HOLDER.claude, settings);

    // 验证 settings.json
    const finalSettings = JSON.parse(readFileSync(TEST_DIR_HOLDER.claude, "utf-8"));
    expect(finalSettings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
    expect(finalSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("sonnet");
  });

  test("preserves mcpServers / permissions in user's settings.json", async () => {
    await setupProviders();
    setCurrentProvider("deepseek");
    const { getMasterKey } = await import("../src/store/db.ts");
    const all = await listProviders(getMasterKey());
    const deepseek = all.find((p) => p.id === "deepseek")!;

    // 用户先有自定义 settings
    const userSettings = {
      mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"] } },
      permissions: { allow: ["Bash"] },
      env: { MY_VAR: "keep" },
    };
    writeFileSync(TEST_DIR_HOLDER.claude, JSON.stringify(userSettings));
    writeClaudeSettings(TEST_DIR_HOLDER.claude, buildClaudeSettings("http://127.0.0.1:17821"));

    const finalSettings = JSON.parse(readFileSync(TEST_DIR_HOLDER.claude, "utf-8"));
    expect(finalSettings.mcpServers).toEqual(userSettings.mcpServers);
    expect(finalSettings.permissions).toEqual(userSettings.permissions);
    expect(finalSettings.env.MY_VAR).toBe("keep");
    expect(finalSettings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17821");
  });
});
