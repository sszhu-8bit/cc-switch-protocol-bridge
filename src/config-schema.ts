// 配置 schema 校验（zod）
//
// 目的：启动时校验 AppConfig 和 ProviderConfig 合法性，
// 而不是等到运行时某个字段访问 undefined 才崩溃。
//
// 触发场景：
// - DB 损坏（手工 edit、磁盘 bit-flip）
// - 升级 schema 后老数据缺字段
// - 用户用 `provider add` 时输了非法参数（已被 commander 拦截大部分）
//
// 行为：
// - validate() 返回 Result<Config, ZodError>，调用方决定如何处理
// - formatZodError() 把 ZodError 格式化成人类可读的多行字符串

import { z } from "zod";
import type { AppConfig, ProviderConfig } from "./types.js";

/**
 * Provider 配置 schema
 *
 * 注意：
 * - vendor 限定在已知值（minimax / openai-compatible）
 * - base_url 必须是合法 URL
 * - listen_address 限定 IPv4 或 hostname
 * - listen_port 1-65535
 * - api_key 非空
 * - 3 个 models 字段可空（fallback 链）
 */
export const ProviderConfigSchema = z.object({
  id: z
    .string()
    .min(1, "provider id cannot be empty")
    .max(64, "provider id too long (max 64 chars)")
    .regex(/^[a-zA-Z0-9_-]+$/, "provider id must be alphanumeric (with - or _)"),
  name: z.string().min(1, "provider name cannot be empty"),
  vendor: z.enum(["minimax", "openai-compatible"], {
    message: "vendor must be 'minimax' or 'openai-compatible' (got something else)",
  }),
  base_url: z.string().url("base_url must be a valid URL (e.g. https://api.example.com)"),
  api_key: z.string().min(1, "api_key cannot be empty"),
  models: z.object({
    sonnet: z.string().optional(),
    opus: z.string().optional(),
    haiku: z.string().optional(),
  }),
  headers: z.record(z.string(), z.string()).optional(),
  website_url: z.string().url().optional(),
  notes: z.string().optional(),
});

/**
 * 完整 AppConfig schema
 */
export const AppConfigSchema = z.object({
  listen_address: z
    .string()
    .min(1)
    .refine((v) => /^(127\.|::1|0\.0\.0\.0|localhost)/.test(v) || /^[a-zA-Z0-9.-]+$/.test(v), {
      message: "listen_address must be 127.0.0.1, ::1, localhost, 0.0.0.0, or a hostname",
    }),
  listen_port: z
    .number()
    .int()
    .min(1, "listen_port must be >= 1")
    .max(65535, "listen_port must be <= 65535"),
  current_provider: z.string(),
  providers: z.array(ProviderConfigSchema),
});

/**
 * 校验 provider 单条
 */
export function validateProvider(
  provider: unknown
): { ok: true; data: ProviderConfig } | { ok: false; error: string } {
  const result = ProviderConfigSchema.safeParse(provider);
  if (result.success) {
    return { ok: true, data: result.data as ProviderConfig };
  }
  return { ok: false, error: formatZodError(result.error) };
}

/**
 * 校验完整 AppConfig
 */
export function validateAppConfig(
  config: unknown
): { ok: true; data: AppConfig } | { ok: false; error: string } {
  const result = AppConfigSchema.safeParse(config);
  if (result.success) {
    return { ok: true, data: result.data as AppConfig };
  }
  return { ok: false, error: formatZodError(result.error) };
}

/**
 * 额外校验：current_provider 必须在 providers 列表中
 */
export function validateCurrentProvider(
  config: AppConfig
): { ok: true } | { ok: false; error: string } {
  if (config.current_provider === "") {
    // 空字符串合法（未设置）
    return { ok: true };
  }
  if (!config.providers.some((p) => p.id === config.current_provider)) {
    return {
      ok: false,
      error: `current_provider '${config.current_provider}' not found in providers list (available: ${config.providers
        .map((p) => p.id)
        .join(", ")})`,
    };
  }
  return { ok: true };
}

/**
 * 把 ZodError 格式化成多行可读字符串
 *
 * 例：
 *   ❌ validation failed:
 *     - listen_port: must be <= 65535
 *     - providers.0.base_url: must be a valid URL
 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * 完整启动校验：返回是否 OK + 错误消息
 */
export function validateForStartup(config: AppConfig): { ok: true } | { ok: false; error: string } {
  // 1. schema 校验
  const schemaResult = AppConfigSchema.safeParse(config);
  if (!schemaResult.success) {
    return { ok: false, error: formatZodError(schemaResult.error) };
  }

  // 2. current_provider 引用一致性
  const refResult = validateCurrentProvider(config);
  if (!refResult.ok) {
    return refResult;
  }

  // 3. 业务规则：监听地址 + provider 数量
  if (config.providers.length === 0 && config.current_provider !== "") {
    return {
      ok: false,
      error: "current_provider is set but providers list is empty",
    };
  }

  return { ok: true };
}
