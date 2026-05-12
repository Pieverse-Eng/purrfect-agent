/**
 * Context window management with truncation and LLM-based summarization.
 *
 * Pipeline:
 *   1. Prune old tool results (cheap pre-pass, no LLM call)
 *   2. Protect head (system + first exchange) and tail (recent by token budget)
 *   3. Summarize middle turns via callback or auxiliary provider
 *   4. Role alternation to avoid consecutive same-role messages
 *   5. Sanitize orphaned tool-call / tool-result pairs
 *
 * Two entry points:
 *   - compress(messages)        — unconditional full compression
 *   - preflightCompress(msgs)   — only compress if estimate >= threshold,
 *                                 called BEFORE dispatch to avoid 413 round-trip
 */
import { encode } from "gpt-tokenizer";
import type { Message, ToolSchema, ToolCall } from "./types.js";

export const SUMMARY_PREFIX =
  "[CONTEXT COMPACTION] Earlier turns in this conversation were compacted " +
  "to save context space. The summary below describes work that was " +
  "already completed, and the current session state may still reflect " +
  "that work (for example, files may already be changed). Use the summary " +
  "and the current state to continue from where things left off, and " +
  "avoid repeating work:";

const PRUNED_TOOL_PLACEHOLDER =
  "[Old tool output cleared to save context space]";

const DEFAULT_PRUNE_MAX_BYTES = 200;

const DEFAULT_SUMMARIZATION_SYSTEM =
  "You are a context-compaction assistant. Summarize the conversation " +
  "segment below into a STRUCTURED digest with these exact section headers " +
  "(omit a section only if empty):\n\n" +
  "Goal: the user's overall objective for the session.\n" +
  "Progress: what has been accomplished so far (bullet list).\n" +
  "Decisions: concrete decisions the agent made and any invariants it " +
  "must respect.\n" +
  "Files: files created, edited, or referenced (path → one-line note).\n" +
  "Open Questions: unresolved items or blockers.\n" +
  "Next Steps: what the follow-up turn should do first.\n\n" +
  "Be dense but faithful. Omit filler and verbatim content. Do not add " +
  "a prefix header — the caller will add one.";

const ITERATIVE_SUMMARIZATION_SYSTEM =
  DEFAULT_SUMMARIZATION_SYSTEM +
  "\n\nYou are REFINING an existing structured summary with new turns. " +
  "Keep earlier bullets that remain relevant, update or drop bullets that " +
  "have become wrong, and add new ones from the new turns. Do NOT repeat " +
  "yourself across sections. Do NOT restart the summary from scratch.";

// ─── Public types ────────────────────────────────────────────────────────

/** Minimal duck-typed provider for auxiliary summarization. */
export interface SummarizerProvider {
  chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<{
    choices: Array<{ message: { content: string | null } }>;
  }>;
}

export interface SummarizeCallbackOptions {
  budget: number;
  signal?: AbortSignal;
  /**
   * Structured summary carried over from the previous compaction. When set,
   * the callback should refine this summary rather than regenerate from
   * scratch so earlier context is not silently lost.
   */
  previousSummary?: string;
}

export type SummarizeCallback = (
  messages: Message[],
  opts: SummarizeCallbackOptions,
) => Promise<string>;

export interface CompressorOptions {
  contextLength: number;
  thresholdPercent?: number;
  protectFirstN?: number;
  protectLastN?: number;
  tailTokenBudget?: number;
  /** If > 0, preflight triggers when estimate + margin >= threshold. Default 2048. */
  preflightMarginTokens?: number;
  /** Optional cheap provider for auto-summarization (fallback when no callback). */
  auxiliaryProvider?: SummarizerProvider;
}

export interface CompressOptions {
  summarize?: SummarizeCallback;
  signal?: AbortSignal;
}

// ─── Token estimation ────────────────────────────────────────────────────

function safeEncode(text: string): number {
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function messageText(msg: Message): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (c == null) return "";
  try {
    return JSON.stringify(c);
  } catch {
    return "";
  }
}

export function estimateTokens(msg: Message): number {
  let tokens = safeEncode(messageText(msg)) + 4;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += safeEncode(tc.function.arguments ?? "") + safeEncode(tc.function.name ?? "");
    }
  }
  return tokens;
}

