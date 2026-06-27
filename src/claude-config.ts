// ~/.claude/settings.json 管理器
// 负责根据当前激活的 provider 写入正确的 ANTHROPIC_BASE_URL / 模型 / token

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderConfig } from "./types.js";

/** Claude Code 的 settings.json 结构（仅写需要的字段） */
interface ClaudeSettings {
  env: {
    ANTHROPIC_BASE_URL: string;
    ANTHROPIC_AUTH_TOKEN: string;
    ANTHROPIC_MODEL: string;
    ANTHROPIC_DEFAULT_SONNET_MODEL: string;
    ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
    ANTHROPIC_DEFAULT_OPUS_MODEL: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

/**
 * 把当前 provider 配置翻译成 Claude Code 期望的 settings.json
 * 关键：ANTHROPIC_BASE_URL 始终指向本地 proxy (127.0.0.1:<port>)，
 * 真正的 token / 模型名映射由 proxy 在转发时处理。
 */
export function buildClaudeSettings(
  provider: ProviderConfig,
  proxyBaseUrl: string
): ClaudeSettings {
  // 决定三个角色用哪个模型
  // 客户端发 "sonnet" / "opus" / "haiku" 时，proxy 端会按 providers[].models 映射
  // 所以这里只写角色名即可
  const roleModel = {
    sonnet: "sonnet",
    opus: "opus",
    haiku: "haiku",
  };

  return {
    env: {
      ANTHROPIC_BASE_URL: proxyBaseUrl,
      ANTHROPIC_AUTH_TOKEN: "cc-switch-managed", // 任意值，proxy 端会替换成真实 key
      ANTHROPIC_MODEL: roleModel.sonnet,
      ANTHROPIC_DEFAULT_SONNET_MODEL: roleModel.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: roleModel.haiku,
      ANTHROPIC_DEFAULT_OPUS_MODEL: roleModel.opus,
    },
  };
}

/**
 * 原子写入 ~/.claude/settings.json
 * - 保留文件中所有其他字段（mcpServers, permissions, ...）
 * - 仅覆盖 env.* 字段
 * - 先写临时文件再 rename，避免半写状态
 */
export function writeClaudeSettings(
  path: string,
  settings: ClaudeSettings
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, "utf-8");
      // 兼容 JSON5 / 注释（Claude Code 的 settings.json 可能带注释）
      existing = JSON.parse(content) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `Failed to parse existing ${path}: ${e instanceof Error ? e.message : e}\n` +
          `Please fix the file manually or remove it.`
      );
    }
  }

  // 合并：保留其他顶层字段，仅替换 env
  const merged: Record<string, unknown> = {
    ...existing,
    env: {
      ...((existing["env"] as Record<string, unknown> | undefined) ?? {}),
      ...settings.env,
    },
  };

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/**
 * 读取现有 ~/.claude/settings.json 的 env 字段（如果存在）
 * 用于诊断 / 状态展示
 */
export function readClaudeEnv(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as { env?: Record<string, string> };
    return parsed.env ?? null;
  } catch {
    return null;
  }
}