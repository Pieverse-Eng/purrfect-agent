/**
 * SQLite-backed session persistence with FTS5 search.
 *
 * Provides session CRUD, message storage, full-text search, and session
 * chaining via parent_session_id. Uses WAL mode for concurrent access.
 *
 * Mirrors hermes-agent/hermes_state.py patterns adapted for TypeScript.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { SessionStoreError } from "./errors.js";
import type { ModelTier, ModelTierUsageMap } from "./model-routing.js";
import { createEmptyTierUsage } from "./model-routing.js";

// ── Schema ──────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    model TEXT,
    source TEXT NOT NULL,
    title TEXT,
    parent_session_id TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    reasoning TEXT,
    timestamp REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS session_todos (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    todos TEXT NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_usage (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_model_tier_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    tier TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (session_id, tier)
);

CREATE TABLE IF NOT EXISTS session_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    model TEXT,
    model_tier TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    latency_ms INTEGER,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_turns_session ON session_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_turns_created ON session_turns(created_at DESC);

CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    label TEXT,
    created_at REAL NOT NULL,
    messages TEXT NOT NULL,
    todos TEXT NOT NULL,
    plan_mode INTEGER NOT NULL DEFAULT 0,
    token_usage TEXT,
    compression_meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at DESC);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

// ── Types ───────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  model: string | null;
  source: string;
  title: string | null;
  parent_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateSessionOptions {
  id: string;
  model: string;
  source: string;
  title?: string;
  parent_session_id?: string;
}

export interface StoredMessage {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  tool_name?: string;
  reasoning?: string;
  timestamp: number;
}

interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AppendMessageOptions {
  role: string;
  content: string | null;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  tool_name?: string;
  reasoning?: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export interface SearchResult {
  message_id: number;
  session_id: string;
  role: string;
  content: string | null;
  timestamp: number;
}

// ── Checkpoint types ─────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  model_tier?: ModelTier;
}

export interface SessionTokenUsage extends TokenUsage {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  requests: number;
  model_tiers?: ModelTierUsageMap;
}

export interface SessionSummary {
  id: string;
  model: string | null;
  source: string;
  title: string | null;
  parent_session_id: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  requests: number;
}

export interface TurnRecordOptions {
  session_id: string;
  model?: string | null;
  model_tier?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number | null;
  latency_ms?: number | null;
}

export interface TurnRecord {
  id: number;
  session_id: string;
  model: string | null;
  model_tier: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: number;
}

export interface CompressionMeta {
  compressed_at: number;
  original_message_count: number;
  compressed_message_count: number;
}

export interface CheckpointRecord {
  id: string;
  session_id: string;
  label: string | null;
  created_at: number;
  messages: StoredMessage[];
  todos: TodoItem[];
  plan_mode: boolean;
  token_usage: TokenUsage | null;
  compression_meta: CompressionMeta | null;
}

export interface CheckpointSummary {
  id: string;
  session_id: string;
  label: string | null;
  created_at: number;
  message_count: number;
  todo_count: number;
}

export interface CreateCheckpointOptions {
  id: string;
  session_id: string;
  label?: string | null;
  messages: StoredMessage[];
  todos: TodoItem[];
  plan_mode?: boolean;
  token_usage?: TokenUsage | null;
  compression_meta?: CompressionMeta | null;
}

interface ModelTierUsageRow {
  tier: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

function rowsToTierUsage(rows: ModelTierUsageRow[]): ModelTierUsageMap {
  const usage = createEmptyTierUsage();
  for (const row of rows) {
    if (row.tier !== "fast" && row.tier !== "balanced" && row.tier !== "deep") {
      continue;
    }
    usage[row.tier] = {
      requests: row.requests,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    };
  }
  return usage;
}

function hasTierUsage(usage: ModelTierUsageMap): boolean {
  return usage.fast.requests > 0 ||
    usage.balanced.requests > 0 ||
    usage.deep.requests > 0;
}

// ── Concurrency helpers ─────────────────────────────────────────────────

const BUSY_RETRY_LIMIT = 15;
const BUSY_BASE_JITTER_MS = 20;
const BUSY_MAX_JITTER_MS = 150;
const BUSY_TIMEOUT_MS = 1000;
const CHECKPOINT_INTERVAL = 50;

export function isSqliteBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") {
    return false;
  }
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_BUSY_RECOVERY" ||
    code === "SQLITE_BUSY_TIMEOUT" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_LOCKED_SHAREDCACHE"
  );
}

function sleepSync(ms: number): void {
  // Synchronous sleep so retry logic can stay in better-sqlite3's sync API.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, Math.max(1, ms));
}

export interface RetryBusyOptions {
  maxAttempts?: number;
  minJitterMs?: number;
  maxJitterMs?: number;
  sleep?: (ms: number) => void;
}

export function retryOnBusy<T>(fn: () => T, options: RetryBusyOptions = {}): T {
  const maxAttempts = options.maxAttempts ?? BUSY_RETRY_LIMIT;
  const minJitter = options.minJitterMs ?? BUSY_BASE_JITTER_MS;
  const maxJitter = options.maxJitterMs ?? BUSY_MAX_JITTER_MS;
  const snooze = options.sleep ?? sleepSync;
  const spread = Math.max(1, maxJitter - minJitter);

  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= maxAttempts) {
        throw err;
      }
      snooze(minJitter + Math.floor(Math.random() * spread));
      attempt++;
    }
  }
}

// ── SessionStore ────────────────────────────────────────────────────────

export class SessionStore {
  private db: DatabaseType;
  private writeCount = 0;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SessionStoreError(
          `Failed to create parent directory for database at ${dbPath}: ${msg}`,
          { cause: err },
        );
      }
    }

    try {
      this.db = new Database(dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SessionStoreError(
        `Failed to open database at ${dbPath}: ${msg}`,
        { cause: err },
      );
    }

    // WAL mode for concurrent access
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Keep the built-in busy handler short; application-level retry with
    // random jitter handles contention without convoy effects.
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    this.initSchema();
  }

  private withRetry<T>(fn: () => T): T {
    return retryOnBusy(fn);
  }

  /**
   * Run a multi-statement write block atomically with busy-retry.
   *
   * Each retry must restart from a clean slate — without a transaction, a
   * partial success (e.g. message INSERT lands but the timestamp UPDATE
   * hits SQLITE_BUSY) would be silently re-applied on the next attempt,
   * duplicating rows or double-counting upserts. IMMEDIATE acquires the
   * write lock at BEGIN so contention surfaces up front instead of at
   * COMMIT, and any throw inside `fn` triggers ROLLBACK before retry.
   */
  private withAtomicRetry(fn: () => void): void {
    const tx = this.db.transaction(fn);
    this.withRetry(() => {
      tx.immediate();
    });
  }

  private noteWrite(): void {
    this.writeCount++;
    if (this.writeCount >= CHECKPOINT_INTERVAL) {
      this.writeCount = 0;
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        // Best effort — checkpoint failure should not fail the write.
      }
    }
  }

  // ── Schema ──

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);

    // Check/set schema version
    const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;

    if (row === undefined) {
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        SCHEMA_VERSION,
      );
    }
    // Future migrations would go here (if row.version < 2, etc.)

    // FTS5 setup — check if table exists first
    try {
      this.db.prepare("SELECT * FROM messages_fts LIMIT 0").run();
    } catch {
      this.db.exec(FTS_SQL);
    }
  }

  // ── Session lifecycle ──

  createSession(options: CreateSessionOptions): string {
    const now = Date.now() / 1000;
    this.withRetry(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, model, source, title, parent_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          options.id,
          options.model,
          options.source,
          options.title ?? null,
          options.parent_session_id ?? null,
          now,
          now,
        );
    });
    this.noteWrite();
    return options.id;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  endSession(id: string): void {
    const now = Date.now() / 1000;
    this.withRetry(() => {
      this.db
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, id);
    });
    this.noteWrite();
  }

  updateSessionTitle(id: string, title: string): void {
    const now = Date.now() / 1000;
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, now, id);
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
      .all() as SessionRecord[];
  }

  /**
   * Like {@link listSessions} but also joins in message/tool-call counts and
   * aggregated token usage. Used by the `/sessions` CLI listing so operators
   * can see, at a glance, which sessions used the most budget.
   */
  listSessionSummaries(): SessionSummary[] {
    return this.db
      .prepare(
        `SELECT
           s.id,
           s.model,
           s.source,
           s.title,
           s.parent_session_id,
           s.created_at,
           s.updated_at,
           COALESCE(msg.message_count, 0) AS message_count,
           COALESCE(msg.tool_call_count, 0) AS tool_call_count,
           COALESCE(u.input_tokens, 0) AS input_tokens,
           COALESCE(u.output_tokens, 0) AS output_tokens,
           COALESCE(u.cache_read_input_tokens, 0) AS cache_read_input_tokens,
           COALESCE(u.cache_creation_input_tokens, 0) AS cache_creation_input_tokens,
           COALESCE(u.requests, 0) AS requests
         FROM sessions s
         LEFT JOIN (
           SELECT session_id,
                  COUNT(*) AS message_count,
                  SUM(CASE WHEN tool_calls IS NOT NULL OR role = 'tool' THEN 1 ELSE 0 END) AS tool_call_count
           FROM messages
           GROUP BY session_id
         ) msg ON msg.session_id = s.id
         LEFT JOIN session_usage u ON u.session_id = s.id
         ORDER BY s.created_at DESC`,
      )
      .all() as SessionSummary[];
  }

  deleteSession(id: string): void {
    this.withAtomicRetry(() => {
      // Delete messages first (FTS triggers handle FTS cleanup)
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_todos WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_usage WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_model_tier_usage WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_turns WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
    this.noteWrite();
  }

  // ── Todos ──

  getTodos(sessionId: string): TodoItem[] {
    const row = this.db
      .prepare("SELECT todos FROM session_todos WHERE session_id = ?")
      .get(sessionId) as { todos: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.todos) as unknown;
      return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
    } catch {
      return [];
    }
  }

  setTodos(sessionId: string, todos: TodoItem[]): void {
    const now = Date.now() / 1000;
    this.withRetry(() => {
      this.db
        .prepare(
          `INSERT INTO session_todos (session_id, todos, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET todos = excluded.todos, updated_at = excluded.updated_at`,
        )
        .run(sessionId, JSON.stringify(todos), now);
    });
    this.noteWrite();
  }

  // ── Messages ──

  appendMessage(sessionId: string, message: AppendMessageOptions): void {
    const now = Date.now() / 1000;
    this.withAtomicRetry(() => {
      this.db
        .prepare(
          `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tool_name, reasoning, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          message.role,
          message.content,
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id ?? null,
          message.tool_name ?? null,
          message.reasoning ?? null,
          now,
        );

      // Update session timestamp
      this.db
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(now, sessionId);
    });
    this.noteWrite();
  }

  getMessages(sessionId: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
      )
      .all(sessionId) as Array<{
      id: number;
      session_id: string;
      role: string;
      content: string | null;
      tool_calls: string | null;
      tool_call_id: string | null;
      tool_name: string | null;
      reasoning: string | null;
      timestamp: number;
    }>;

    return rows.map((row) => {
      const msg: StoredMessage = {
        id: row.id,
        session_id: row.session_id,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
      };
      if (row.tool_calls) {
        msg.tool_calls = JSON.parse(row.tool_calls) as ToolCallRecord[];
      }
      if (row.tool_call_id) {
        msg.tool_call_id = row.tool_call_id;
      }
      if (row.tool_name) {
        msg.tool_name = row.tool_name;
      }
      if (row.reasoning) {
        msg.reasoning = row.reasoning;
      }
      return msg;
    });
  }

  // ── Token usage ──

  recordTokenUsage(sessionId: string, usage: TokenUsage): void {
    const now = Date.now() / 1000;
    this.withAtomicRetry(() => {
      this.db
        .prepare(
          `INSERT INTO session_usage (
             session_id, input_tokens, output_tokens, cache_read_input_tokens,
             cache_creation_input_tokens, requests, updated_at
           )
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
             cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
             requests = requests + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          sessionId,
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_read_input_tokens ?? 0,
          usage.cache_creation_input_tokens ?? 0,
          now,
        );

      if (usage.model_tier) {
        this.db
          .prepare(
            `INSERT INTO session_model_tier_usage (
               session_id, tier, input_tokens, output_tokens, requests, updated_at
             )
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(session_id, tier) DO UPDATE SET
               input_tokens = input_tokens + excluded.input_tokens,
               output_tokens = output_tokens + excluded.output_tokens,
               requests = requests + 1,
               updated_at = excluded.updated_at`,
          )
          .run(
            sessionId,
            usage.model_tier,
            usage.input_tokens,
            usage.output_tokens,
            now,
          );
      }
    });
    this.noteWrite();
  }

  getTokenUsage(sessionId: string): SessionTokenUsage | null {
    const row = this.db
      .prepare(
        `SELECT input_tokens, output_tokens, cache_read_input_tokens,
                cache_creation_input_tokens, requests
         FROM session_usage WHERE session_id = ?`,
      )
      .get(sessionId) as SessionTokenUsage | undefined;

    if (!row) return null;
    const modelTiers = this.getTierUsage(sessionId);
    return {
      ...row,
      ...(hasTierUsage(modelTiers) ? { model_tiers: modelTiers } : {}),
    };
  }

  getAggregateTokenUsage(): SessionTokenUsage | null {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
           COALESCE(SUM(requests), 0) AS requests
         FROM session_usage`,
      )
      .get() as SessionTokenUsage | undefined;

    if (!row || row.requests === 0) return null;
    const modelTiers = this.getAggregateTierUsage();
    return {
      ...row,
      ...(hasTierUsage(modelTiers) ? { model_tiers: modelTiers } : {}),
    };
  }

  // ── Per-turn insights ──

  recordTurn(turn: TurnRecordOptions): void {
    const now = Date.now() / 1000;
    this.withRetry(() => {
      this.db
        .prepare(
          `INSERT INTO session_turns (
             session_id, model, model_tier, input_tokens, output_tokens,
             cache_read_input_tokens, cache_creation_input_tokens,
             cost_usd, latency_ms, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turn.session_id,
          turn.model ?? null,
          turn.model_tier ?? null,
          turn.input_tokens,
          turn.output_tokens,
          turn.cache_read_input_tokens ?? 0,
          turn.cache_creation_input_tokens ?? 0,
          turn.cost_usd ?? null,
          turn.latency_ms ?? null,
          now,
        );
    });
    this.noteWrite();
  }

  listTurns(sessionId: string): TurnRecord[] {
    return this.db
      .prepare(
        `SELECT id, session_id, model, model_tier, input_tokens, output_tokens,
                cache_read_input_tokens, cache_creation_input_tokens,
                cost_usd, latency_ms, created_at
         FROM session_turns
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as TurnRecord[];
  }

  /**
   * List turns globally, optionally filtered by `since` timestamp (epoch
   * seconds). Sorted oldest-to-newest so callers can stream / paginate.
   */
  listTurnsSince(sinceEpochSec?: number): TurnRecord[] {
    if (sinceEpochSec === undefined) {
      return this.db
        .prepare(
          `SELECT id, session_id, model, model_tier, input_tokens, output_tokens,
                  cache_read_input_tokens, cache_creation_input_tokens,
                  cost_usd, latency_ms, created_at
           FROM session_turns
           ORDER BY created_at ASC, id ASC`,
        )
        .all() as TurnRecord[];
    }
    return this.db
      .prepare(
        `SELECT id, session_id, model, model_tier, input_tokens, output_tokens,
                cache_read_input_tokens, cache_creation_input_tokens,
                cost_usd, latency_ms, created_at
         FROM session_turns
         WHERE created_at >= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sinceEpochSec) as TurnRecord[];
  }

  private getTierUsage(sessionId: string): ModelTierUsageMap {
    const rows = this.db
      .prepare(
        `SELECT tier, input_tokens, output_tokens, requests
         FROM session_model_tier_usage WHERE session_id = ?`,
      )
      .all(sessionId) as Array<ModelTierUsageRow>;
    return rowsToTierUsage(rows);
  }

  private getAggregateTierUsage(): ModelTierUsageMap {
    const rows = this.db
      .prepare(
        `SELECT tier,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(requests), 0) AS requests
         FROM session_model_tier_usage
         GROUP BY tier`,
      )
      .all() as Array<ModelTierUsageRow>;
    return rowsToTierUsage(rows);
  }

  // ── FTS5 Search ──

  search(query: string): SearchResult[] {
    if (!query || !query.trim()) {
      return [];
    }

    const sanitized = SessionStore.sanitizeFts5Query(query);
    if (!sanitized) {
      return [];
    }

    try {
      return this.db
        .prepare(
          `SELECT m.id AS message_id, m.session_id, m.role, m.content, m.timestamp
           FROM messages m
           JOIN messages_fts ON messages_fts.rowid = m.id
           WHERE messages_fts MATCH ?
           ORDER BY messages_fts.rank`,
        )
        .all(sanitized) as SearchResult[];
    } catch {
      // If the sanitized query still causes an FTS5 error, return empty
      return [];
    }
  }

  /**
   * Sanitize user input for safe use in FTS5 MATCH queries.
   *
   * Strategy (mirrors hermes_state.py):
   * - Preserve properly paired quoted phrases
   * - Strip unmatched FTS5-special characters
   * - Wrap unquoted hyphenated terms in quotes
   */
  static sanitizeFts5Query(query: string): string {
    // Step 1: Extract balanced double-quoted phrases and protect them
    const quotedParts: string[] = [];
    const preserveQuoted = (_match: string): string => {
      quotedParts.push(_match);
      return `\x00Q${quotedParts.length - 1}\x00`;
    };

    let sanitized = query.replace(/"[^"]*"/g, preserveQuoted);

    // Step 2: Strip remaining (unmatched) FTS5-special characters
    sanitized = sanitized.replace(/[+{}()"^]/g, " ");

    // Step 3: Collapse repeated * and remove leading *
    sanitized = sanitized.replace(/\*+/g, "*");
    sanitized = sanitized.replace(/(^|\s)\*/g, "$1");

    // Step 4: Remove dangling boolean operators at start/end
    sanitized = sanitized.trim();
    sanitized = sanitized.replace(/^(AND|OR|NOT)\b\s*/i, "");
    sanitized = sanitized.trim();
    sanitized = sanitized.replace(/\s+(AND|OR|NOT)\s*$/i, "");
    sanitized = sanitized.trim();

    // Step 5: Wrap unquoted hyphenated terms in double quotes
    sanitized = sanitized.replace(/\b(\w+(?:-\w+)+)\b/g, '"$1"');

    // Step 6: Restore preserved quoted phrases
    for (let i = 0; i < quotedParts.length; i++) {
      sanitized = sanitized.replace(`\x00Q${i}\x00`, quotedParts[i]);
    }

    return sanitized.trim();
  }

  // ── Checkpoints ──

  createCheckpoint(options: CreateCheckpointOptions): CheckpointRecord {
    const now = Date.now() / 1000;
    this.withRetry(() => {
      this.db
        .prepare(
          `INSERT INTO checkpoints (id, session_id, label, created_at, messages, todos, plan_mode, token_usage, compression_meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          options.id,
          options.session_id,
          options.label ?? null,
          now,
          JSON.stringify(options.messages),
          JSON.stringify(options.todos),
          options.plan_mode ? 1 : 0,
          options.token_usage ? JSON.stringify(options.token_usage) : null,
          options.compression_meta ? JSON.stringify(options.compression_meta) : null,
        );
    });
    this.noteWrite();

    return {
      id: options.id,
      session_id: options.session_id,
      label: options.label ?? null,
      created_at: now,
      messages: options.messages,
      todos: options.todos,
      plan_mode: options.plan_mode ?? false,
      token_usage: options.token_usage ?? null,
      compression_meta: options.compression_meta ?? null,
    };
  }

  getCheckpoint(id: string): CheckpointRecord | null {
    const row = this.db
      .prepare("SELECT * FROM checkpoints WHERE id = ?")
      .get(id) as RawCheckpointRow | undefined;
    if (!row) return null;
    return this.deserializeCheckpoint(row);
  }

  listCheckpoints(sessionId: string): CheckpointSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, label, created_at, messages, todos
         FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      label: string | null;
      created_at: number;
      messages: string;
      todos: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      label: row.label,
      created_at: row.created_at,
      message_count: (JSON.parse(row.messages) as unknown[]).length,
      todo_count: (JSON.parse(row.todos) as unknown[]).length,
    }));
  }

  deleteCheckpoints(sessionId: string): void {
    this.withRetry(() => {
      this.db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(sessionId);
    });
    this.noteWrite();
  }

  private deserializeCheckpoint(row: RawCheckpointRow): CheckpointRecord {
    return {
      id: row.id,
      session_id: row.session_id,
      label: row.label,
      created_at: row.created_at,
      messages: JSON.parse(row.messages) as StoredMessage[],
      todos: JSON.parse(row.todos) as TodoItem[],
      plan_mode: row.plan_mode !== 0,
      token_usage: row.token_usage ? (JSON.parse(row.token_usage) as TokenUsage) : null,
      compression_meta: row.compression_meta
        ? (JSON.parse(row.compression_meta) as CompressionMeta)
        : null,
    };
  }

  // ── Cleanup ──

  close(): void {
    if (this.db) {
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch {
        // Best effort
      }
      this.db.close();
    }
  }
}

interface RawCheckpointRow {
  id: string;
  session_id: string;
  label: string | null;
  created_at: number;
  messages: string;
  todos: string;
  plan_mode: number;
  token_usage: string | null;
  compression_meta: string | null;
}