export function estimateTotalTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m);
  return total;
}

// ─── Standalone: prune old tool results ──────────────────────────────────

export interface PruneToolResultsOptions {
  /** How many most-recent messages to leave untouched. Default 60. */
  maxAgeTurns?: number;
  /** Tool-result bodies larger than this get replaced with a placeholder. */
  maxBytesPerResult?: number;
  /** Placeholder text. Override for tests or locale. */
  placeholder?: string;
}

/**
 * Replace old tool-result bodies with a compact placeholder, preserving
 * the pair structure (role="tool" + tool_call_id stay). Cheap; no LLM call.
 * Mirrors hermes `_prune_old_tool_results`.
 */
export function pruneToolResults(
  messages: Message[],
  opts: PruneToolResultsOptions = {},
): Message[] {
  if (!messages.length) return messages;
  const maxAgeTurns = opts.maxAgeTurns ?? 60;
  const maxBytes = opts.maxBytesPerResult ?? DEFAULT_PRUNE_MAX_BYTES;
  const placeholder = opts.placeholder ?? PRUNED_TOOL_PLACEHOLDER;

  const n = messages.length;
  const boundary = Math.max(0, n - maxAgeTurns);
  if (boundary === 0) return messages.map((m) => ({ ...m }));

  const result = messages.map((m) => ({ ...m }));
  for (let i = 0; i < boundary; i++) {
    const msg = result[i];
    if (msg.role !== "tool") continue;
    const body = typeof msg.content === "string" ? msg.content : "";
    if (!body || body === placeholder) continue;
    if (body.length > maxBytes) {
      result[i] = { ...msg, content: placeholder };
    }
  }
  return result;
}

// ─── Auxiliary-provider summarizer factory ───────────────────────────────

/**
 * Build a SummarizeCallback backed by a cheap provider. Used when no
 * explicit callback is supplied but compressor has an auxiliaryProvider.
 */
export function createProviderSummarizer(
  provider: SummarizerProvider,
  systemPrompt: string = DEFAULT_SUMMARIZATION_SYSTEM,
): SummarizeCallback {
  return async (messages, { budget, signal, previousSummary }) => {
    const conversationDump = messages
      .map((m) => {
        const base = `${m.role.toUpperCase()}: ${messageText(m) || "(no text)"}`;
        if (m.role === "assistant" && m.tool_calls?.length) {
          const calls = m.tool_calls
            .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
            .join("; ");
          return `${base}\n  tool_calls: ${calls}`;
        }
        if (m.role === "tool" && m.tool_call_id) {
          return `TOOL[${m.tool_call_id}]: ${messageText(m)}`;
        }
        return base;
      })
      .join("\n\n");

    const trimmedPrevious = previousSummary?.trim();
    const effectiveSystem = trimmedPrevious
      ? ITERATIVE_SUMMARIZATION_SYSTEM
      : systemPrompt;
    const userContent = trimmedPrevious
      ? `Previous structured summary:\n${trimmedPrevious}\n\n` +
        `New conversation turns to fold in:\n${conversationDump}`
      : conversationDump;

    const resp = await provider.chat(
      [
        { role: "system", content: effectiveSystem },
        { role: "user", content: userContent },
      ],
      [],
      { signal, maxTokens: budget },
    );
    return resp.choices?.[0]?.message?.content ?? "";
  };
}

// ─── Compressor class ────────────────────────────────────────────────────

export class ContextCompressor {
  readonly contextLength: number;
  readonly thresholdPercent: number;
  readonly thresholdTokens: number;
  readonly protectFirstN: number;
  readonly protectLastN: number;
  readonly tailTokenBudget: number;
  readonly preflightMarginTokens: number;
  readonly auxiliaryProvider?: SummarizerProvider;

  private compressionCount = 0;
  private previousSummary: string | null = null;

  get compressions(): number {
    return this.compressionCount;
  }

  /** Last structured summary generated by this compressor, without the prefix banner. */
  getPreviousSummary(): string | null {
    return this.previousSummary;
  }

  /** Reset summary history — used on session reset/resume with fresh context. */
  resetSummaryHistory(): void {
    this.previousSummary = null;
  }

