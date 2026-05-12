/**
 * checkpoint_create tool — model-triggered session snapshot.
 *
 * Saves a full snapshot of the current agent state (messages, todos,
 * plan mode, token usage) so work can be resumed from this point if
 * the session is interrupted or something goes wrong.
 */

import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../types.js";
import type { SessionStore, TokenUsage, StoredMessage, TodoItem } from "../session-store.js";

export interface CheckpointCreateToolOptions {
  store: SessionStore;
  getSessionId: () => string | undefined;
  /** Returns a snapshot of the current in-flight messages (from the agent loop). */
  getMessages: () => StoredMessage[];
  /** Returns current plan-mode flag. */
  getPlanMode?: () => boolean;
  /** Returns accumulated token usage, if tracked. */
  getTokenUsage?: () => TokenUsage | null;
}

export function createCheckpointCreateTool(
  options: CheckpointCreateToolOptions,
): ToolDefinition {
  const { store, getSessionId, getMessages, getPlanMode, getTokenUsage } = options;

  return {
    name: "checkpoint_create",
    description:
      "Save a checkpoint of the current session state (messages, todos, task list). " +
      "Use before risky operations, at key milestones, or when you want to mark progress. " +
      "The session can be resumed from any checkpoint if something goes wrong.",
    schema: {
      type: "function",
      function: {
        name: "checkpoint_create",
        description:
          "Save a checkpoint of the current session state.",
        parameters: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description:
                "Optional human-readable label (e.g. 'before refactor', 'tests passing').",
            },
          },
          required: [],
        },
      },
    },
    toolset: "session",
    async handler(args) {
      const sessionId = getSessionId();
      if (!sessionId) {
        return JSON.stringify({ error: "No active session for checkpoint_create" });
      }

      const label =
        typeof args.label === "string" && args.label.trim()
          ? args.label.trim()
          : null;

      const id = randomUUID();
      const messages = getMessages();
      const todos = store.getTodos(sessionId);

      try {
        const record = store.createCheckpoint({
          id,
          session_id: sessionId,
          label,
          messages,
          todos,
          plan_mode: getPlanMode?.() ?? false,
          token_usage: getTokenUsage?.() ?? null,
          compression_meta: null,
        });

        return JSON.stringify({
          success: true,
          checkpoint_id: record.id,
          label: record.label,
          created_at: record.created_at,
          message_count: record.messages.length,
          todo_count: record.todos.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Failed to create checkpoint: ${message}` });
      }
    },
  };
}
