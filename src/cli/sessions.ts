/**
 * Session management — list, resume, search sessions via SessionStore.
 */

import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { defaultConfigDir } from "./config.js";
import { SessionStore } from "../core/session-store.js";
import type {
  SessionRecord,
  SearchResult,
  CheckpointSummary,
  CheckpointRecord,
  SessionTokenUsage,
  SessionSummary,
  StoredMessage,
} from "../core/session-store.js";
import { estimateCostUsd } from "../core/model-metadata.js";

function getDbPath(configDir?: string): string {
  const dir = configDir ?? defaultConfigDir();
  return join(dir, "sessions.db");
}

export function listSessions(configDir?: string): SessionRecord[] {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.listSessions();
  } finally {
    store.close();
  }
}

export function listSessionSummaries(configDir?: string): SessionSummary[] {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.listSessionSummaries();
  } finally {
    store.close();
  }
}

export function getSessionMessages(sessionId: string, configDir?: string) {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.getMessages(sessionId);
  } finally {
    store.close();
  }
}

export function searchSessions(query: string, configDir?: string): SearchResult[] {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.search(query);
  } finally {
    store.close();
  }
}

export function getSessionTokenUsage(
  sessionId: string,
  configDir?: string,
): SessionTokenUsage | null {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.getTokenUsage(sessionId);
  } finally {
    store.close();
  }
}

export function getAggregateTokenUsage(configDir?: string): SessionTokenUsage | null {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.getAggregateTokenUsage();
  } finally {
    store.close();
  }
}

export function printSessions(sessions: SessionRecord[]): void {
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log("\nSessions:\n");
  for (const s of sessions) {
    const date = new Date(s.created_at * 1000).toISOString().slice(0, 19);
    const title = s.title ?? "(untitled)";
    console.log(`  ${s.id.slice(0, 8)}  ${date}  ${title}`);
  }
  console.log();
}

export function formatSessionSummaryLine(summary: SessionSummary): string {
  const date = new Date(summary.created_at * 1000).toISOString().slice(0, 19);
  const title = summary.title ?? "(untitled)";
  const tokens = summary.input_tokens + summary.output_tokens;
  const cost = estimateCostUsd(summary.model, summary);
  const costPart = cost !== null ? `  $${cost.toFixed(4)}` : "  $-";
  return (
    `  ${summary.id.slice(0, 8)}  ${date}  ${title}  ` +
    `[${summary.message_count} msgs, ${summary.tool_call_count} tools, ` +
    `${tokens.toLocaleString()} tok]${costPart}`
  );
}

export function printSessionSummaries(summaries: SessionSummary[]): void {
  if (summaries.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log("\nSessions:\n");
  for (const s of summaries) {
    console.log(formatSessionSummaryLine(s));
  }
  console.log();
}

export function printSearchResults(results: SearchResult[]): void {
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`\nSearch results (${results.length}):\n`);
  for (const r of results) {
    const date = new Date(r.timestamp * 1000).toISOString().slice(0, 19);
    const snippet = r.content ? r.content.slice(0, 80).replace(/\n/g, " ") : "";
    console.log(`  [${r.session_id.slice(0, 8)}] ${date}  ${snippet}`);
  }
  console.log();
}

export function formatSessionStats(
  label: string,
  usage: SessionTokenUsage | null,
  model?: string | null,
): string {
  if (!usage) {
    return `No token usage found for ${label}.`;
  }

  const hitRate = cacheHitPercent(usage);
  const cost = estimateCostUsd(model ?? null, usage);
  const lines = [
    `Session stats (${label})`,
    `  requests=${usage.requests}`,
    `  input=${usage.input_tokens}`,
    `  output=${usage.output_tokens}`,
    `  cache read=${usage.cache_read_input_tokens}`,
    `  cache create=${usage.cache_creation_input_tokens}`,
    `  cache hit=${hitRate}%`,
  ];
  if (cost !== null) {
    lines.push(`  est. cost=$${cost.toFixed(4)}`);
  }
  lines.push(...formatModelTierStats(usage));
  return lines.join("\n");
}

export function printSessionStats(
  label: string,
  usage: SessionTokenUsage | null,
  model?: string | null,
): void {
  console.log(`\n${formatSessionStats(label, usage, model)}\n`);
}

function cacheHitPercent(usage: SessionTokenUsage): number {
  const total = usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (total === 0) return 0;
  return Math.round((usage.cache_read_input_tokens / total) * 100);
}

