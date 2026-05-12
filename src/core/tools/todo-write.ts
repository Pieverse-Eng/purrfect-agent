import type { ToolDefinition } from "../types.js";
import type { SessionStore, TodoItem, TodoStatus } from "../session-store.js";

export interface TodoWriteToolOptions {
  store: SessionStore;
  getSessionId: () => string | undefined;
}

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(no todos)";
  return todos
    .map((t) => `${STATUS_GLYPH[t.status]} ${t.content}`)
    .join("\n");
}

function parseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new Error("`todos` must be an array");
  }
  const result: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") {
      throw new Error(`todos[${i}] must be an object`);
    }
    const content = item.content;
    const status = item.status;
    const activeForm = item.activeForm;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`todos[${i}].content must be a non-empty string`);
    }
    if (typeof status !== "string" || !VALID_STATUSES.has(status as TodoStatus)) {
      throw new Error(
        `todos[${i}].status must be one of pending|in_progress|completed`,
      );
    }
    // activeForm is only rendered while a task is in_progress, so it is only
    // strictly required for that state. For pending/completed items we fall
    // back to content — this matches how lenient models typically emit the
    // field and avoids rejecting otherwise-valid payloads.
    let activeFormValue: string;
    if (typeof activeForm === "string" && activeForm.trim().length > 0) {
      activeFormValue = activeForm.trim();
    } else if (status === "in_progress") {
      throw new Error(
        `todos[${i}].activeForm must be a non-empty string when status is 'in_progress'`,
      );
    } else {
      activeFormValue = content.trim();
    }
    result.push({
      content: content.trim(),
      status: status as TodoStatus,
      activeForm: activeFormValue,
    });
  }

  const inProgressCount = result.filter((t) => t.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new Error("At most one todo may have status 'in_progress'");
  }

  return result;
}

/**
 * Factory that creates a todo_write tool bound to a SessionStore and a
 * late-binding session id resolver.
 *
 * The tool replaces the session's entire todo list each call. Callers pass the
 * full updated list; there is no partial/patch semantics. This mirrors the
 * Hermes TodoWrite / Claude Code TodoWrite contract and keeps state predictable.
 */
export function createTodoWriteTool(
  options: TodoWriteToolOptions,
): ToolDefinition {
  const { store, getSessionId } = options;

  return {
    name: "todo_write",
    description:
      "Create or update the session's task list. Pass the FULL updated list each call. " +
      "Use for multi-step work (3+ steps). Mark exactly one task as in_progress at a time; " +
      "mark tasks completed as soon as they're done.",
    schema: {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "Create or update the session's task list. Pass the FULL updated list each call.",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "The complete updated todo list.",
              items: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description: "Imperative task description (e.g. 'Run tests').",
                  },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed"],
                    description: "Current task status.",
                  },
                  activeForm: {
                    type: "string",
                    description:
                      "Present-continuous form shown while in_progress (e.g. 'Running tests'). " +
                      "Required when status='in_progress'; optional otherwise (defaults to content).",
                  },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["todos"],
        },
      },
    },
    toolset: "session",
    async handler(args) {
      const sessionId = getSessionId();
      if (!sessionId) {
        return JSON.stringify({ error: "No active session for todo_write" });
      }

      let todos: TodoItem[];
      try {
        todos = parseTodos(args.todos);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }

      try {
        store.setTodos(sessionId, todos);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `Failed to persist todos: ${message}` });
      }

      const counts = {
        pending: todos.filter((t) => t.status === "pending").length,
        in_progress: todos.filter((t) => t.status === "in_progress").length,
        completed: todos.filter((t) => t.status === "completed").length,
        total: todos.length,
      };

      return JSON.stringify({
        success: true,
        counts,
        todos,
        rendered: renderTodos(todos),
      });
    },
  };
}
