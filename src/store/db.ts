// SQLite 存储层
// 用 Bun 内建的 bun:sqlite（零额外依赖）。
//
// 数据安全设计：
// 1. api_key 用 AES-256-GCM 加密存到 DB
// 2. 主密钥从 CC_SWITCH_MASTER_KEY 环境变量 / 文件读取（推荐）
// 3. DB 文件权限设为 0600（仅 root 可读写）

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig, ProviderConfig } from "../types.js";

const SCHEMA_VERSION = 1;

/** 默认 DB 路径 */
export const DEFAULT_DB_PATH =
  process.env["CC_SWITCH_DB"] ?? "/var/lib/cc-switch/cc-switch.db";

/** 默认 keyring 文件（fallback） */
const DEFAULT_KEYRING_PATH =
  process.env["CC_SWITCH_KEY_FILE"] ?? "/etc/cc-switch/master.key";

/**
 * 加载或生成 32 字节主密钥（AES-256 key）
 * 优先级：
 *   1. CC_SWITCH_MASTER_KEY 环境变量（hex/base64）
 *   2. /etc/cc-switch/master.key 文件（hex/base64）
 *   3. 临时生成（仅当前进程有效，重启后无法解密已存数据）
 */
export function loadMasterKey(dbPath: string = DEFAULT_DB_PATH): Uint8Array {
  // 1. 环境变量
  const envKey = process.env["CC_SWITCH_MASTER_KEY"];
  if (envKey) {
    try {
      const key = decodeKey(envKey);
      if (key.length === 32) return key;
      if (key.length === 16) {
        // 16 字节视为 AES-128，扩展到 32 字节
        const expanded = new Uint8Array(32);
        expanded.set(key);
        expanded.set(sha256(key), 16);
        return expanded;
      }
      throw new Error(`CC_SWITCH_MASTER_KEY must decode to 16 or 32 bytes, got ${key.length}`);
    } catch (e) {
      throw new Error(`Invalid CC_SWITCH_MASTER_KEY: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2. keyring 文件
  if (existsSync(DEFAULT_KEYRING_PATH)) {
    const raw = readFileSync(DEFAULT_KEYRING_PATH, "utf-8").trim();
    const key = decodeKey(raw);
    if (key.length === 32) return key;
    // 接受 16 字节（扩展到 32）
    if (key.length === 16) {
      const expanded = new Uint8Array(32);
      expanded.set(key);
      expanded.set(sha256(key), 16);
      return expanded;
    }
    throw new Error(
      `master key file at ${DEFAULT_KEYRING_PATH} must decode to 16 or 32 bytes`
    );
  }

  // 3. 临时生成（开发模式用）
  console.warn(
    "[cc-switch] WARNING: No master key found. Generating ephemeral key for this process."
  );
  console.warn(`  Set CC_SWITCH_MASTER_KEY env var or write to ${DEFAULT_KEYRING_PATH}`);
  return crypto.getRandomValues(new Uint8Array(32));
}

function decodeKey(raw: string): Uint8Array {
  // 尝试 hex（64 字符）或 base64
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    return new Uint8Array(Buffer.from(raw, "hex"));
  }
  return new Uint8Array(Buffer.from(raw, "base64"));
}

function sha256(data: Uint8Array): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(data);
  return new Uint8Array(hash.digest());
}

/**
 * AES-256-GCM 加密 API key
 * 输出格式: base64(iv || ciphertext || tag)
 */
export async function encryptApiKey(
  plain: string,
  masterKey: Uint8Array
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    masterKey as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plain)
  );
  // Web Crypto 返回的是 ciphertext+tag 拼接
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

/**
 * AES-256-GCM 解密 API key
 */
export async function decryptApiKey(
  encoded: string,
  masterKey: Uint8Array
): Promise<string> {
  const combined = new Uint8Array(Buffer.from(encoded, "base64"));
  if (combined.length < 12 + 16) {
    throw new Error("encrypted api_key is too short (corrupted?)");
  }
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await crypto.subtle.importKey(
    "raw",
    masterKey as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(plain);
}

/** Schema: settings (key/value), providers (id/app_type/encrypted_payload), providers_secrets (id/app_type/encrypted_api_key) */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL DEFAULT 'claude',
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '{}',
  headers_json TEXT NOT NULL DEFAULT '{}',
  website_url TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sort_index INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, app_type)
);

CREATE TABLE IF NOT EXISTS provider_secrets (
  provider_id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  PRIMARY KEY (provider_id, app_type),
  FOREIGN KEY (provider_id, app_type) REFERENCES providers(id, app_type) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_providers_app_type ON providers(app_type);
`;

/**
 * 打开 SQLite DB，自动设置权限 0600
 */
export function openDatabase(path: string = DEFAULT_DB_PATH): Database {
  // 确保父目录存在
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path, { create: true });
  db.exec(SCHEMA);

  // 设置 0600 权限（防止同机其他用户读 key）
  try {
    chmodSync(path, 0o600);
  } catch (e) {
    console.warn(`[cc-switch] WARN: failed to chmod 600 on ${path}: ${e}`);
  }

  // 记录 schema 版本
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SCHEMA_VERSION)
  );

  return db;
}

/**
 * 全局单例：当前进程内共享的 DB 连接和 master key
 */
let _db: Database | null = null;
let _masterKey: Uint8Array | null = null;

/**
 * 获取当前 DB（惰性初始化单例）
 * 如果 env var CC_SWITCH_DB 在初始化后改动，再次调用还是返回单例。
 * 如要切换 DB path，先调用 _resetForTests()。
 */
export function getDb(): Database {
  if (!_db) {
    const path = process.env["CC_SWITCH_DB"] ?? DEFAULT_DB_PATH;
    _db = openDatabase(path);
  }
  return _db;
}

export function getMasterKey(path?: string): Uint8Array {
  if (!_masterKey) _masterKey = loadMasterKey(path);
  return _masterKey;
}

/** 测试用：重置全局单例 */
export function _resetForTests() {
  if (_db) {
    _db.close();
    _db = null;
  }
  _masterKey = null;
}

// ========== Provider CRUD ==========

/**
 * 保存 provider（包括加密的 api_key 到独立表）
 */
export async function saveProvider(
  p: ProviderConfig,
  masterKey?: Uint8Array
): Promise<void> {
  const db = getDb();
  const key = masterKey ?? getMasterKey();
  const encKey = await encryptApiKey(p.api_key, key);

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO providers
       (id, app_type, name, vendor, base_url, models_json, headers_json, website_url, notes)
       VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p.id,
      p.name,
      p.vendor,
      p.base_url,
      JSON.stringify(p.models ?? {}),
      JSON.stringify(p.headers ?? {}),
      p.website_url ?? null,
      p.notes ?? null
    );
    db.prepare(
      `INSERT OR REPLACE INTO provider_secrets (provider_id, app_type, encrypted_api_key)
       VALUES (?, 'claude', ?)`
    ).run(p.id, encKey);
  });
  txn();
}