function formatModelTierStats(usage: SessionTokenUsage): string[] {
  const tiers = usage.model_tiers;
  if (!tiers) return [];
  const rows = (["fast", "balanced", "deep"] as const)
    .map((tier) => ({ tier, stats: tiers[tier] }))
    .filter(({ stats }) => stats.requests > 0)
    .map(
      ({ tier, stats }) =>
        `  ${tier}: requests=${stats.requests} input=${stats.input_tokens} output=${stats.output_tokens}`,
    );
  return rows.length > 0 ? ["  model tiers:", ...rows] : [];
}

// ── Checkpoint helpers ───────────────────────────────────────────────────

export function listCheckpoints(sessionId: string, configDir?: string): CheckpointSummary[] {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.listCheckpoints(sessionId);
  } finally {
    store.close();
  }
}

export function getCheckpoint(checkpointId: string, configDir?: string): CheckpointRecord | null {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    return store.getCheckpoint(checkpointId);
  } finally {
    store.close();
  }
}

/**
 * Restore a checkpoint as a new session.
 *
 * Creates a new session branched from the checkpoint's session, bulk-inserts
 * the checkpoint messages, and restores todos. Returns the new session ID.
 */
export function restoreCheckpoint(
  checkpointId: string,
  configDir?: string,
): { sessionId: string; checkpointId: string } {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    const cp = store.getCheckpoint(checkpointId);
    if (!cp) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const originalSession = store.getSession(cp.session_id);
    const newSessionId = randomUUID();

    store.createSession({
      id: newSessionId,
      model: originalSession?.model ?? "unknown",
      source: "checkpoint-resume",
      title: `Resume from ${cp.label ?? cp.id.slice(0, 8)} (${new Date(cp.created_at * 1000).toISOString().slice(0, 19)})`,
      parent_session_id: cp.session_id,
    });

    // Bulk-insert the checkpoint messages into the new session
    for (const msg of cp.messages) {
      store.appendMessage(newSessionId, {
        role: msg.role,
        content: msg.content,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
        tool_name: msg.tool_name,
        reasoning: msg.reasoning,
      });
    }

    // Restore todos
    if (cp.todos.length > 0) {
      store.setTodos(newSessionId, cp.todos);
    }

    return { sessionId: newSessionId, checkpointId };
  } finally {
    store.close();
  }
}

// ── Mutation helpers (rename / delete / prune / export / browse) ────────

function resolveSession(store: SessionStore, idPrefix: string): SessionRecord | null {
  const sessions = store.listSessions();
  return sessions.find((s) => s.id === idPrefix || s.id.startsWith(idPrefix)) ?? null;
}

export function renameSession(
  idPrefix: string,
  title: string,
  configDir?: string,
): SessionRecord | null {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    const session = resolveSession(store, idPrefix);
    if (!session) {
      console.log(`No session matching "${idPrefix}".`);
      return null;
    }
    store.updateSessionTitle(session.id, title);
    console.log(`Renamed session ${session.id.slice(0, 8)} → "${title}"`);
    return { ...session, title };
  } finally {
    store.close();
  }
}

export function deleteSession(idPrefix: string, configDir?: string): boolean {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    const session = resolveSession(store, idPrefix);
    if (!session) {
      console.log(`No session matching "${idPrefix}".`);
      return false;
    }
    store.deleteSession(session.id);
    console.log(`Deleted session ${session.id.slice(0, 8)}.`);
    return true;
  } finally {
    store.close();
  }
}

/**
 * Parse durations like "30d", "12h", "2w". Returns ms or null if unrecognized.
 */
export function parseDuration(input: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(input.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const factors: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
  };
  return n * factors[unit];
}

export interface PruneOptions {
  olderThan?: string;
  empty?: boolean;
}

export function pruneSessions(
  options: PruneOptions,
  configDir?: string,
): { deleted: string[] } {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    const summaries = store.listSessionSummaries();
    const olderThanMs = options.olderThan ? parseDuration(options.olderThan) : null;
    if (options.olderThan && olderThanMs === null) {
      console.error(
        `Invalid --older-than value: "${options.olderThan}" (use 30d, 12h, etc.)`,
      );
      process.exit(1);
    }
    const cutoffEpochSec = olderThanMs !== null
      ? (Date.now() - olderThanMs) / 1000
      : null;

    const targets = summaries.filter((s) => {
      if (options.empty && s.message_count === 0) return true;
      if (cutoffEpochSec !== null && s.updated_at < cutoffEpochSec) return true;
      return false;
    });

    for (const s of targets) {
      store.deleteSession(s.id);
    }
    console.log(`Pruned ${targets.length} session(s).`);
    return { deleted: targets.map((s) => s.id) };
  } finally {
    store.close();
  }
}

