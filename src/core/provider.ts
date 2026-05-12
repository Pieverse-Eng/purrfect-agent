import type { Message, ToolSchema, StreamDelta, ProviderUsage } from "./types.js";
import {
  ProviderError,
  AuthError,
  RateLimitError,
  NetworkError,
} from "./errors.js";
import { parseSSEStream } from "./stream-parser.js";
import { normalizeOpenAiUsage } from "./prompt-caching.js";
import type {
  CredentialPool,
  CredentialProvider,
} from "./credential-pool.js";

export interface ChatResponse {
  id: string;
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
    finish_reason: string;
  }>;
  usage?: ProviderUsage;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  credentialPool?: CredentialPool;
  providerType?: CredentialProvider;
}

/**
 * Raw HTTP provider abstraction using fetch.
 * No OpenAI/Anthropic SDK dependencies.
 * Targets OpenAI chat completions format as baseline wire protocol.
 */
export class HttpProvider {
  private readonly config: ProviderConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: ProviderConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<ChatResponse> {
    const effectiveMaxTokens = options?.maxTokens ?? this.config.maxTokens;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(effectiveMaxTokens ? { max_tokens: effectiveMaxTokens } : {}),
    };

    const send = (apiKey: string): Promise<Response> =>
      this.fetchFn(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        },
      );

    const response = await this.sendWithCredentialRotation(send);
    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    return normalizeOpenAiResponse((await response.json()) as ChatResponse);
  }

  async *chatStream(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): AsyncGenerator<StreamDelta> {
    const effectiveMaxTokens = options?.maxTokens ?? this.config.maxTokens;
    const baseBody: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
      ...(effectiveMaxTokens ? { max_tokens: effectiveMaxTokens } : {}),
    };

    const send = async (includeUsage: boolean, apiKey: string): Promise<Response> => {
      const body = {
        ...baseBody,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      };
      return this.fetchFn(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        },
      );
    };

    let response: Response;
    try {
      response = await this.sendWithCredentialRotation((apiKey) => send(true, apiKey));
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new NetworkError(
        err instanceof Error ? err.message : "Network request failed",
        { cause: err instanceof Error ? err : undefined },
      );
    }

    if (!response.ok) {
      if (await rejectsStreamOptions(response.clone())) {
        try {
          response = await this.sendWithCredentialRotation((apiKey) => send(false, apiKey));
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          throw new NetworkError(
            err instanceof Error ? err.message : "Network request failed",
            { cause: err instanceof Error ? err : undefined },
          );
        }
        if (!response.ok) {
          await this.handleErrorResponse(response);
        }
      } else {
        await this.handleErrorResponse(response);
      }
    }

    if (!response.body) {
      throw new ProviderError("No response body for streaming", { status: response.status });
    }

    yield* parseSSEStream(response.body);
  }

  private async sendWithCredentialRotation(
    send: (apiKey: string) => Promise<Response>,
  ): Promise<Response> {
    const pool = this.config.credentialPool;
    const provider = this.config.providerType ?? "openai";
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
    let errorBody: { error?: { message?: string; code?: string } } = {};
    try {
      errorBody = (await response.json()) as typeof errorBody;
    } catch {
      // Body may not be JSON
    }

    const message = errorBody.error?.message ?? `HTTP ${response.status}`;
    const code = errorBody.error?.code;

    switch (response.status) {
      case 401:
        throw new AuthError(message);
      case 429: {
        const retryAfter = response.headers.get("retry-after");
        throw new RateLimitError(message, {
          retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
        });
      }
      case 413:
      case 400: {
        const isContextLength =
          code === "context_length_exceeded" ||
          message.toLowerCase().includes("context length");
        throw new ProviderError(message, {
          status: response.status,
          contextLengthExceeded: isContextLength,
        });
      }
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

async function rejectsStreamOptions(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;

  let message = "";
  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string } };
    message = `${body.error?.message ?? ""} ${body.error?.code ?? ""}`;
  } catch {
    try {
      message = await response.text();
    } catch {
      return false;
    }
  }

  const lower = message.toLowerCase();
  return (
    lower.includes("stream_options") &&
    (
      lower.includes("unknown") ||
      lower.includes("unrecognized") ||
      lower.includes("unsupported") ||
      lower.includes("invalid")
    )
  );
}

function normalizeOpenAiResponse(response: ChatResponse): ChatResponse {
  if (!response.usage) return response;

  return {
    ...response,
    usage: normalizeOpenAiUsage(response.usage),
  };
}
