/**
 * /cost — show insights for the active session.
 */

import type { CommandDef } from "./registry.js";
import { buildInsights } from "../../core/insights.js";
import { formatInsightsReport } from "../insights.js";
import type { InsightsCommandOptions } from "../insights.js";
import type { SessionStore } from "../../core/session-store.js";

export const costCommand: CommandDef = {
  name: "cost",
  description: "Show token usage and cost for the current session",
  category: "Info",
  aliases: ["insights"],
  argsHint: "[--last 7d]",
  handler: async (args, ctx) => {
    if (!ctx.sessionId) {
      ctx.output("No active session.");
      return;
    }
    const store = ctx.sessionStore as SessionStore | undefined;
    if (!store?.listTurns) {
      ctx.output("Insights unavailable: session store missing.");
      return;
    }

    const opts: InsightsCommandOptions = { sessionId: ctx.sessionId };
    const tokens = args.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "--last" && tokens[i + 1]) {
        opts.last = tokens[++i];
      }
    }

    const sinceEpochSec = opts.last ? parseSince(opts.last) : undefined;
    const report = buildInsights(store, {
      sessionId: opts.sessionId,
      sinceEpochSec,
    });
    ctx.output(formatInsightsReport(report, opts));
  },
};

function parseSince(last: string): number | undefined {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(last.trim());
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const factors: Record<string, number> = {
    s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800,
  };
  return Date.now() / 1000 - n * factors[unit];
}
