/**
 * Informational commands: /help, /tools, /skills, /sessions, /doctor, /info
 */

import type { CommandDef, CommandContext } from "./registry.js";
import {
  listSessions,
  listSessionSummaries,
  searchSessions,
  getSessionMessages,
  formatSessionSummaryLine,
} from "../sessions.js";
import type { SessionRecord } from "../../core/session-store.js";
import { VERSION } from "../../version.js";

export const helpCommand: CommandDef = {
  name: "help",
  description: "Show available commands or detail for a specific command",
  category: "Info",
  aliases: ["?"],
  argsHint: "[command]",
  handler: async (args, ctx) => {
    const registry = ctx.commandRegistry;
    if (!registry) {
      ctx.output("Command registry not available.");
      return;
    }

    const trimmed = args.trim();
    if (trimmed) {
      // Show detail for a single command
      const resolved = registry.resolve(`/${trimmed}`);
      if (!resolved) {
        ctx.output(`Unknown command: /${trimmed}`);
        return;
      }
      const cmd = resolved.command;
      ctx.output(`/${cmd.name}${cmd.argsHint ? " " + cmd.argsHint : ""}`);
      ctx.output(`  ${cmd.description}`);
      ctx.output(`  Category: ${cmd.category}`);
      if (cmd.aliases.length > 0) {
        ctx.output(`  Aliases: ${cmd.aliases.map((a: string) => "/" + a).join(", ")}`);
      }
      return;
    }

    // Show grouped table
    const byCategory = registry.getByCategory();
    ctx.output("Available commands:\n");
    for (const [category, cmds] of byCategory) {
      ctx.output(`  ${category}`);
      for (const cmd of cmds) {
        const aliasStr = cmd.aliases.length > 0 ? ` (${cmd.aliases.join(", ")})` : "";
        ctx.output(`    /${cmd.name}${aliasStr}  — ${cmd.description}`);
      }
      ctx.output("");
    }
  },
};

export const toolsCommand: CommandDef = {
  name: "tools",
  description: "List, enable, or disable tools",
  category: "Tools & Skills",
  aliases: [],
  argsHint: "[list|enable <name>|disable <name>]",
  handler: async (args, ctx) => {
    const reg = ctx.toolRegistry;
    if (!reg) {
      ctx.output("Tool registry not available.");
      return;
    }
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || "list";

    if (sub === "enable" || sub === "disable") {
      const name = parts[1];
      if (!name) {
        ctx.output(`Usage: /tools ${sub} <name>`);
        return;
      }
      const ok = sub === "enable" ? reg.enable?.(name) : reg.disable?.(name);
      if (!ok) {
        ctx.output(`No tool named "${name}".`);
        return;
      }
      const { setToolEnabled } = await import("../toggles.js");
      setToolEnabled(name, sub === "enable");
      ctx.output(`Tool "${name}" ${sub === "enable" ? "enabled" : "disabled"}.`);
      return;
    }

    const rows: Array<{ name: string; enabled: boolean }> =
      reg.listEnablement?.() ??
      (reg.getAllToolNames?.() ?? []).map((name: string) => ({ name, enabled: true }));
    if (rows.length === 0) {
      ctx.output("No tools registered.");
      return;
    }
    ctx.output("Available tools:\n");
    for (const r of rows) {
      const flag = r.enabled ? "[on] " : "[off]";
      ctx.output(`  ${flag} ${r.name}`);
    }
  },
};

export const skillsCommand: CommandDef = {
  name: "skills",
  description: "List available skills",
  category: "Tools & Skills",
  aliases: [],
  handler: async (_args, ctx) => {
    const skills = ctx.skillRegistry?.getAllSkills?.() ?? [];
    if (skills.length === 0) {
      ctx.output("No skills registered.");
      return;
    }
    ctx.output("Available skills:\n");
    for (const skill of skills) {
      const triggers = skill.triggers.length > 0
        ? ` (triggers: ${skill.triggers.join(", ")})`
        : "";
      const desc = skill.description ? ` — ${skill.description}` : "";
      const layer = skill.sourceLayer ? ` [${skill.sourceLayer}]` : "";
      ctx.output(`  - ${skill.name}${layer}${triggers}${desc}`);
    }
  },
};