  constructor(opts: CompressorOptions) {
    this.contextLength = opts.contextLength;
    this.thresholdPercent = opts.thresholdPercent ?? 0.5;
    this.protectFirstN = opts.protectFirstN ?? 3;
    this.protectLastN = opts.protectLastN ?? 20;
    this.thresholdTokens = Math.floor(
      this.contextLength * this.thresholdPercent,
    );
    this.tailTokenBudget =
      opts.tailTokenBudget ?? Math.floor(this.thresholdTokens * 0.2);
    // Default margin scales with threshold to stay reasonable on small
    // context windows (e.g. 4K models where a flat 2048 would swallow
    // most of the budget and trigger preflight too aggressively).
    this.preflightMarginTokens =
      opts.preflightMarginTokens ??
      Math.min(2048, Math.floor(this.thresholdTokens * 0.1));
    this.auxiliaryProvider = opts.auxiliaryProvider;
  }

  // ── Preflight ─────────────────────────────────────────────────────────

  /**
   * Legacy check — returns true if estimated tokens >= threshold.
   * Preserved for backwards compatibility with AgentLoop wiring.
   */
  shouldCompress(messages: Message[], contextLength: number): boolean {
    const estimate = estimateTotalTokens(messages);
    const threshold = Math.floor(contextLength * this.thresholdPercent);
    return estimate >= threshold;
  }

  /**
   * Preflight check: is the next turn likely to exceed the window?
   * Uses the current estimate + a margin reserve for the upcoming response.
   */
  shouldCompressPreflight(
    messages: Message[],
    promptTokens?: number,
  ): boolean {
    const estimate = promptTokens ?? estimateTotalTokens(messages);
    return estimate + this.preflightMarginTokens >= this.thresholdTokens;
  }

  /**
   * Compress eagerly BEFORE dispatch if the session is close to the budget.
   * Returns messages unchanged when below threshold — cheap.
   */
  async preflightCompress(
    messages: Message[],
    options: CompressOptions = {},
  ): Promise<Message[]> {
    if (!this.shouldCompressPreflight(messages)) return messages;
    return this.compress(messages, options);
  }

  // ── Main compression ──────────────────────────────────────────────────

