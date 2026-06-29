// 共享类型定义：Anthropic Messages API 和 OpenAI Chat Completions API

// ========== Anthropic Messages API ==========

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string; cache_control?: unknown }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  metadata?: { user_id?: string };
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ========== Anthropic SSE 流式事件 ==========

export type AnthropicStreamEvent =
  | { type: "message_start"; message: Partial<AnthropicMessagesResponse> }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: AnthropicMessagesResponse["stop_reason"]; stop_sequence: string | null }; usage?: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

// ========== OpenAI Chat Completions API ==========

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?:
    | string
    | null
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
      >;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  user?: string;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ========== OpenAI SSE 流式 chunk ==========

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
}

// ========== Provider 配置 ==========

export interface ProviderConfig {
  /** 唯一 ID，例如 "minimax" */
  id: string;
  /** 显示名称，例如 "MiniMax M2" */
  name: string;
  /** 厂商标识，用于选择转换策略 */
  vendor: "minimax" | "openai-compatible";
  /** OpenAI 兼容 API base URL（不含 /v1） */
  base_url: string;
  /** API key */
  api_key: string;
  /** 默认模型映射 */
  models: {
    /** sonnet 角色对应的实际模型名 */
    sonnet?: string;
    /** opus 角色对应的实际模型名 */
    opus?: string;
    /** haiku 角色对应的实际模型名 */
    haiku?: string;
  };
  /** 自定义请求头（如需要） */
  headers?: Record<string, string>;
  /** 网站 URL（仅展示用） */
  website_url?: string;
  /** 备注 */
  notes?: string;
}

export interface AppConfig {
  /** 监听地址，默认 127.0.0.1 */
  listen_address: string;
  /** 监听端口，默认 15721 */
  listen_port: number;
  /** 当前激活的 provider id */
  current_provider: string;
  /** provider 列表 */
  providers: ProviderConfig[];
}