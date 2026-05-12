/**
 * Session continuity on resume — generates a recap of prior conversation
 * messages so the agent can maintain context across sessions.
 */

import type { StoredMessage, TodoItem } from "./session-store.js";

/** Minimal interface for reading messages — allows duck-typed stores. */
export interface SessionStoreLike {
  getMessages(sessionId: string): StoredMessage[];
  /** Optional — present on real SessionStore. Used to include outstanding todos in the recap. */
  getTodos?(sessionId: string): TodoItem[];
}

const DEFAULT_MAX_MESSAGES = 10;
const MAX_CONTENT_LENGTH = 100;

/**
 * Load the last N messages from a session and format a brief recap string.
 *
 * Returns empty string if the session has no messages or does not exist.
 */
export function generateSessionRecap(
  sessionStore: SessionStoreLike,
  sessionId: string,
  maxMessages: number = DEFAULT_MAX_MESSAGES,
): string {
  const allMessages = sessionStore.getMessages(sessionId);

  if (allMessages.length === 0) {
    return "";
  }

  const totalCount = allMessages.length;
  const tail = allMessages.slice(-maxMessages);

  const lines = tail.map((msg) => {
    const role = formatRole(msg.role);
    const content = truncate(msg.content ?? "(no content)", MAX_CONTENT_LENGTH);
    return `- ${role}: ${content}`;
  });

  const sections = [
    `Previous conversation:\n${lines.join("\n")}\n[${totalCount} messages total]`,
  ];

  // Include outstanding todos so the resumed agent can pick up where it left off.
  if (sessionStore.getTodos) {
    const todos = sessionStore.getTodos(sessionId);
    const outstanding = todos.filter((t) => t.status !== "completed");
    if (outstanding.length > 0) {
      const todoLines = todos.map((t) => {
        const marker =
          t.status === "completed"
            ? "[x]"
            : t.status === "in_progress"
              ? "[~]"
              : "[ ]";
        return `${marker} ${t.content}`;
      });
      sections.push(
        `Outstanding task list (${outstanding.length} incomplete of ${todos.length}):\n${todoLines.join(
          "\n",
        )}\nUse todo_write to update the list as you resume work.`,
      );
    }
  }

  return sections.join("\n\n");
}

function formatRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + "...";
}
