// 配置层：基于 SQLite 存储（src/store/db.ts）
//
// 向后兼容：从 YAML 配置迁移过来。对外 API 仍然是 loadConfig / saveConfig
// 但底层是 SQLite，可选地支持加密 API key。

import {
  getCurrentProviderId,
  getSetting,
  listProviders,
  saveProvider,
  setCurrentProvider,
  setSetting,
  deleteProvider as dbDeleteProvider,
} from "./store/db.js";
import { validateForStartup } from "./config-schema.js";
import type { AppConfig, ProviderConfig } from "./types.js";

/** 兼容层：保留旧函数签名 */
export async function loadConfig(): Promise<AppConfig> {
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

/**
 * 此函数现在接受 AppConfig 并将 metadata（listen_address / listen_port /
 * current_provider）写入 settings 表。providers 单独处理。
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  setSetting("listen_address", config.listen_address);
  setSetting("listen_port", String(config.listen_port));
  setCurrentProvider(config.current_provider);
  // providers 由 provider 服务单独管理（每个 CRUD 调用 saveProvider）
  // 这里为向后兼容，如果传入的 providers 不在 DB 中则插入（但通常不应这样做）
  for (const p of config.providers) {
    await saveProvider(p);
  }
}

/** 兼容层 */
export async function getProvider(
  config: AppConfig,
  id: string
): Promise<ProviderConfig | undefined> {
  return config.providers.find((p) => p.id === id);
}

export async function getCurrentProvider(config: AppConfig): Promise<ProviderConfig | undefined> {
  if (!config.current_provider) return undefined;
  return config.providers.find((p) => p.id === config.current_provider);
}

/**
 * 强校验：startServer 前调用一次。
 * 不通过会抛错，进程退出 1。
 */
export function assertValidConfig(config: AppConfig): void {
  const result = validateForStartup(config);
  if (!result.ok) {
    throw new Error(`Configuration validation failed:\n${result.error}`);
  }
}

export { deleteProvider as _deleteProvider } from "./store/db.js";
