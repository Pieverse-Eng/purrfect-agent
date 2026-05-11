/**
 * Todo commands: /todos — inspect the current session's task list.
 */

import type { CommandDef } from "./registry.js";
import { ansiColor, formatTodoList } from "../formatter.js";
import type { SessionStore } from "../../core/session-store.js";

export const todosCommand: CommandDef = {
  name: "todos",
  description: "Show the current session task list (set by todo_write)",
  category: "Session",
  aliases: ["todo"],
  handler: async (_args, ctx) => {
    const store = ctx.sessionStore as SessionStore | undefined;
    const sessionId = ctx.sessionId;

    if (!store || !sessionId) {
      ctx.output(ansiColor("No active session.", "yellow"));
      return;
    }

    const todos = store.getTodos(sessionId);
    if (todos.length === 0) {
      ctx.output(ansiColor("No todos for this session.", "gray"));
      return;
    }

    ctx.output(formatTodoList(todos));
  },
};
