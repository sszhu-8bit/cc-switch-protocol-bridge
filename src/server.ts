// Fastify HTTP 服务器：接收 Claude Code 的 Anthropic 协议请求，
// 转换为 OpenAI 协议后转发给上游 provider

import Fastify, { type FastifyInstance } from "fastify";
import { anthropicToOpenAI, openAIToAnthropic } from "./converter/anthropic-to-openai.js";
import {
  OpenAIToAnthropicStream,
  formatAnthropicSSE,
  mapUpstreamStatusToErrorType,
  type AnthropicErrorType,
} from "./converter/streaming.js";
import { callUpstream, callUpstreamStream, parseOpenAIStream, UpstreamError } from "./providers/client.js";
import { logger } from "./logger.js";
import type { AnthropicMessagesRequest } from "./types.js";
import type { AppConfig, ProviderConfig } from "./types.js";
import { getCurrentProvider } from "./config.js";

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // 用 pino 自己的 logger
    bodyLimit: 100 * 1024 * 1024, // 100MB
  });

  // 健康检查
  app.get("/health", async () => {
    const provider = await getCurrentProvider(config);
    return {
      status: "ok",
      current_provider: provider?.id ?? null,
      uptime_seconds: Math.floor(process.uptime()),
    };
  });

  // 主入口：Anthropic Messages API
  app.post("/v1/messages", async (req, reply) => {
    const provider = await getCurrentProvider(config);
    if (!provider) {
      return reply.code(503).send({
        type: "error",
        error: { type: "service_unavailable", message: "no provider configured" },
      });
    }

    const body = req.body as AnthropicMessagesRequest;
    if (!body || !body.model || !Array.isArray(body.messages)) {
      return reply.code(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: "invalid request body" },
      });
    }

    const openaiReq = anthropicToOpenAI(body);
    logger.info(
      { provider: provider.id, model: openaiReq.model, stream: openaiReq.stream },
      "incoming request"
    );

    if (openaiReq.stream) {
      // 流式响应
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const converter = new OpenAIToAnthropicStream();
      try {
        const upstreamBody = await callUpstreamStream(provider, openaiReq);
        for await (const chunk of parseOpenAIStream(upstreamBody)) {
          const events = converter.feed(chunk);
          if (events.length > 0) {
            reply.raw.write(formatAnthropicSSE(events));
          }
        }
        // 正常结束
        const finalEvents = converter.end();
        if (finalEvents.length > 0) {
          reply.raw.write(formatAnthropicSSE(finalEvents));
        }
      } catch (err) {
        // P0-3: 异常中断时先发 message_stop，让客户端"干净收尾"
        // 再发 error event 让客户端知道是异常
        logger.error({ err, provider: provider.id }, "upstream stream interrupted");

        // 步骤 1: 关闭已开的内容块 + message_stop（使用 converter 的 abort 状态机）
        const abortEvents = converter.abort();
        if (abortEvents.length > 0) {
          reply.raw.write(formatAnthropicSSE(abortEvents));
        }

        // 步骤 2: 发 Anthropic 标准格式的 error 事件
        const errType = classifyStreamError(err);
        const errMsg = sanitizeErrorMessage(err);
        reply.raw.write(
          formatAnthropicSSE([
            { type: "error", error: { type: errType, message: errMsg } },
          ])
        );
      }
      reply.raw.end();
      return reply;
    }

    // 单请求
    try {
      const openaiResp = await callUpstream(provider, openaiReq);
      const anthropicResp = openAIToAnthropic(openaiResp);
      return reply.code(200).send(anthropicResp);
    } catch (err) {
      if (err instanceof UpstreamError) {
        logger.error({ status: err.status, url: err.url }, "upstream error");
        return reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({
          type: "error",
          error: {
            type: "upstream_error",
            message: `upstream returned ${err.status}`,
          },
        });
      }
      // 网络错误、DNS 错误等：fetch 抛 TypeError
      logger.error({ err }, "upstream connection error");
      return reply.code(502).send({
        type: "error",
        error: {
          type: "upstream_unreachable",
          message: err instanceof Error ? err.message : "unknown error",
        },
      });
    }
  });

  // Models 端点（Claude Code 探测用）
  app.get("/v1/models", async () => {
    const provider = await getCurrentProvider(config);
    if (!provider) return { data: [] };
    return {
      data: [
        { id: provider.models.sonnet ?? "sonnet", type: "model" },
        { id: provider.models.opus ?? "opus", type: "model" },
        { id: provider.models.haiku ?? "haiku", type: "model" },
      ],
    };
  });

  return app;
}

export async function startServer(config: AppConfig): Promise<void> {
  const app = await buildServer(config);
  await app.listen({ host: config.listen_address, port: config.listen_port });
  logger.info(
    { address: config.listen_address, port: config.listen_port },
    "cc-switch-protocol-bridge started"
  );
}

/**
 * 将流式抛出的异常分类为 Anthropic 错误类型
 */
function classifyStreamError(err: unknown): AnthropicErrorType {
  if (err instanceof UpstreamError) {
    return mapUpstreamStatusToErrorType(err.status);
  }
  // fetch 抛 TypeError = 网络层错误（DNS 失败 / 连接拒绝 / TCP reset）
  if (err instanceof TypeError) {
    return "upstream_unavailable";
  }
  // AbortError / TimeoutError
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return "timeout_error";
  }
  return "api_error";
}

/**
 * 清洗错误信息：避免暴露上游敏感细节（API key / 内部 URL）
 *
 * 错误消息只告诉用户"发生了什么"（便于重试判断），不告诉"为什么"
 * （避免泄漏内部信息）。完整错误在 server log 里（开发可见）。
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof UpstreamError) {
    return `upstream returned ${err.status}`;
  }
  if (err instanceof TypeError) {
    return "upstream unreachable (network error)";
  }
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return "upstream timeout";
  }
  return "internal error";
}