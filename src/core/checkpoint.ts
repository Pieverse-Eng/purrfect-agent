/**
 * Concrete CheckpointManager — bridges AgentLoop auto-triggers to SessionStore.
 *
 * Implements the CheckpointManagerLike interface expected by AgentLoop so that
 * auto-checkpoints (every N iterations, pre-compression, post-delegate) are
 * persisted to the SQLite sessions database.
 */

import { randomUUID } from "node:crypto";
import type { Message } from "./types.js";
import type { SessionStore, TodoItem, TokenUsage } from "./session-store.js";
import type { CheckpointManagerLike } from "./agent-loop.js";

export interface CheckpointManagerOptions {
  store: SessionStore;
  sessionId: string;
  /** Returns current todos for the session. Defaults to reading from store. */
  getTodos?: () => TodoItem[];
  /** Returns current plan-mode flag. */
  getPlanMode?: () => boolean;
  /** Returns accumulated token usage. */
  getTokenUsage?: () => TokenUsage | null;
}

export class CheckpointManager implements CheckpointManagerLike {
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly getTodos: () => TodoItem[];
  private readonly getPlanMode: () => boolean;
  private readonly getTokenUsage: () => TokenUsage | null;

  constructor(options: CheckpointManagerOptions) {
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.getTodos = options.getTodos ?? (() => this.store.getTodos(this.sessionId));
    this.getPlanMode = options.getPlanMode ?? (() => false);
    this.getTokenUsage = options.getTokenUsage ?? (() => null);
  }

  save(
    trigger: "auto" | "pre_compression" | "post_delegate",
    messages: Message[],
    compressionMeta?: { original_message_count: number },
  ): void {
    try {
      const storedMessages = messages.map((m, idx) => ({
        id: idx + 1,
        session_id: this.sessionId,
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
        timestamp: Date.now() / 1000,
      }));

      const label = trigger === "pre_compression"
        ? "pre-compression snapshot"
        : trigger === "post_delegate"
          ? "post-delegate snapshot"
          : undefined;

      this.store.createCheckpoint({
        id: randomUUID(),
        session_id: this.sessionId,
        label: label ?? null,
        messages: storedMessages,
        todos: this.getTodos(),
        plan_mode: this.getPlanMode(),
        token_usage: this.getTokenUsage(),
        compression_meta: compressionMeta
          ? {
              compressed_at: Date.now() / 1000,
              original_message_count: compressionMeta.original_message_count,
              compressed_message_count: 0, // filled after compression completes
            }
          : null,
      });
    } catch {
      // Best-effort: checkpoint failures must never crash the agent loop
    }
  }
}
