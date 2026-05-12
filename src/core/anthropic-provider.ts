import type { Message, ToolSchema, StreamDelta } from "./types.js";
import type { ChatResponse } from "./provider.js";
import type { ProviderConfig } from "./provider.js";
import {
  ProviderError,
  AuthError,
  RateLimitError,
  NetworkError,
} from "./errors.js";
import { parseAnthropicSSEStream } from "./anthropic-stream-parser.js";
import { applyAnthropicPromptCaching } from "./prompt-caching.js";
import type { CredentialProvider } from "./credential-pool.js";

/** Default max_tokens when not specified and model not in the lookup table. */
const DEFAULT_MAX_TOKENS = 4096;

/** Model-specific max output token limits (mirrors hermes-agent adapter). */
const MODEL_OUTPUT_LIMITS: Record<string, number> = {
  "claude-opus-4-6": 128_000,
  "claude-sonnet-4-6": 64_000,
  "claude-opus-4-5": 64_000,
  "claude-sonnet-4-5": 64_000,
  "claude-haiku-4-5": 64_000,
  "claude-opus-4": 32_000,
  "claude-sonnet-4": 64_000,
  "claude-3-7-sonnet": 128_000,
  "claude-3-5-sonnet": 8_192,
  "claude-3-5-haiku": 8_192,
  "claude-3-opus": 4_096,
  "claude-3-sonnet": 4_096,
  "claude-3-haiku": 4_096,
};

function getMaxTokens(model: string, configMaxTokens?: number): number {
  if (configMaxTokens) return configMaxTokens;

  const m = model.toLowerCase();
  let bestKey = "";
  let bestVal = DEFAULT_MAX_TOKENS;
  for (const [key, val] of Object.entries(MODEL_OUTPUT_LIMITS)) {
    if (m.includes(key) && key.length > bestKey.length) {
      bestKey = key;
      bestVal = val;
    }
  }
  return bestVal;
}

// ── Anthropic message format types ───────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ── Serialization: neutral → Anthropic ───────────────────────────────

function serializeMessages(messages: Message[]): {
  system: AnthropicContentBlock[] | undefined;
  messages: Array<{ role: string; content: unknown }>;
} {
  const systemBlocks: AnthropicContentBlock[] = [];
  const result: Array<{ role: string; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemBlocks.push({ type: "text", text: m.content ?? "" });
      continue;
    }

    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            // keep empty
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedArgs,
          });
        }
      }
      result.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "(empty)" }],
      });
      continue;
    }

    if (m.role === "tool") {
      const toolResult = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: m.content ?? "(no output)",
      };
      // Merge consecutive tool results into one user message
      const last = result[result.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        (last.content as any[])[0]?.type === "tool_result"
      ) {
        (last.content as any[]).push(toolResult);
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
      continue;
    }

    // user message
    result.push({ role: "user", content: m.content ?? "" });
  }

  return {
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages: result,
  };
}

function serializeTools(tools: ToolSchema[]): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ── Deserialization: Anthropic → neutral ChatResponse ────────────────

function deserializeResponse(resp: AnthropicResponse): ChatResponse {
  let content: string | null = null;
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  const textParts: string[] = [];

  for (const block of resp.content) {
    if (block.type === "text" && block.text !== undefined) {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id!,
        type: "function",
        function: {
          name: block.name!,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking blocks are preserved in the raw response but not mapped to
    // the neutral ChatResponse (they appear in streaming as thinking events)
  }

  if (textParts.length > 0) {
    content = textParts.join("");
  }

  return {
    id: resp.id,
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: resp.stop_reason ?? "end_turn",
      },
    ],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
      cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
    },
  };
}

// ── Provider class ───────────────────────────────────────────────────

/**
 * Native Anthropic Messages API provider.
 * Same public interface as HttpProvider: chat() and chatStream().
 * Uses x-api-key auth and anthropic-version header.
 */
