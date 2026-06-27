import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import type { AppConfig, ProviderConfig } from "./types.js";

const DEFAULT_CONFIG_PATH =
  process.env["CC_SWITCH_CONFIG"] ?? "/etc/cc-switch/config.yaml";

export const DEFAULT_CONFIG: AppConfig = {
  listen_address: "127.0.0.1",
  listen_port: 17821, // 避开 cc-switch 默认的 15721
  current_provider: "",
  providers: [],
};

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): AppConfig {
  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const content = readFileSync(path, "utf-8");
  const parsed = yaml.load(content) as Partial<AppConfig> | null;
  if (!parsed) {
    return structuredClone(DEFAULT_CONFIG);
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    providers: parsed.providers ?? [],
  };
}

export function saveConfig(config: AppConfig, path: string = DEFAULT_CONFIG_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, yaml.dump(config, { lineWidth: 120, noRefs: true }), "utf-8");
}

export function getProvider(config: AppConfig, id: string): ProviderConfig | undefined {
  return config.providers.find((p) => p.id === id);
}

export function getCurrentProvider(config: AppConfig): ProviderConfig | undefined {
  if (!config.current_provider) return undefined;
  return getProvider(config, config.current_provider);
}