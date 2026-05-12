/**
 * ModelRouter — smart model routing with fallback chain.
 *
 * Wraps multiple provider configs and tries them in order.
 * On RateLimitError or NetworkError from the current model,
 * automatically falls back to the next model in the chain.
 */

import type { Message, ToolSchema, StreamDelta, ProviderConfig } from "./types.js";
import type { ChatResponse } from "./provider.js";
import { HttpProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { RateLimitError, NetworkError } from "./errors.js";
import { getModelMetadata } from "./model-metadata.js";

export interface ModelEntry {
  /** Display / lookup name for the model. */
  name: string;
  /** Explicit provider type. When omitted, resolved from model metadata. */
  provider?: "openai" | "anthropic";
  /** Connection config (baseUrl, apiKey, model slug, optional maxTokens). */
  config: ProviderConfig;
}

export interface ModelRouterConfig {
  models: ModelEntry[];
  /** Optional callback fired when a fallback switch happens. */
  onModelSwitch?: (from: string, to: string) => void;
}

type Provider = HttpProvider | AnthropicProvider;

function isRetryable(err: unknown): boolean {
  return err instanceof RateLimitError || err instanceof NetworkError;
}

function buildProvider(entry: ModelEntry, fetchFn: typeof fetch): Provider {
  const providerType =
    entry.provider ?? getModelMetadata(entry.config.model).provider;

  if (providerType === "anthropic") {
    return new AnthropicProvider(entry.config, fetchFn);
  }
  return new HttpProvider(entry.config, fetchFn);
}

export class ModelRouter {
  private readonly entries: ModelEntry[];
  private readonly providers: Map<string, Provider> = new Map();
  private primaryIndex: number = 0;
  private readonly onModelSwitch?: (from: string, to: string) => void;

  constructor(
    config: ModelRouterConfig,
    fetchFn: typeof fetch = globalThis.fetch,
  ) {
    if (config.models.length === 0) {
      throw new Error("ModelRouter requires at least one model");
    }

    this.entries = config.models;
    this.onModelSwitch = config.onModelSwitch;

    // Pre-build all providers
    for (const entry of this.entries) {
      this.providers.set(entry.name, buildProvider(entry, fetchFn));
    }
  }

  /** Return the name of the currently active (primary) model. */
  currentModel(): string {
    return this.entries[this.primaryIndex].name;
  }

  /** Switch the primary model to one already in the chain by name. */
  switchModel(name: string): void {
    const idx = this.entries.findIndex((e) => e.name === name);
    if (idx === -1) {
      throw new Error(`Model "${name}" not found in router chain`);
    }
    this.primaryIndex = idx;
  }

  /**
   * Send a chat request, trying models in fallback order starting from primary.
   */
  async chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<ChatResponse> {
    return this.withFallback((provider) => provider.chat(messages, tools, options));
  }

  /**
   * Send a streaming chat request with fallback.
   * Note: fallback only kicks in if the initial request errors
   * (i.e., before streaming begins). Mid-stream failures are not retried.
   */
  async *chatStream(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): AsyncGenerator<StreamDelta> {
    // Build fallback order starting from primary
    const order = this.fallbackOrder();
    let lastError: Error | undefined;

    for (let i = 0; i < order.length; i++) {
      const entry = order[i];
      const provider = this.providers.get(entry.name)!;

      try {
        // Attempt to start the stream — the generator constructor may throw
        const stream = provider.chatStream(messages, tools, options);
        // Pull the first chunk to verify the connection actually works
        const first = await stream.next();

        if (i > 0) {
          this.onModelSwitch?.(order[0].name, entry.name);
        }

        if (!first.done) {
          yield first.value;
        }
        yield* stream;
        return;
      } catch (err) {
        if (!isRetryable(err) || i === order.length - 1) {
          throw err;
        }
        lastError = err as Error;
        // continue to next model
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new Error("No models available");
  }

  // ── internal ─────────────────────────────────────────────────────────

  /** Build the ordered list of entries starting from the primary. */
  private fallbackOrder(): ModelEntry[] {
    const order: ModelEntry[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const idx = (this.primaryIndex + i) % this.entries.length;
      order.push(this.entries[idx]);
    }
    return order;
  }

  /** Run an async provider call with fallback on retryable errors. */
  private async withFallback<T>(
    fn: (provider: Provider) => Promise<T>,
  ): Promise<T> {
    const order = this.fallbackOrder();
    let lastError: Error | undefined;

    for (let i = 0; i < order.length; i++) {
      const entry = order[i];
      const provider = this.providers.get(entry.name)!;

      try {
        const result = await fn(provider);
        if (i > 0) {
          this.onModelSwitch?.(order[0].name, entry.name);
        }
        return result;
      } catch (err) {
        if (!isRetryable(err) || i === order.length - 1) {
          throw err;
        }
        lastError = err as Error;
        // continue to next model
      }
    }

    // Should not reach here, but satisfy TS
    throw lastError ?? new Error("No models available");
  }
}
