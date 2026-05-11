/**
 * Insights aggregation over per-turn records (`session_turns` table).
 *
 * Computes session-level and global usage breakdowns: tokens, cost, latency,
 * cache hit rate, and per-model rollups. Used by the `purrfect insights` CLI
 * command and the REPL `/cost` command.
 */

import type { SessionStore, TurnRecord } from "./session-store.js";
import { estimateCostUsd } from "./model-metadata.js";

export interface InsightsTotals {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
  latency_ms_total: number;
  latency_ms_avg: number;
  cache_hit_rate: number;
}

export interface ModelBreakdown extends InsightsTotals {
  model: string;
}

export interface SessionBreakdown extends InsightsTotals {
  session_id: string;
}

export interface InsightsReport {
  totals: InsightsTotals;
  by_model: ModelBreakdown[];
  by_session: SessionBreakdown[];
  /** Sorted oldest → newest. Empty when filter has no matches. */
  turns: TurnRecord[];
}

/**
 * Parse a `--last` window like `7d`, `12h`, `30m` into epoch-second cutoff.
 * Returns `undefined` when input is missing or unparseable so callers can
 * fall back to "all turns".
 */
export function parseLastWindowSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(value.trim());
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const factors: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3_600,
    d: 86_400,
    w: 604_800,
  };
  const seconds = n * factors[unit];
  return Date.now() / 1000 - seconds;
}

function emptyTotals(): InsightsTotals {
  return {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0,
    latency_ms_total: 0,
    latency_ms_avg: 0,
    cache_hit_rate: 0,
  };
}

function accumulate(target: InsightsTotals, turn: TurnRecord): void {
  target.turns += 1;
  target.input_tokens += turn.input_tokens;
  target.output_tokens += turn.output_tokens;
  target.cache_read_input_tokens += turn.cache_read_input_tokens;
  target.cache_creation_input_tokens += turn.cache_creation_input_tokens;
  if (turn.cost_usd !== null) {
    target.cost_usd += turn.cost_usd;
  } else {
    // Fall back to live pricing lookup if the recorded cost is unknown.
    const fallback = estimateCostUsd(turn.model, {
      input_tokens: turn.input_tokens,
      output_tokens: turn.output_tokens,
      cache_read_input_tokens: turn.cache_read_input_tokens,
      cache_creation_input_tokens: turn.cache_creation_input_tokens,
    });
    if (fallback !== null) target.cost_usd += fallback;
  }
  if (turn.latency_ms !== null) {
    target.latency_ms_total += turn.latency_ms;
  }
}

function finalize(totals: InsightsTotals): InsightsTotals {
  totals.latency_ms_avg = totals.turns > 0 ? totals.latency_ms_total / totals.turns : 0;
  const cacheTotal = totals.cache_read_input_tokens + totals.cache_creation_input_tokens;
  totals.cache_hit_rate = cacheTotal > 0 ? totals.cache_read_input_tokens / cacheTotal : 0;
  return totals;
}

export interface InsightsOptions {
  sessionId?: string;
  /** Epoch seconds. Turns older than this are excluded. */
  sinceEpochSec?: number;
}

/**
 * Pure aggregation over a list of turn records. Exposed for tests so the
 * report can be exercised without touching SQLite.
 */
export function aggregateTurns(turns: TurnRecord[]): InsightsReport {
  const overall = emptyTotals();
  const byModel = new Map<string, InsightsTotals>();
  const bySession = new Map<string, InsightsTotals>();

  for (const turn of turns) {
    accumulate(overall, turn);

    const modelKey = turn.model ?? "unknown";
    let modelBucket = byModel.get(modelKey);
    if (!modelBucket) {
      modelBucket = emptyTotals();
      byModel.set(modelKey, modelBucket);
    }
    accumulate(modelBucket, turn);

    let sessionBucket = bySession.get(turn.session_id);
    if (!sessionBucket) {
      sessionBucket = emptyTotals();
      bySession.set(turn.session_id, sessionBucket);
    }
    accumulate(sessionBucket, turn);
  }

  finalize(overall);
  for (const bucket of byModel.values()) finalize(bucket);
  for (const bucket of bySession.values()) finalize(bucket);

  return {
    totals: overall,
    by_model: [...byModel.entries()].map(([model, b]) => ({ model, ...b })),
    by_session: [...bySession.entries()].map(([session_id, b]) => ({ session_id, ...b })),
    turns,
  };
}

/**
 * Produce an InsightsReport from a SessionStore, optionally filtered by
 * session id and/or a relative time window.
 */
export function buildInsights(
  store: Pick<SessionStore, "listTurns" | "listTurnsSince">,
  options: InsightsOptions = {},
): InsightsReport {
  const all = options.sessionId
    ? store.listTurns(options.sessionId)
    : store.listTurnsSince(options.sinceEpochSec);
  const filtered = options.sessionId && options.sinceEpochSec !== undefined
    ? all.filter((t) => t.created_at >= options.sinceEpochSec!)
    : all;
  return aggregateTurns(filtered);
}
