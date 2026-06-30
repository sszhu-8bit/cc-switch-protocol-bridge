// 上游 provider HTTP 客户端：发送 OpenAI 格式请求给国内厂商

import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from "../types.js";
import type { ProviderConfig } from "../types.js";

/**
 * 把 model 别名映射到上游真实模型名
 */
export function resolveModel(provider: ProviderConfig, requestedModel: string): string {
  const lower = requestedModel.toLowerCase();
  if (lower.includes("opus")) return provider.models.opus ?? requestedModel;
  if (lower.includes("haiku")) return provider.models.haiku ?? requestedModel;
  // 默认 sonnet（含 claude- / sonnet / 其它）
  return provider.models.sonnet ?? requestedModel;
}

/**
 * 构造上游 URL
 */
export function buildUpstreamUrl(provider: ProviderConfig, stream: boolean): string {
  const base = provider.base_url.replace(/\/$/, "");
  // 默认假设 base_url 不含 /v1，统一补齐
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return url;
}

/**
 * 构造请求头
 */
function buildHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.api_key}`,
  };
  // 合并厂商自定义头
  if (provider.headers) {
    Object.assign(headers, provider.headers);
  }
  return headers;
}

/**
 * 单请求（非流式）
 */
export async function callUpstream(
  provider: ProviderConfig,
  req: OpenAIChatRequest
): Promise<OpenAIChatResponse> {
  const url = buildUpstreamUrl(provider, false);
  const headers = buildHeaders(provider);

  const mapped: OpenAIChatRequest = { ...req, model: resolveModel(provider, req.model) };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(mapped),
    // 不开 streaming
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new UpstreamError(resp.status, text, url);
  }

  const data = (await resp.json()) as OpenAIChatResponse;
  return data;
}

/**
 * 流式：返回 ReadableStream<Uint8Array>（OpenAI SSE 格式原始字节流）
 * 由调用方负责按行解析
 */
export async function callUpstreamStream(
  provider: ProviderConfig,
  req: OpenAIChatRequest
): Promise<ReadableStream<Uint8Array>> {
  const url = buildUpstreamUrl(provider, true);
  const headers = buildHeaders(provider);
  const mapped: OpenAIChatRequest = {
    ...req,
    stream: true,
    model: resolveModel(provider, req.model),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(mapped),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new UpstreamError(resp.status, text, url);
  }
  if (!resp.body) {
    throw new UpstreamError(500, "upstream returned no body", url);
  }
  return resp.body;
}

export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string
  ) {
    super(`upstream ${status}: ${body.slice(0, 200)}`);
    this.name = "UpstreamError";
  }
}

/**
 * 把 OpenAI 流式字节流（"data: {...}\n\n" 格式）按行解析为 chunk 对象
 */
export async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<OpenAIStreamChunk | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // 按 SSE 事件边界（一个或多个连续 \n\n）切分
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      const data = dataLines.join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        yield null;
        continue;
      }
      try {
        yield JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        // 忽略解析错误，常见于上游心跳
      }
    }
  }

  // 流结束，处理残余 buffer
  if (buffer.trim()) {
    const dataLines: string[] = [];
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const data = dataLines.join("\n");
    if (data && data !== "[DONE]") {
      try {
        yield JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        // ignore
      }
    }
  }
}
