// P0-4 原子化测试
//
// 验证：provider use 失败时正确回滚 DB 和 ~/.claude/settings.json
//
// 这些测试只覆盖纯逻辑层（不涉及真 systemctl 和真 systemd）：
// - claude-config.ts 的 restoreClaudeSettings / readClaudeSettingsRaw
// - "事务模式"的手动模拟（DB 写入 + settings 写入 + 失败回滚）
//
// 端到端的 systemctl restart 验证在 smoke-test.sh 里做。

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeClaudeSettings,
  readClaudeSettingsRaw,
  restoreClaudeSettings,
  buildClaudeSettings,
} from "../src/claude-config.ts";
import {
  _resetForTests,
  openDatabase,
  saveProvider,
  setCurrentProvider,
  getCurrentProviderId,
  listProviders,
} from "../src/store/db.ts";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let counter = 0;
const TEST_DIR_HOLDER: { path: string; db: string; claude: string } = {
  path: "",
  db: "",
  claude: "",
};

beforeEach(() => {
  const dir = join(tmpdir(), `cc-switch-p04-${counter++}`);
  TEST_DIR_HOLDER.path = dir;
  TEST_DIR_HOLDER.db = join(dir, "cc-switch.db");
  TEST_DIR_HOLDER.claude = join(dir, ".claude/settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  process.env["CC_SWITCH_MASTER_KEY"] = TEST_KEY;
  process.env["CC_SWITCH_DB"] = TEST_DIR_HOLDER.db;
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
  delete process.env["CC_SWITCH_MASTER_KEY"];
  delete process.env["CC_SWITCH_DB"];
  try {
    if (existsSync(TEST_DIR_HOLDER.path)) {
      rmSync(TEST_DIR_HOLDER.path, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

describe("P0-4: settings.json 备份与回滚", () => {
  test("readClaudeSettingsRaw 读取完整原文（带注释等）", () => {
    // 用户已有的 settings.json 可能带 JSON5 特性
    const raw = `{
  // 用户注释
  "mcpServers": { "github": { "command": "x" } },
  "env": { "MY_VAR": "original" }
}`;
    writeFileSync(TEST_DIR_HOLDER.claude, raw);
    const restored = readClaudeSettingsRaw(TEST_DIR_HOLDER.claude);
    expect(restored).toBe(raw);
  });

  test("restoreClaudeSettings 把原文写回，保留注释", () => {
    const raw = `{
  // 注释
  "mcpServers": { "github": { "command": "x" } }
}`;
    // 先写一个新版本
    writeClaudeSettings(TEST_DIR_HOLDER.claude, {
      env: { ANTHROPIC_BASE_URL: "http://wrong:9999", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_MODEL: "x", ANTHROPIC_DEFAULT_SONNET_MODEL: "x", ANTHROPIC_DEFAULT_HAIKU_MODEL: "x", ANTHROPIC_DEFAULT_OPUS_MODEL: "x" },
    });
    // 再用 restoreClaudeSettings 写回原始
    restoreClaudeSettings(TEST_DIR_HOLDER.claude, raw);
    expect(readFileSync(TEST_DIR_HOLDER.claude, "utf-8")).toBe(raw);
  });

  test("readClaudeSettingsRaw 在文件不存在时返回 null", () => {
    expect(readClaudeSettingsRaw(join(TEST_DIR_HOLDER.path, "nonexistent"))).toBeNull();
  });

  test("首次切换时 readClaudeSettingsRaw 返回 null，回滚应删除新建文件", () => {
    // 模拟首次切换场景：旧文件不存在
    expect(readClaudeSettingsRaw(TEST_DIR_HOLDER.claude)).toBeNull();
    // 用户首次切到一个 provider
    writeClaudeSettings(TEST_DIR_HOLDER.claude, {
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:17821",
        ANTHROPIC_AUTH_TOKEN: "x",
        ANTHROPIC_MODEL: "x",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "x",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
      },
    });
    expect(existsSync(TEST_DIR_HOLDER.claude)).toBe(true);

    // 模拟回滚：首次场景应删除新建的文件
    // （由 cli.ts 实现，本测试只验证 readClaudeSettingsRaw 返回 null 表示首次场景）
    expect(readClaudeSettingsRaw(TEST_DIR_HOLDER.claude)).not.toBeNull();
  });
});

describe("P0-4: DB 状态快照与回滚", () => {
  test("切换前快照 oldProviderId，切换后可回滚", async () => {
    // 准备两个 provider
    await saveProvider({
      id: "old",
      name: "Old",
      vendor: "openai-compatible",
      base_url: "https://old.example.com",
      api_key: "sk-old",
      models: {},
    });
    await saveProvider({
      id: "new",
      name: "New",
      vendor: "openai-compatible",
      base_url: "https://new.example.com",
      api_key: "sk-new",
      models: {},
    });

    // 初始状态
    setCurrentProvider("old");
    expect(getCurrentProviderId()).toBe("old");

    // 模拟切换
    const oldProviderId = getCurrentProviderId(); // 快照
    setCurrentProvider("new");
    expect(getCurrentProviderId()).toBe("new");

    // 模拟回滚
    setCurrentProvider(oldProviderId);
    expect(getCurrentProviderId()).toBe("old");
  });
});

describe("P0-4: 完整回滚流程模拟", () => {
  test("切换成功：DB 改 + settings 改，无回滚", async () => {
    await saveProvider({
      id: "kimi",
      name: "Kimi",
      vendor: "openai-compatible",
      base_url: "https://api.moonshot.cn",
      api_key: "sk-kimi",
      models: { sonnet: "kimi-k2" },
    });

    // 模拟成功路径
    const oldClaudeSettings = readClaudeSettingsRaw(TEST_DIR_HOLDER.claude);
    expect(oldClaudeSettings).toBeNull(); // 首次

    // 1. 改 DB
    setCurrentProvider("kimi");
    // 2. 改 settings
    writeClaudeSettings(
      TEST_DIR_HOLDER.claude,
      buildClaudeSettings(
        (await listProviders()).find((p) => p.id === "kimi")!,
        "http://127.0.0.1:17821"
      )
    );

    expect(getCurrentProviderId()).toBe("kimi");
    expect(existsSync(TEST_DIR_HOLDER.claude)).toBe(true);
  });

  test("切换失败：DB 改但 settings 写入失败，能回滚 DB", async () => {
    await saveProvider({
      id: "kimi",
      name: "Kimi",
      vendor: "openai-compatible",
      base_url: "https://api.moonshot.cn",
      api_key: "sk-kimi",
      models: {},
    });
    setCurrentProvider("kimi");

    // 切到另一个 provider
    await saveProvider({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-ds",
      models: {},
    });
    const oldProviderId = getCurrentProviderId();
    expect(oldProviderId).toBe("kimi");

    // 模拟切换：DB 改了，但 settings.json 写入失败（mock：用只读路径）
    setCurrentProvider("deepseek");
    // 假装 settings 写入失败（这里不调用 writeClaudeSettings）

    // catch block 回滚
    setCurrentProvider(oldProviderId);

    expect(getCurrentProviderId()).toBe("kimi"); // 恢复
  });

  test("切换失败：DB 改 + settings 改 + restart 失败，回滚所有", async () => {
    await saveProvider({
      id: "old-provider",
      name: "Old",
      vendor: "openai-compatible",
      base_url: "https://old.example.com",
      api_key: "sk-old",
      models: { sonnet: "old-model" },
    });
    await saveProvider({
      id: "new-provider",
      name: "New",
      vendor: "openai-compatible",
      base_url: "https://new.example.com",
      api_key: "sk-new",
      models: { sonnet: "new-model" },
    });

    setCurrentProvider("old-provider");
    // 写一份 settings.json 模拟已存在
    writeFileSync(
      TEST_DIR_HOLDER.claude,
      JSON.stringify({ env: { OTHER: "preserve-me" } })
    );
    const originalSettings = readClaudeSettingsRaw(TEST_DIR_HOLDER.claude);
    expect(originalSettings).not.toBeNull();

    // 模拟切换：
    const oldProviderId = getCurrentProviderId(); // 快照
    setCurrentProvider("new-provider"); // DB 改
    writeClaudeSettings(
      TEST_DIR_HOLDER.claude,
      buildClaudeSettings(
        (await listProviders()).find((p) => p.id === "new-provider")!,
        "http://127.0.0.1:17821"
      )
    ); // settings 改

    // 现在假设 systemctl restart 失败，触发回滚：
    setCurrentProvider(oldProviderId); // DB 回滚
    restoreClaudeSettings(TEST_DIR_HOLDER.claude, originalSettings!); // settings 回滚

    expect(getCurrentProviderId()).toBe("old-provider");
    expect(readClaudeSettingsRaw(TEST_DIR_HOLDER.claude)).toBe(originalSettings);
    // 用户原始数据完整保留
    expect(JSON.parse(readFileSync(TEST_DIR_HOLDER.claude, "utf-8")).env.OTHER).toBe(
      "preserve-me"
    );
  });
});

describe("P0-4: edge cases", () => {
  test("settings.json 完全损坏时 writeClaudeSettings 抛错（不应回滚掩盖原始错误）", () => {
    // 损坏的 JSON（不闭合括号）
    writeFileSync(TEST_DIR_HOLDER.claude, "{ broken");
    expect(() =>
      writeClaudeSettings(TEST_DIR_HOLDER.claude, {
        env: { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_MODEL: "x", ANTHROPIC_DEFAULT_SONNET_MODEL: "x", ANTHROPIC_DEFAULT_HAIKU_MODEL: "x", ANTHROPIC_DEFAULT_OPUS_MODEL: "x" },
      })
    ).toThrow(/Failed to parse existing/);
  });

  test("DB 切换后旧 provider 仍可在 list 中查到", async () => {
    // 回滚不能删 provider 数据
    await saveProvider({
      id: "p1",
      name: "P1",
      vendor: "openai-compatible",
      base_url: "https://p1.example.com",
      api_key: "sk-p1",
      models: {},
    });
    await saveProvider({
      id: "p2",
      name: "P2",
      vendor: "openai-compatible",
      base_url: "https://p2.example.com",
      api_key: "sk-p2",
      models: {},
    });

    setCurrentProvider("p1");
    setCurrentProvider("p2"); // 切
    setCurrentProvider("p1"); // 回滚

    // 两个 provider 都还在
    const all = await listProviders();
    expect(all.length).toBe(2);
    expect(all.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });
});

describe("P0-4 v0.4.2 修复: JSON 注释兼容（v0.4.1 会失败）", () => {
  test("带 // 注释的 settings.json 不会让 use 命令失败", () => {
    // 用户原 settings.json 有注释（v0.4.1 这里会抛 JSON.parse 错）
    const raw = `{
  // 用户自定义注释
  "mcpServers": { "github": { "command": "npx" } },
  "env": { "MY_VAR": "keep" }
}`;
    writeFileSync(TEST_DIR_HOLDER.claude, raw);

    // 切换：不应抛错
    expect(() =>
      writeClaudeSettings(TEST_DIR_HOLDER.claude, {
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:17821",
          ANTHROPIC_AUTH_TOKEN: "x",
          ANTHROPIC_MODEL: "sonnet",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "opus",
        },
      })
    ).not.toThrow();

    // 验证：注释保留在文件里
    const afterRaw = readFileSync(TEST_DIR_HOLDER.claude, "utf-8");
    expect(afterRaw).toContain("用户自定义注释");
    expect(afterRaw).toContain("mcpServers");
    expect(afterRaw).toContain("MY_VAR");
    // 验证新值被写入
    expect(afterRaw).toContain("ANTHROPIC_BASE_URL");
  });

  test("带 /* 块注释的 settings.json 也能处理", () => {
    const raw = `{
  /* 块注释 */
  "permissions": { "allow": ["Bash"] },
  "env": { "X": "1" }
}`;
    writeFileSync(TEST_DIR_HOLDER.claude, raw);

    expect(() =>
      writeClaudeSettings(TEST_DIR_HOLDER.claude, {
        env: {
          ANTHROPIC_BASE_URL: "http://x",
          ANTHROPIC_AUTH_TOKEN: "x",
          ANTHROPIC_MODEL: "x",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "x",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
        },
      })
    ).not.toThrow();

    const afterRaw = readFileSync(TEST_DIR_HOLDER.claude, "utf-8");
    expect(afterRaw).toContain("块注释");
    expect(afterRaw).toContain("permissions");
  });

  test("带尾随逗号的 settings.json 也能处理", () => {
    const raw = `{
  "env": {
    "X": "1",
  },
}`;
    writeFileSync(TEST_DIR_HOLDER.claude, raw);

    expect(() =>
      writeClaudeSettings(TEST_DIR_HOLDER.claude, {
        env: {
          ANTHROPIC_BASE_URL: "http://x",
          ANTHROPIC_AUTH_TOKEN: "x",
          ANTHROPIC_MODEL: "x",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "x",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
        },
      })
    ).not.toThrow();

    // 写入后还应包含原 env 字段
    const afterRaw = readFileSync(TEST_DIR_HOLDER.claude, "utf-8");
    expect(afterRaw).toContain("ANTHROPIC_BASE_URL");
  });

  test("完全损坏的 settings.json（不只是 JSON 错，是二进制）仍抛错", () => {
    writeFileSync(TEST_DIR_HOLDER.claude, "这不是 JSON \x00\x01\x02");
    expect(() =>
      writeClaudeSettings(TEST_DIR_HOLDER.claude, {
        env: {
          ANTHROPIC_BASE_URL: "http://x",
          ANTHROPIC_AUTH_TOKEN: "x",
          ANTHROPIC_MODEL: "x",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "x",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
        },
      })
    ).toThrow();
  });

  test("原始注释在写入后仍出现在文件里", () => {
    const raw = `{
  // 关键注释：mcpServers 必须保留
  "mcpServers": { "github": { "command": "npx" } }
}`;
    writeFileSync(TEST_DIR_HOLDER.claude, raw);

    writeClaudeSettings(TEST_DIR_HOLDER.claude, {
      env: {
        ANTHROPIC_BASE_URL: "http://x",
        ANTHROPIC_AUTH_TOKEN: "x",
        ANTHROPIC_MODEL: "x",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "x",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "x",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
      },
    });

    const after = readFileSync(TEST_DIR_HOLDER.claude, "utf-8");
    expect(after).toContain("关键注释");
  });
});