import type { Message, ProviderUsage } from "./types.js";

export type ModelTier = "fast" | "balanced" | "deep";

export interface ModelTierUsage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export type ModelTierUsageMap = Record<ModelTier, ModelTierUsage>;

export interface SmartModelRoutingInput {
  messages?: Message[];
  lastMessage?: Message;
  todoState?: {
    pending?: number;
    inProgress?: number;
    completed?: number;
  };
  contextSizeTokens?: number;
  phase?: string;
}

export interface ModelRoutingDecision {
  tier: ModelTier;
  model: string;
  reason: string;
}

export interface ModelRoutingPolicy {
  selectTier(input: SmartModelRoutingInput): ModelTier;
}

export interface SmartModelRoutingControllerOptions {
  tierModels: Partial<Record<ModelTier, string>>;
  policy?: ModelRoutingPolicy;
}

const DEEP_PROMPT_PATTERNS = [
  /\b(root cause|debug|investigate|architecture|architect|design|security|threat model)\b/i,
  /\b(refactor|migration|concurrency|race condition|data loss|production)\b/i,
  /原因|架构|调试|排查|安全|并发|设计/,
];

const FAST_PROMPT_PATTERNS = [
  /\b(summarize|format|rename|list|show|next|continue)\b/i,
  /总结|列出|继续|格式化/,
];

export class HeuristicModelRoutingPolicy implements ModelRoutingPolicy {
  selectTier(input: SmartModelRoutingInput): ModelTier {
    const phase = input.phase?.toLowerCase() ?? "";
    if (phase === "deep" || phase === "planning" || phase === "debugging") {
      return "deep";
    }
    if (phase === "cleanup" || phase === "tool-followup") {
      return "fast";
    }

    const contextSize = input.contextSizeTokens ?? 0;
    if (contextSize >= 64_000) return "deep";
    if (contextSize >= 24_000) return "balanced";

    const last = input.lastMessage ?? input.messages?.at(-1);
    const content = typeof last?.content === "string" ? last.content : "";

    if (last?.role === "tool") {
      return content.length > 4_096 ? "balanced" : "fast";
    }

    if (last?.role === "user") {
      if (DEEP_PROMPT_PATTERNS.some((pattern) => pattern.test(content))) {
        return "deep";
      }
      if (FAST_PROMPT_PATTERNS.some((pattern) => pattern.test(content))) {
        return "balanced";
      }
    }

    if ((input.todoState?.inProgress ?? 0) > 0 && (input.todoState?.pending ?? 0) > 3) {
      return "deep";
    }

    return "balanced";
  }
}

export class SmartModelRoutingController {
  private readonly tierModels: Record<ModelTier, string>;
  private readonly policy: ModelRoutingPolicy;
  private readonly usage: ModelTierUsageMap = createEmptyTierUsage();

  constructor(options: SmartModelRoutingControllerOptions) {
    const fallback =
      options.tierModels.balanced ??
      options.tierModels.deep ??
      options.tierModels.fast;
    if (!fallback) {
      throw new Error("SmartModelRoutingController requires at least one tier model");
    }

    this.tierModels = {
      fast: options.tierModels.fast ?? fallback,
      balanced: options.tierModels.balanced ?? fallback,
      deep: options.tierModels.deep ?? fallback,
    };
    this.policy = options.policy ?? new HeuristicModelRoutingPolicy();
  }

  route(input: SmartModelRoutingInput): ModelRoutingDecision {
    const tier = this.policy.selectTier(input);
    this.usage[tier].requests++;
    return {
      tier,
      model: this.tierModels[tier],
      reason: `heuristic:${tier}`,
    };
  }

  recordUsage(tier: ModelTier | undefined, usage: ProviderUsage | undefined): void {
    if (!tier || !usage) return;
    this.usage[tier].input_tokens += usage.prompt_tokens;
    this.usage[tier].output_tokens += usage.completion_tokens;
  }

  stats(): ModelTierUsageMap {
    return {
      fast: { ...this.usage.fast },
      balanced: { ...this.usage.balanced },
      deep: { ...this.usage.deep },
    };
  }
}

export function createEmptyTierUsage(): ModelTierUsageMap {
  return {
    fast: { requests: 0, input_tokens: 0, output_tokens: 0 },
    balanced: { requests: 0, input_tokens: 0, output_tokens: 0 },
    deep: { requests: 0, input_tokens: 0, output_tokens: 0 },
  };
}

export function estimateRoutingCostSavings(stats: ModelTierUsageMap): number {
  const allDeepCost =
    (stats.fast.input_tokens + stats.balanced.input_tokens + stats.deep.input_tokens) * 15 +
    (stats.fast.output_tokens + stats.balanced.output_tokens + stats.deep.output_tokens) * 75;
  if (allDeepCost === 0) return 0;

  const routedCost =
    stats.fast.input_tokens * 1 + stats.fast.output_tokens * 5 +
    stats.balanced.input_tokens * 3 + stats.balanced.output_tokens * 15 +
    stats.deep.input_tokens * 15 + stats.deep.output_tokens * 75;
  return Math.max(0, Math.round(((allDeepCost - routedCost) / allDeepCost) * 100));
}
