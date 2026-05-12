import type { CredentialPool, CredentialProvider } from "./credential-pool.js";

/** OpenAI-compatible message format with neutral internal representation */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: (args: Record<string, unknown>) => Promise<string>;
  checkFn?: () => boolean;
  toolset?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  credentialPool?: CredentialPool;
  providerType?: CredentialProvider;
}

export interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
}

export interface StreamDelta {
  type: "text" | "tool_call" | "thinking" | "done";
  content?: string;
  toolCall?: Partial<ToolCall>;
  toolCallIndex?: number;
  /** Present on "done" events: "stop", "length"/"max_tokens", "tool_calls", etc. */
  finishReason?: string;
  /** Present on final stream events when the provider reports token usage. */
  usage?: ProviderUsage;
}
