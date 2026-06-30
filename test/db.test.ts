// SQLite 存储层测试
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetForTests,
  openDatabase,
  saveProvider,
  listProviders,
  deleteProvider,
  setSetting,
  getSetting,
  setCurrentProvider,
  getCurrentProviderId,
  encryptApiKey,
  decryptApiKey,
} from "../src/store/db.ts";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function keyBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(TEST_KEY, "hex"));
}

beforeEach(() => {
  // 强制清干净：每个测试用全新的 TEST_DIR（用 Date.now() + counter）
  // 这里用全局 counter 而不是 Date.now()
  const dir = join(tmpdir(), `cc-switch-db-${counter++}`);
  TEST_DIR_HOLDER.path = dir;
  TEST_DIR_HOLDER.db = join(dir, "cc-switch.db");
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
const TEST_DIR_HOLDER: { path: string; db: string } = { path: "", db: "" };

describe("DB permissions", () => {
  test("DB file is created with owner-only-or-equivalent permissions", () => {
    openDatabase(TEST_DIR_HOLDER.db);
    const stat = statSync(TEST_DIR_HOLDER.db);
    // Unix: 0o600 = owner read+write only.
    // Windows: NTFS 不区分 group/other, 0o600 会被 chmod 映射到 0o644 (含 group/other read)
    // 我们只验证 owner 有写权限 (0o200), 不被 group/other 写 (0o020, 0o002 都应为 0)
    const mode = stat.mode & 0o777;
    if (process.platform === "win32") {
      // Windows: 只断言 owner 有写权限
      expect(mode & 0o200).toBe(0o200);
    } else {
      expect(mode).toBe(0o600);
    }
  });
});

describe("encryption roundtrip", () => {
  test("encrypt then decrypt returns original", async () => {
    const key = keyBytes();
    const plain = "sk-test-key-12345";
    const enc = await encryptApiKey(plain, key);
    expect(enc).not.toContain(plain);
    const dec = await decryptApiKey(enc, key);
    expect(dec).toBe(plain);
  });

  test("different IVs produce different ciphertexts for same plaintext", async () => {
    const key = keyBytes();
    const plain = "sk-test";
    const enc1 = await encryptApiKey(plain, key);
    const enc2 = await encryptApiKey(plain, key);
    expect(enc1).not.toBe(enc2);
    // 但都能解密回原文
    expect(await decryptApiKey(enc1, key)).toBe(plain);
    expect(await decryptApiKey(enc2, key)).toBe(plain);
  });

  test("wrong key fails to decrypt", async () => {
    const key1 = keyBytes();
    const key2 = new Uint8Array(32);
    crypto.getRandomValues(key2);
    const enc = await encryptApiKey("sk-test", key1);
    await expect(decryptApiKey(enc, key2)).rejects.toThrow();
  });
});

describe("provider CRUD", () => {
  test("saveProvider stores encrypted api_key", async () => {
    await saveProvider({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-very-secret-12345",
      models: { sonnet: "deepseek-chat" },
    });

    // 直接查 DB 看存的是密文
    const { getDb } = await import("../src/store/db.ts");
    const db = getDb();
    const row = db
      .query("SELECT encrypted_api_key FROM provider_secrets WHERE provider_id = ?")
      .get("deepseek") as { encrypted_api_key: string };
    expect(row.encrypted_api_key).toBeTruthy();
    expect(row.encrypted_api_key).not.toContain("sk-very-secret-12345");
  });

  test("listProviders decrypts api_key", async () => {
    await saveProvider({
      id: "kimi",
      name: "Kimi",
      vendor: "openai-compatible",
      base_url: "https://api.moonshot.cn",
      api_key: "sk-kimi-secret",
      models: { sonnet: "kimi-k2" },
    });
    const providers = await listProviders();
    expect(providers.length).toBe(1);
    expect(providers[0]?.api_key).toBe("sk-kimi-secret");
  });

  test("deleteProvider removes from both tables", async () => {
    await saveProvider({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-x",
      models: {},
    });
    expect(await deleteProvider("deepseek")).toBe(true);
    const { getDb } = await import("../src/store/db.ts");
    const db = getDb();
    const row = db.query("SELECT * FROM providers WHERE id = ?").get("deepseek");
    expect(row).toBeNull();
  });
});

describe("settings k/v", () => {
  test("set and get", () => {
    setSetting("foo", "bar");
    expect(getSetting("foo")).toBe("bar");
  });

  test("get on missing returns null", () => {
    expect(getSetting("missing")).toBeNull();
  });

  test("setCurrentProvider persists", () => {
    setCurrentProvider("kimi");
    expect(getCurrentProviderId()).toBe("kimi");
  });
});

describe("DB survives re-opening with same key", () => {
  test("can decrypt data written by previous DB instance", async () => {
    await saveProvider({
      id: "deepseek",
      name: "DeepSeek",
      vendor: "openai-compatible",
      base_url: "https://api.deepseek.com",
      api_key: "sk-persistent",
      models: { sonnet: "deepseek-chat" },
    });

    // 关闭再重开
    _resetForTests();
    openDatabase(TEST_DIR_HOLDER.db);
    const providers = await listProviders();
    console.log(
      "DEBUG providers:",
      providers.map((p) => p.id)
    );
    expect(providers.length).toBe(1);
    expect(providers[0]?.api_key).toBe("sk-persistent");
  });
});
