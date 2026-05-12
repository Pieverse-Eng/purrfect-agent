export interface PromptCacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

export interface OpenAiUsageLike {
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

interface AnthropicPromptPayload {
  system?: unknown;
  tools?: unknown[];
  messages?: Array<Record<string, unknown>>;
}

interface PromptCachingOptions {
  ttl?: "5m" | "1h";
}

const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;

function marker(options?: PromptCachingOptions): PromptCacheControl {
  return options?.ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

export function applyAnthropicPromptCaching<T extends AnthropicPromptPayload>(
  payload: T,
  options?: PromptCachingOptions,
): T {
  const next = structuredClone(payload) as T;
  const cacheControl = marker(options);
  let breakpoints = 0;

  if (breakpoints < MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
    breakpoints += markSystem(next, cacheControl) ? 1 : 0;
  }
  if (breakpoints < MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
    breakpoints += markTools(next, cacheControl) ? 1 : 0;
  }
  if (breakpoints < MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
    breakpoints += markStableConversationPrefix(next, cacheControl) ? 1 : 0;
  }

  return next;
}

export function normalizeOpenAiUsage<T extends OpenAiUsageLike>(
  usage: T,
): T & {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  return {
    ...usage,
    cache_read_input_tokens:
      usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function markSystem(
  payload: AnthropicPromptPayload,
  cacheControl: PromptCacheControl,
): boolean {
  if (typeof payload.system === "string") {
    payload.system = [
      {
        type: "text",
        text: payload.system,
        cache_control: cacheControl,
      },
    ];
    return true;
  }

  if (!Array.isArray(payload.system) || payload.system.length === 0) {
    return false;
  }

  const last = payload.system[payload.system.length - 1];
  if (!isRecord(last)) return false;
  last.cache_control = cacheControl;
  return true;
}

function markTools(
  payload: AnthropicPromptPayload,
  cacheControl: PromptCacheControl,
): boolean {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return false;
  }

  const last = payload.tools[payload.tools.length - 1];
  if (!isRecord(last)) return false;
  last.cache_control = cacheControl;
  return true;
}

function markStableConversationPrefix(
  payload: AnthropicPromptPayload,
  cacheControl: PromptCacheControl,
): boolean {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return false;
  }

  const latestUserIndex = findLatestUserMessageIndex(payload.messages);
  if (latestUserIndex <= 0) return false;

  return markMessageContent(payload.messages[latestUserIndex - 1], cacheControl);
}

function findLatestUserMessageIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function markMessageContent(
  message: Record<string, unknown>,
  cacheControl: PromptCacheControl,
): boolean {
  const content = message.content;

  if (typeof content === "string") {
    message.content = [
      {
        type: "text",
        text: content,
        cache_control: cacheControl,
      },
    ];
    return true;
  }

  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }

  const last = content[content.length - 1];
  if (!isRecord(last)) return false;
  last.cache_control = cacheControl;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