export async function deleteProvider(id: string): Promise<boolean> {
  const db = getDb();
  const result = db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
  return result.changes > 0;
}

export async function listProviders(
  masterKey?: Uint8Array
): Promise<ProviderConfig[]> {
  const db = getDb();
  const key = masterKey ?? getMasterKey();

  const rows = db
    .query(
      `SELECT p.id, p.name, p.vendor, p.base_url, p.models_json, p.headers_json,
              p.website_url, p.notes, s.encrypted_api_key
       FROM providers p
       LEFT JOIN provider_secrets s ON s.provider_id = p.id AND s.app_type = p.app_type
       WHERE p.app_type = 'claude'
       ORDER BY p.sort_index, p.created_at, p.id`
    )
    .all() as Array<{
    id: string;
    name: string;
    vendor: string;
    base_url: string;
    models_json: string;
    headers_json: string;
    website_url: string | null;
    notes: string | null;
    encrypted_api_key: string | null;
  }>;

  const out: ProviderConfig[] = [];
  for (const row of rows) {
    let apiKey = "";
    if (row.encrypted_api_key) {
      try {
        apiKey = await decryptApiKey(row.encrypted_api_key, key);
      } catch (e) {
        console.error(
          `[cc-switch] Failed to decrypt api_key for provider '${row.id}': ${e instanceof Error ? e.message : e}`
        );
        apiKey = "";
      }
    }
    out.push({
      id: row.id,
      name: row.name,
      vendor: row.vendor as ProviderConfig["vendor"],
      base_url: row.base_url,
      api_key: apiKey,
      models: JSON.parse(row.models_json),
      headers: row.headers_json === "{}" ? undefined : JSON.parse(row.headers_json),
      website_url: row.website_url ?? undefined,
      notes: row.notes ?? undefined,
    });
  }
  return out;
}

export async function getProvider(
  id: string,
  masterKey?: Uint8Array
): Promise<ProviderConfig | null> {
  const all = await listProviders(masterKey);
  return all.find((p) => p.id === id) ?? null;
}

// ========== Settings (key/value) ==========

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
    key,
    value
  );
}

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

/** 设置当前激活的 provider（"claude" 是固定的 app_type） */
export function setCurrentProvider(id: string): void {
  setSetting("current_provider", id);
}

export function getCurrentProviderId(): string {
  return getSetting("current_provider") ?? "";
}

// ========== 兼容旧 API（drop-in 替换 YAML 版 config.ts） ==========

/**
 * 模仿原 YAML loadConfig() 的接口，但底层走 DB
 * 仍然返回 AppConfig 结构，向后兼容
 */
export async function loadAppConfig(): Promise<AppConfig> {
  const providers = await listProviders();
  const listenAddress = getSetting("listen_address") ?? "127.0.0.1";
  const listenPort = parseInt(getSetting("listen_port") ?? "17821", 10);
  return {
    listen_address: listenAddress,
    listen_port: listenPort,
    current_provider: getCurrentProviderId(),
    providers,
  };
}