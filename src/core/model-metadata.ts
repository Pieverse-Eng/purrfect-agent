/**
 * Model Metadata Registry — hardcoded registry mapping model names
 * to their capabilities, context lengths, and provider info.
 */

export interface ModelCapabilities {
  vision: boolean;
  toolUse: boolean;
  thinking: boolean;
}

/** USD price per million tokens for a given usage category. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface ModelMetadata {
  contextLength: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  provider: "openai" | "anthropic";
  /** Token limits for auto-escalation on output truncation. */
  escalationTiers: readonly number[];
  /** Max recovery attempts per conversation turn. */
  maxRecoveryAttempts: number;
  /** Public list price per million tokens (optional — omitted for unknown models). */
  pricing?: ModelPricing;
}

export type ModelMetadataOverrides = Partial<
  Omit<ModelMetadata, "capabilities"> & {
    capabilities?: Partial<ModelCapabilities>;
  }
>;

const DEFAULT_METADATA: ModelMetadata = {
  contextLength: 128_000,
  maxOutputTokens: 4_096,
  provider: "openai",
  capabilities: {
    vision: false,
    toolUse: true,
    thinking: false,
  },
  escalationTiers: [4_096, 8_192, 16_384],
  maxRecoveryAttempts: 3,
};

const REGISTRY: Record<string, ModelMetadata> = {
  // Claude 4.x family
  "claude-opus-4-20250514": {
    contextLength: 200_000,
    maxOutputTokens: 32_000,
    provider: "anthropic",
    capabilities: { vision: true, toolUse: true, thinking: true },
    escalationTiers: [8_192, 32_000, 32_000],
    maxRecoveryAttempts: 3,
    pricing: {
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  },
  "claude-sonnet-4-20250514": {
    contextLength: 200_000,
    maxOutputTokens: 16_384,
    provider: "anthropic",
    capabilities: { vision: true, toolUse: true, thinking: true },
    escalationTiers: [8_192, 16_384, 16_384],
    maxRecoveryAttempts: 3,
    pricing: {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  },
  "claude-haiku-4-20250514": {
    contextLength: 200_000,
    maxOutputTokens: 8_192,
    provider: "anthropic",
    capabilities: { vision: true, toolUse: true, thinking: true },
    escalationTiers: [4_096, 8_192, 8_192],
    maxRecoveryAttempts: 3,
    pricing: {
      inputPerMillion: 0.8,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1,
    },
  },

  // OpenAI GPT-4o family
  "gpt-4o": {
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    provider: "openai",
    capabilities: { vision: true, toolUse: true, thinking: false },
    escalationTiers: [8_192, 16_384, 16_384],
    maxRecoveryAttempts: 3,
    pricing: {
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cacheReadPerMillion: 1.25,
    },
  },
  "gpt-4o-mini": {
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    provider: "openai",
    capabilities: { vision: true, toolUse: true, thinking: false },
    escalationTiers: [8_192, 16_384, 16_384],
    maxRecoveryAttempts: 3,
    pricing: {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
      cacheReadPerMillion: 0.075,
    },
  },
};

/**
 * Retrieve metadata for a model, optionally merging config overrides.
 * Unknown models receive sensible defaults (128K context, openai provider).
 */
export function getModelMetadata(
  name: string,
  configOverrides?: ModelMetadataOverrides,
): ModelMetadata {
  const base: ModelMetadata = REGISTRY[name]
    ? structuredClone(REGISTRY[name])
    : structuredClone(DEFAULT_METADATA);

  if (!configOverrides) return base;

  const { capabilities: capOverrides, ...rest } = configOverrides;

  return {
    ...base,
    ...rest,
    capabilities: {
      ...base.capabilities,
      ...(capOverrides ?? {}),
    },
  } as ModelMetadata;
}

/**
 * Shortcut: return the context length for a given model name.
 */
export function getContextLength(name: string): number {
  return getModelMetadata(name).contextLength;
}

/** Token breakdown used to estimate USD cost for a session. */
export interface UsageBreakdown {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Estimate the USD cost of a usage row for a given model. Returns `null`
 * when pricing is not known for the model (or model is missing).
 */
export function estimateCostUsd(
  model: string | null | undefined,
  usage: UsageBreakdown,
): number | null {
  if (!model) return null;
  const pricing = getModelMetadata(model).pricing;
  if (!pricing) return null;

  const million = 1_000_000;
  const inputCost = (usage.input_tokens / million) * pricing.inputPerMillion;
  const outputCost = (usage.output_tokens / million) * pricing.outputPerMillion;
  const cacheReadCost =
    pricing.cacheReadPerMillion !== undefined && usage.cache_read_input_tokens
      ? (usage.cache_read_input_tokens / million) * pricing.cacheReadPerMillion
      : 0;
  const cacheWriteCost =
    pricing.cacheWritePerMillion !== undefined && usage.cache_creation_input_tokens
      ? (usage.cache_creation_input_tokens / million) * pricing.cacheWritePerMillion
      : 0;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
