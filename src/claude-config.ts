// ~/.claude/settings.json 管理器
// 负责根据当前激活的 provider 写入正确的 ANTHROPIC_BASE_URL / 模型 / token

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import type { Node, Edit, ParseError } from "jsonc-parser";
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
 *
 * 设计要点（关键 — v0.4.1 修订）：
 * 1. 使用 jsonc-parser 解析，**保留注释、尾随逗号、字段顺序**
 *    （普通 JSON.parse 会丢失注释并按字母序排序）
 * 2. 仅替换 env 子树，**不重写其他顶层字段**（mcpServers / permissions / 等）
 * 3. 用 modify() 拿到 edits，再用 applyEdits() 把 edits 应用到原文本
 *    → 输出文本除 env 块外与输入**逐字节相同**
 * 4. tmp + rename 原子替换
 *
 * 抛错：仅当 settings.json 完全无法解析（损坏严重到 jsonc-parser 也不行）
 */
export function writeClaudeSettings(
  path: string,
  settings: ClaudeSettings
): void {
  let rawText = "";
  let ast: Node | undefined;
  let existingEnv: Record<string, unknown> = {};

  if (existsSync(path)) {
    rawText = readFileSync(path, "utf-8");
    // 关键：用 jsonc-parser 解析，保留注释 / 尾随逗号
    const errors: ParseError[] = [];
    ast = parse(rawText, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      throw new Error(
        `Failed to parse existing ${path} (jsonc-parser error code ${errors[0]}):\n` +
          `Please fix the file manually or remove it.\n` +
          `Raw: ${rawText.slice(0, 200)}...`
      );
    }
    if (ast && typeof ast === "object") {
      const envNode = (ast as unknown as Record<string, unknown>)["env"];
      if (envNode && typeof envNode === "object") {
        existingEnv = envNode as Record<string, unknown>;
      }
    }
  }

  // 用 jsonc-parser 的 modify + applyEdits 在原文本上做精准编辑
  // 保留所有其他字段、注释、格式
  let edits: Edit[] = [];
  if (ast) {
    // 合并：env 新值覆盖 existing 的同名 key
    const mergedEnv = { ...existingEnv, ...settings.env };
    // 替换 env 子树（路径 ["env"]）
    // 注意：ModificationOptions 不接受 allowTrailingComma，
    // 但输出文本会按 jsonc-parser 默认的格式化（缩进 2 空格）
    edits = modify(rawText, ["env"], mergedEnv, {});
  } else {
    // 文件不存在：直接写新 settings（作为完整文档）
    rawText = JSON.stringify(settings, null, 2) + "\n";
  }

  // 如果有 edits，应用；否则直接用原 rawText
  let finalText: string;
  if (edits.length > 0) {
    finalText = applyEdits(rawText, edits);
  } else {
    finalText = rawText;
  }

  // 原子写
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, finalText, "utf-8");
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

/**
 * 读取 ~/.claude/settings.json 的完整原始内容（用于 P0-4 原子化回滚）
 * 返回 null 表示文件不存在（首次切换场景）
 */
export function readClaudeSettingsRaw(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/**
 * 将原始内容写回 ~/.claude/settings.json（用于回滚）
 * - 不解析 JSON：避免 round-trip 丢字段（注释、字段顺序等）
 * - 原子写：tmp + rename
 */
export function restoreClaudeSettings(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.rollback.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}