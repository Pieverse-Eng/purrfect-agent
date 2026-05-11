/**
 * Session-related commands: /new, /clear, /history
 */

import { randomUUID } from "node:crypto";
import type { CommandDef } from "./registry.js";
import { getSessionMessages } from "../sessions.js";

export const newSessionCommand: CommandDef = {
  name: "new",
  description: "Start a new session",
  category: "Session",
  aliases: [],
  handler: async (_args, ctx) => {
    const newId = randomUUID();
    if (ctx.sessionStore && ctx.sessionId) {
      ctx.sessionStore.endSession(ctx.sessionId);
      ctx.sessionStore.createSession({
        id: newId,
        model: ctx.config?.model ?? "unknown",
        source: "repl",
        title: `REPL session ${new Date().toISOString().slice(0, 19)}`,
      });
    }
    // Update the mutable sessionId on the context
    (ctx as any).sessionId = newId;
    ctx.output(`New session started (${newId.slice(0, 8)})`);
  },
};

export const clearCommand: CommandDef = {
  name: "clear",
  description: "Clear the terminal screen",
  category: "Session",
  aliases: [],
  handler: async (_args, _ctx) => {
    console.clear();
  },
};

export const historyCommand: CommandDef = {
  name: "history",
  description: "Show message history for the current session",
  category: "Session",
  aliases: [],
  argsHint: "[count]",
  handler: async (args, ctx) => {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      ctx.output("No active session.");
      return;
    }
    const maxMessages = parseInt(args.trim(), 10) || 20;
    const messages = getSessionMessages(sessionId);
    if (messages.length === 0) {
      ctx.output("No messages in current session.");
      return;
    }
    const tail = messages.slice(-maxMessages);
    ctx.output(`\nSession ${sessionId.slice(0, 8)} — ${messages.length} messages total:\n`);
    for (const msg of tail) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const text = msg.content
        ? msg.content.length > 120
          ? msg.content.slice(0, 120).replace(/\n/g, " ") + "..."
          : msg.content.replace(/\n/g, " ")
        : "(no content)";
      ctx.output(`  ${role}: ${text}`);
    }
    ctx.output("");
  },
};