export function exportSession(
  idPrefix: string,
  format: "jsonl" | "md",
  configDir?: string,
): string | null {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    const session = resolveSession(store, idPrefix);
    if (!session) {
      console.log(`No session matching "${idPrefix}".`);
      return null;
    }
    const messages = store.getMessages(session.id);
    const dir = configDir ?? defaultConfigDir();
    const exportDir = join(dir, "exports");
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });
    const filename = `${session.id.slice(0, 8)}-${Date.now()}.${format}`;
    const outPath = join(exportDir, filename);

    if (format === "jsonl") {
      const lines = messages
        .map((m) => JSON.stringify({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
          tool_name: m.tool_name,
          timestamp: m.timestamp,
        }))
        .join("\n");
      writeFileSync(outPath, lines + "\n", "utf-8");
    } else {
      writeFileSync(outPath, formatSessionMarkdown(session, messages), "utf-8");
    }
    console.log(`Exported session ${session.id.slice(0, 8)} → ${outPath}`);
    return outPath;
  } finally {
    store.close();
  }
}

function formatSessionMarkdown(
  session: SessionRecord,
  messages: StoredMessage[],
): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id.slice(0, 8)}`);
  lines.push("");
  lines.push(`- **Title:** ${session.title ?? "(untitled)"}`);
  lines.push(`- **Model:** ${session.model ?? "(unknown)"}`);
  lines.push(`- **Source:** ${session.source}`);
  lines.push(
    `- **Created:** ${new Date(session.created_at * 1000).toISOString()}`,
  );
  lines.push("");
  lines.push("---");
  for (const m of messages) {
    lines.push("");
    lines.push(`## ${m.role}  _${new Date(m.timestamp * 1000).toISOString()}_`);
    if (m.content) {
      lines.push("");
      lines.push(m.content);
    }
    if (m.tool_calls?.length) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(m.tool_calls, null, 2));
      lines.push("```");
    }
  }
  return lines.join("\n") + "\n";
}

export async function browseSessions(configDir?: string): Promise<void> {
  const dbPath = getDbPath(configDir);
  const store = new SessionStore(dbPath);
  try {
    const summaries = store.listSessionSummaries();
    if (summaries.length === 0) {
      console.log("No sessions to browse.");
      return;
    }
    const pageSize = 10;
    let page = 0;
    const totalPages = Math.max(1, Math.ceil(summaries.length / pageSize));
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask = (q: string) =>
      new Promise<string>((resolve) => rl.question(q, resolve));

    try {
      for (;;) {
        const start = page * pageSize;
        const slice = summaries.slice(start, start + pageSize);
        console.log(`\nSessions (page ${page + 1}/${totalPages}):\n`);
        slice.forEach((s, i) => {
          console.log(`  [${start + i + 1}] ${formatSessionSummaryLine(s).trim()}`);
        });
        console.log();
        const input = (
          await ask("[n]ext / [p]rev / [number] open / [q]uit > ")
        ).trim().toLowerCase();
        if (input === "q" || input === "quit" || input === "") return;
        if (input === "n" && page < totalPages - 1) {
          page++;
          continue;
        }
        if (input === "p" && page > 0) {
          page--;
          continue;
        }
        const num = parseInt(input, 10);
        if (Number.isFinite(num) && num >= 1 && num <= summaries.length) {
          const target = summaries[num - 1];
          const messages = store.getMessages(target.id);
          console.log(`\n── Session ${target.id.slice(0, 8)} (${messages.length} msgs) ──`);
          for (const m of messages.slice(0, 50)) {
            const ts = new Date(m.timestamp * 1000).toISOString().slice(11, 19);
            const snippet = (m.content ?? "").slice(0, 200).replace(/\s+/g, " ");
            console.log(`  ${ts}  ${m.role.padEnd(9)}  ${snippet}`);
          }
          if (messages.length > 50) {
            console.log(`  ...and ${messages.length - 50} more.`);
          }
        }
      }
    } finally {
      rl.close();
    }
  } finally {
    store.close();
  }
}

export function printCheckpoints(sessionId: string, summaries: CheckpointSummary[]): void {
  if (summaries.length === 0) {
    console.log(`No checkpoints found for session ${sessionId.slice(0, 8)}.`);
    return;
  }

  console.log(`\nCheckpoints for session ${sessionId.slice(0, 8)} (${summaries.length}):\n`);
  for (const cp of summaries) {
    const date = new Date(cp.created_at * 1000).toISOString().slice(0, 19);
    const label = cp.label ? `  "${cp.label}"` : "";
    console.log(
      `  ${cp.id.slice(0, 8)}  ${date}  msgs=${cp.message_count}  todos=${cp.todo_count}${label}`,
    );
  }
  console.log();
}