export const sessionsCommand: CommandDef = {
  name: "sessions",
  description: "List, search, or resume sessions",
  category: "Session",
  aliases: [],
  argsHint: "[search <query> | resume <id>]",
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    // /sessions search <query>
    if (subcommand === "search") {
      const query = parts.slice(1).join(" ");
      if (!query) {
        ctx.output("Usage: /sessions search <query>");
        return;
      }
      const results = searchSessions(query);
      if (results.length === 0) {
        ctx.output("No results found.");
        return;
      }
      ctx.output(`\nSearch results (${results.length}):\n`);
      for (const r of results) {
        const date = new Date(r.timestamp * 1000).toISOString().slice(0, 19);
        const snippet = r.content ? r.content.slice(0, 80).replace(/\n/g, " ") : "";
        ctx.output(`  [${r.session_id.slice(0, 8)}] ${r.role} ${date}  ${snippet}`);
      }
      ctx.output("");
      return;
    }

    // /sessions resume <id>
    if (subcommand === "resume") {
      const idPrefix = parts[1];
      if (!idPrefix) {
        ctx.output("Usage: /sessions resume <id>");
        return;
      }
      const allSessions = listSessions();
      const match = allSessions.find((s) => s.id.startsWith(idPrefix));
      if (!match) {
        ctx.output(`No session found matching "${idPrefix}".`);
        return;
      }
      const messages = getSessionMessages(match.id);
      // Store resumeSessionId on the context for the REPL to pick up
      (ctx as any).resumeSessionId = match.id;
      // Checkpoint-restored sessions carry full message history — use full injection
      // rather than the truncated recap so no context is lost on resume.
      if (match.source === "checkpoint-resume") {
        (ctx as any).fullResumeMessages = true;
      }
      ctx.output(`Resumed session ${match.id.slice(0, 8)} (${messages.length} messages)`);
      return;
    }

    // /sessions — list all
    const summaries = listSessionSummaries();
    if (summaries.length === 0) {
      ctx.output("No sessions found.");
      return;
    }
    ctx.output("\nSessions:\n");
    for (const summary of summaries) {
      ctx.output(formatSessionSummaryLine(summary));
    }
    ctx.output("");
  },
};

export const doctorCommand: CommandDef = {
  name: "doctor",
  description: "Run diagnostic checks on the CLI environment",
  category: "Info",
  aliases: [],
  handler: async (_args, ctx) => {
    ctx.output("Running diagnostics...");
    ctx.output("Doctor command not yet wired to runDoctor().");
  },
};

const replStartTime = Date.now();

export const infoCommand: CommandDef = {
  name: "info",
  description: "Show session stats: ID, message count, model, uptime",
  category: "Info",
  aliases: [],
  handler: async (_args, ctx) => {
    const sessionId = ctx.sessionId ?? "unknown";
    const model = ctx.config?.model ?? "unknown";

    let messageCount = 0;
    if (ctx.sessionId) {
      try {
        const msgs = getSessionMessages(ctx.sessionId);
        messageCount = msgs.length;
      } catch {
        // session messages unavailable
      }
    }

    const uptimeMs = Date.now() - replStartTime;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(uptimeSec / 60);
    const seconds = uptimeSec % 60;
    const uptimeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    ctx.output(`purrfect v${VERSION}`);
    ctx.output(`Session: ${sessionId.slice(0, 8)}`);
    ctx.output(`Messages: ${messageCount}`);
    ctx.output(`Model: ${model}`);
    ctx.output(`Uptime: ${uptimeStr}`);
    ctx.output(`Node: ${process.version}`);
  },
};
