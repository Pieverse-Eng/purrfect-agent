/**
 * CLI surface for the insights / cost dashboard.
 *
 * Provides `runInsightsCommand` for the `purrfect insights` subcommand and
 * `formatInsightsReport` for printing inside the REPL `/cost` command.
 */

import { join } from "node:path";
import { defaultConfigDir } from "./config.js";
import { SessionStore } from "../core/session-store.js";
import {
  buildInsights,
  parseLastWindowSeconds,
  type InsightsReport,
  type InsightsTotals,
} from "../core/insights.js";

export interface InsightsCommandOptions {
  sessionId?: string;
  last?: string;
  configDir?: string;
}

function getDbPath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "sessions.db");
}

export function loadInsightsReport(options: InsightsCommandOptions): InsightsReport {
  const store = new SessionStore(getDbPath(options.configDir));
  try {
    return buildInsights(store, {
      sessionId: options.sessionId,
      sinceEpochSec: parseLastWindowSeconds(options.last),
    });
  } finally {
    store.close();
  }
}

export function runInsightsCommand(options: InsightsCommandOptions): void {
  const report = loadInsightsReport(options);
  console.log(formatInsightsReport(report, options));
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatCost(cost: number): string {
  if (cost < 0.01 && cost > 0) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(4)}`;
}

function formatLatency(ms: number): string {
  if (ms === 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatHitRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTotalsBlock(totals: InsightsTotals): string[] {
  if (totals.turns === 0) return ["  (no turns recorded)"];
  return [
    `  turns:        ${totals.turns}`,
    `  input:        ${formatTokens(totals.input_tokens)}`,
    `  output:       ${formatTokens(totals.output_tokens)}`,
    `  cache read:   ${formatTokens(totals.cache_read_input_tokens)}`,
    `  cache create: ${formatTokens(totals.cache_creation_input_tokens)}`,
    `  cache hit:    ${formatHitRate(totals.cache_hit_rate)}`,
    `  cost:         ${formatCost(totals.cost_usd)}`,
    `  avg latency:  ${formatLatency(totals.latency_ms_avg)}`,
  ];
}

export function formatInsightsReport(
  report: InsightsReport,
  options: InsightsCommandOptions = {},
): string {
  const lines: string[] = [];
  const scope = options.sessionId
    ? `session ${options.sessionId.slice(0, 8)}`
    : "all sessions";
  const window = options.last ? ` (last ${options.last})` : "";

  lines.push("");
  lines.push(`Insights — ${scope}${window}`);
  lines.push("");
  lines.push("Totals");
  lines.push(...formatTotalsBlock(report.totals));

  if (report.by_model.length > 0) {
    lines.push("");
    lines.push("By model");
    const sortedModels = [...report.by_model].sort((a, b) => b.cost_usd - a.cost_usd);
    for (const m of sortedModels) {
      lines.push(
        `  ${m.model.padEnd(36)} turns=${m.turns} ` +
          `tok=${formatTokens(m.input_tokens + m.output_tokens)} ` +
          `cost=${formatCost(m.cost_usd)} ` +
          `hit=${formatHitRate(m.cache_hit_rate)}`,
      );
    }
  }

  if (!options.sessionId && report.by_session.length > 0) {
    lines.push("");
    lines.push("Top sessions by cost");
    const top = [...report.by_session]
      .sort((a, b) => b.cost_usd - a.cost_usd)
      .slice(0, 10);
    for (const s of top) {
      lines.push(
        `  ${s.session_id.slice(0, 8)}  turns=${s.turns} ` +
          `tok=${formatTokens(s.input_tokens + s.output_tokens)} ` +
          `cost=${formatCost(s.cost_usd)}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}