  async compress(
    messages: Message[],
    options: CompressOptions = {},
  ): Promise<Message[]> {
    const n = messages.length;
    if (n <= this.protectFirstN + this.protectLastN + 1) {
      return messages;
    }

    // Phase 1: prune old tool-result bodies (no LLM)
    let working = pruneToolResults(messages, {
      maxAgeTurns: this.protectLastN * 3,
      maxBytesPerResult: DEFAULT_PRUNE_MAX_BYTES,
    });

    // Phase 2: compute head / tail boundaries
    let compressStart = this._alignBoundaryForward(
      working,
      this.protectFirstN,
    );
    const compressEnd = this._findTailCut(working, compressStart);
    if (compressStart >= compressEnd) return working;

    const turnsToSummarize = working.slice(compressStart, compressEnd);

    // Phase 3: obtain summary — prefer explicit callback, then aux provider
    const summarizer: SummarizeCallback | undefined =
      options.summarize ??
      (this.auxiliaryProvider
        ? createProviderSummarizer(this.auxiliaryProvider)
        : undefined);

    let summary: string | null = null;
    let rawSummary: string | null = null;
    if (summarizer) {
      const budget = Math.max(
        2000,
        Math.floor(estimateTotalTokens(turnsToSummarize) * 0.2),
      );
      try {
        const raw = await summarizer(turnsToSummarize, {
          budget,
          signal: options.signal,
          ...(this.previousSummary
            ? { previousSummary: this.previousSummary }
            : {}),
        });
        rawSummary = raw?.trim() ?? null;
        summary = this._withSummaryPrefix(raw);
      } catch {
        summary = null; // fallback: truncation-only
        rawSummary = null;
      }
    }

    // Phase 4: assemble output
    const compressed: Message[] = [];
    for (let i = 0; i < compressStart; i++) compressed.push({ ...working[i] });

    let mergeSummaryIntoTail = false;
    if (summary) {
      const lastHeadRole =
        compressStart > 0 ? working[compressStart - 1].role : "user";
      const firstTailRole =
        compressEnd < n ? working[compressEnd].role : "user";

      let summaryRole: "user" | "assistant" =
        lastHeadRole === "assistant" || lastHeadRole === "tool"
          ? "user"
          : "assistant";

      if (summaryRole === firstTailRole) {
        const flipped: "user" | "assistant" =
          summaryRole === "user" ? "assistant" : "user";
        if (flipped !== lastHeadRole) summaryRole = flipped;
        else mergeSummaryIntoTail = true;
      }

      if (!mergeSummaryIntoTail) {
        compressed.push({ role: summaryRole, content: summary });
      }
    }

    for (let i = compressEnd; i < n; i++) {
      const msg = { ...working[i] };
      if (mergeSummaryIntoTail && i === compressEnd && summary) {
        const original = msg.content ?? "";
        msg.content = summary + "\n\n" + original;
        mergeSummaryIntoTail = false;
      }
      compressed.push(msg);
    }

    this.compressionCount++;
    if (rawSummary && rawSummary.length > 0) {
      this.previousSummary = rawSummary;
    }

    // Phase 5: repair any orphaned tool-call / tool-result pairs
    return this._sanitizeToolPairs(compressed);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Push compress-start forward past any orphan tool results. */
  private _alignBoundaryForward(messages: Message[], idx: number): number {
    while (idx < messages.length && messages[idx].role === "tool") idx++;
    return idx;
  }

  /** Pull compress-end backward to avoid splitting a tool-call/result group. */
  private _alignBoundaryBackward(messages: Message[], idx: number): number {
    if (idx <= 0 || idx >= messages.length) return idx;
    let check = idx - 1;
    while (check >= 0 && messages[check].role === "tool") check--;
    if (
      check >= 0 &&
      messages[check].role === "assistant" &&
      messages[check].tool_calls?.length
    ) {
      idx = check;
    }
    return idx;
  }

  /** Walk backward from end with a token budget; returns tail-start index. */
  private _findTailCut(messages: Message[], headEnd: number): number {
    const n = messages.length;
    const minTail = this.protectLastN;
    let accumulated = 0;
    let cutIdx = n;

    for (let i = n - 1; i >= headEnd; i--) {
      const msgTokens = estimateTokens(messages[i]);
      if (accumulated + msgTokens > this.tailTokenBudget && n - i >= minTail) {
        break;
      }
      accumulated += msgTokens;
      cutIdx = i;
    }

    const fallbackCut = n - minTail;
    if (cutIdx > fallbackCut) cutIdx = fallbackCut;
    if (cutIdx <= headEnd) cutIdx = fallbackCut;
    cutIdx = this._alignBoundaryBackward(messages, cutIdx);
    return Math.max(cutIdx, headEnd + 1);
  }

  private _withSummaryPrefix(summary: string): string {
    let text = (summary ?? "").trim();
    if (text.startsWith(SUMMARY_PREFIX)) {
      text = text.slice(SUMMARY_PREFIX.length).trimStart();
    }
    return text ? `${SUMMARY_PREFIX}\n${text}` : SUMMARY_PREFIX;
  }

  private _sanitizeToolPairs(messages: Message[]): Message[] {
    const survivingCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) survivingCallIds.add(tc.id);
      }
    }

    const resultCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        resultCallIds.add(msg.tool_call_id);
      }
    }

    const orphanedResults = new Set<string>();
    for (const id of resultCallIds) {
      if (!survivingCallIds.has(id)) orphanedResults.add(id);
    }
    if (orphanedResults.size > 0) {
      messages = messages.filter(
        (m) =>
          !(
            m.role === "tool" &&
            m.tool_call_id &&
            orphanedResults.has(m.tool_call_id)
          ),
      );
    }

    const finalResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        finalResultIds.add(msg.tool_call_id);
      }
    }
    const missingResults = new Set<string>();
    for (const id of survivingCallIds) {
      if (!finalResultIds.has(id)) missingResults.add(id);
    }

    if (missingResults.size > 0) {
      const patched: Message[] = [];
      for (const msg of messages) {
        patched.push(msg);
        if (msg.role === "assistant" && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (missingResults.has(tc.id)) {
              patched.push({
                role: "tool",
                content:
                  "[Result from earlier conversation — see context summary above]",
                tool_call_id: tc.id,
              });
            }
          }
        }
      }
      messages = patched;
    }

    return messages;
  }
}

// Keep imported symbol available for legacy consumers that re-export it.
export type { ToolCall };