export class AnthropicProvider {
  private readonly config: ProviderConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: ProviderConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  /** Detect if a URL is an Anthropic endpoint. */
  static isAnthropicUrl(url: string): boolean {
    return url.toLowerCase().includes("anthropic");
  }

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<ChatResponse> {
    const { system, messages: anthropicMessages } = serializeMessages(messages);
    const maxTokens = getMaxTokens(this.config.model, options?.maxTokens ?? this.config.maxTokens);

    const body = applyAnthropicPromptCaching({
      model: this.config.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools: serializeTools(tools) } : {}),
    });

    const response = await this.sendWithCredentialRotation((apiKey) =>
      this.fetchFn(
        `${this.config.baseUrl}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        },
      ),
    );
    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const raw = (await response.json()) as AnthropicResponse;
    return deserializeResponse(raw);
  }

  async *chatStream(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): AsyncGenerator<StreamDelta> {
    const { system, messages: anthropicMessages } = serializeMessages(messages);
    const maxTokens = getMaxTokens(this.config.model, options?.maxTokens ?? this.config.maxTokens);

    const body = applyAnthropicPromptCaching({
      model: this.config.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      stream: true,
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools: serializeTools(tools) } : {}),
    });

    const response = await this.sendWithCredentialRotation((apiKey) =>
      this.fetchFn(
        `${this.config.baseUrl}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        },
      ),
    );
    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      throw new ProviderError("No response body for streaming", { status: response.status });
    }

    yield* parseAnthropicSSEStream(response.body);
  }

  private async sendWithCredentialRotation(
    send: (apiKey: string) => Promise<Response>,
  ): Promise<Response> {
    const pool = this.config.credentialPool;
    const provider: CredentialProvider = this.config.providerType ?? "anthropic";
    const exhaustedKeys = new Set<string>();

    for (;;) {
      const credential = pool?.acquire(provider);
      const apiKey = credential?.key ?? this.config.apiKey;
      let response: Response;
      try {
        response = await send(apiKey);
      } catch (err) {
        throw new NetworkError(
          err instanceof Error ? err.message : "Network request failed",
          { cause: err instanceof Error ? err : undefined },
        );
      }

      if (response.ok) {
        if (credential) pool?.releaseHealthy(credential);
        return response;
      }

      if (!credential || !isCredentialRotationStatus(response.status)) {
        return response;
      }

      const resetAt = parseRetryAfter(response.headers.get("retry-after"));
      const message = await readErrorMessage(response.clone());
      pool!.markExhausted(credential, message, resetAt);
      exhaustedKeys.add(credential.key);

      if (!pool!.acquire(provider)) {
        if (this.config.apiKey && !exhaustedKeys.has(this.config.apiKey)) {
          continue;
        }
        return response;
      }
    }
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    let errorBody: { error?: { message?: string; type?: string } } = {};
    try {
      errorBody = (await response.json()) as typeof errorBody;
    } catch {
      // Body may not be JSON
    }

    const message = errorBody.error?.message ?? `HTTP ${response.status}`;
    const lowerMessage = message.toLowerCase();
    const isContextLength =
      lowerMessage.includes("prompt is too long") ||
      lowerMessage.includes("context length") ||
      lowerMessage.includes("maximum context length") ||
      lowerMessage.includes("too many tokens");

    switch (response.status) {
      case 401:
        throw new AuthError(message);
      case 429: {
        const retryAfter = response.headers.get("retry-after");
        throw new RateLimitError(message, {
          retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
        });
      }
      case 400:
        throw new ProviderError(message, {
          status: 400,
          contextLengthExceeded: isContextLength,
        });
      case 529:
        throw new ProviderError(message, { status: 529 });
      default:
        throw new ProviderError(message, { status: response.status });
    }
  }
}

function isCredentialRotationStatus(status: number): boolean {
  return status === 429 || status === 529;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
