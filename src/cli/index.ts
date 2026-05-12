#!/usr/bin/env node

/**
 * CLI entry point — parse args and dispatch to the appropriate command.
 */

export { InterruptController } from "./interrupt.js";

import { parseMcpArgs, type McpAction } from "./mcp-args.js";
import { parsePairingArgs, type PairingAction } from "./pairing-args.js";
import { parseWebhookArgs, type WebhookAction } from "./webhook.js";
import { parseProfileArgs, type ProfileAction } from "./profiles.js";
import { resolveProfileDir } from "../core/profiles.js";

// ── Arg parsing ─────────────────────────────────────────────────────────

const SUBCOMMANDS = new Set([
  "setup",
  "doctor",
  "sessions",
  "gateway",
  "serve",
  "plugins",
  "tools",
  "mcp",
  "memory",
  "auth",
  "skills",
  "hooks",
  "cron",
  "insights",
  "pairing",
  "webhook",
  "profile",
  "acp",
  "onboard",
]);

export type CronAction =
  | { kind: "list" }
  | { kind: "create"; cronExpr: string; prompt: string }
  | { kind: "edit"; id: string; cronExpr?: string; prompt?: string }
  | { kind: "pause"; id: string }
  | { kind: "resume"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "status" };

export type SessionsAction =
  | { kind: "list" }
  | { kind: "stats"; sessionId?: string }
  | { kind: "rename"; id: string; title: string }
  | { kind: "delete"; id: string }
  | { kind: "prune"; olderThan?: string; empty?: boolean }
  | { kind: "export"; id: string; format: "jsonl" | "md" }
  | { kind: "browse" }
  | { kind: "checkpoint-list"; sessionId: string }
  | { kind: "checkpoint-resume"; sessionId: string; checkpointId: string };

export type ParsedArgs =
  | { command: "help" }
  | { command: "repl"; planMode?: boolean }
  | { command: "oneshot"; prompt: string }
  | { command: "setup" }
  | { command: "doctor" }
  | { command: "sessions"; action: SessionsAction }
  | { command: "plugins"; action?: { kind: "enable" | "disable"; name: string } }
  | { command: "tools"; action: { kind: "list" } | { kind: "enable" | "disable"; name: string } }
  | { command: "cron"; action: CronAction }
  | { command: "hooks"; action: { kind: "list" } | { kind: "test"; toolName: string } | { kind: "add"; phase: string; matcher: string; cmd: string } }
  | { command: "mcp"; action?: McpAction }
  | { command: "auth"; rest: string }
  | { command: "skills"; rest: string }
  | { command: "memory"; action: "list" | "add" | "remove" | "backend"; rest: string }
  | { command: "tasks"; action: "list" | "run" | "show"; rest: string }
  | { command: "gateway"; action: "start" | "status" | "stop" }
  | { command: "serve"; port?: number }
  | { command: "insights"; sessionId?: string; last?: string }
  | { command: "pairing"; action: PairingAction }
  | { command: "webhook"; action: WebhookAction }
  | { command: "profile"; action: ProfileAction }
  | { command: "acp" }
  | { command: "onboard"; agentName?: string; chainType?: string };

/**
 * Pull the global `--profile <name>` flag out of argv (mutating the array)
 * and return the chosen profile name. Returns undefined when not present.
 *
 * `args` is treated as the user-arg portion (no node / script entries).
 */
export function extractProfileFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--profile");
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--profile requires a name");
  }
  args.splice(idx, 2);
  return value;
}

/**
 * Strip `--profile <name>` from a full process.argv (`[node, script, ...userArgs]`)
 * by mutating the array in-place. Returns the profile name when found.
 */
export function stripProfileFlag(argv: string[]): string | undefined {
  const userArgs = argv.slice(2);
  const profile = extractProfileFlag(userArgs);
  if (profile === undefined) return undefined;
  // Rebuild argv with the stripped user args. splice(2) removes existing user
  // entries; pushing rebuilt list keeps the [node, script, ...] shape intact.
  argv.splice(2, argv.length - 2, ...userArgs);
  return profile;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { command: "help" };
  }

  if (args.length === 0) {
    return { command: "repl" };
  }

  // --plan flag: start REPL in plan mode
  if (args.length === 1 && args[0] === "--plan") {
    return { command: "repl", planMode: true };
  }

  const first = args[0];

  if (first === "plugins") {
    const sub = args[1];
    if (sub === "enable" || sub === "disable") {
      const name = args[2];
      if (!name) {
        console.error(`Usage: plugins ${sub} <name>`);
        process.exit(1);
      }
      return { command: "plugins", action: { kind: sub, name } };
    }
    return { command: "plugins" };
  }

  if (first === "hooks") {
    const sub = args[1] ?? "list";
    if (sub === "test") {
      const toolName = args[2];
      if (!toolName) {
        console.error("Usage: hooks test <toolName>");
        process.exit(1);
      }
      return { command: "hooks", action: { kind: "test", toolName } };
    }
    if (sub === "add") {
      const phase = args[2];
      const matcher = args[3];
      const cmd = args.slice(4).join(" ");
      if (!phase || !matcher || !cmd) {
        console.error("Usage: hooks add <preToolUse|postToolUse|stop> <toolMatcher> <command>");
        process.exit(1);
      }
      return { command: "hooks", action: { kind: "add", phase, matcher, cmd } };
    }
    return { command: "hooks", action: { kind: "list" } };
  }

  if (first === "cron") {
    return { command: "cron", action: parseCronArgs(args.slice(1)) };
  }

  if (first === "tools") {
    const sub = args[1];
    if (sub === "enable" || sub === "disable") {
      const name = args[2];
      if (!name) {
        console.error(`Usage: tools ${sub} <name>`);
        process.exit(1);
      }
      return { command: "tools", action: { kind: sub, name } };
    }
    return { command: "tools", action: { kind: "list" } };
  }

  if (first === "mcp") {
    if (args.length === 1) {
      return { command: "mcp" };
    }
    try {
      return { command: "mcp", action: parseMcpArgs(args.slice(1)) };
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (first === "auth") {
    return { command: "auth", rest: args.slice(1).join(" ") };
  }

  if (first === "skills") {
    return { command: "skills", rest: args.slice(1).join(" ") };
  }

  if (first === "memory") {
    const action = (args[1] ?? "list") as "list" | "add" | "remove" | "backend";
    const rest = args.slice(2).join(" ");
    return { command: "memory", action, rest };
  }

  if (first === "serve") {
    let port: number | undefined;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10);
    }
    return { command: "serve", port };
  }

  if (first === "gateway") {
    const action = (args[1] ?? "status") as "start" | "status" | "stop";
    return { command: "gateway", action };
  }

  if (first === "tasks") {
    const action = (args[1] ?? "list") as "list" | "run" | "show";
    const rest = args.slice(2).join(" ");
    return { command: "tasks", action, rest };
  }

  if (first === "sessions") {
    return { command: "sessions", action: parseSessionsArgs(args.slice(1)) };
  }

  if (first === "insights") {
    let sessionId: string | undefined;
    let last: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--session" && args[i + 1]) {
        sessionId = args[++i];
      } else if (args[i] === "--last" && args[i + 1]) {
        last = args[++i];
      } else if (!sessionId && !args[i].startsWith("--")) {
        sessionId = args[i];
      }
    }
    return { command: "insights", sessionId, last };
  }

  if (first === "pairing") {
    try {
      return { command: "pairing", action: parsePairingArgs(args.slice(1)) };
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (first === "webhook") {
    try {
      return { command: "webhook", action: parseWebhookArgs(args.slice(1)) };
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (first === "profile") {
    try {
      return { command: "profile", action: parseProfileArgs(args.slice(1)) };
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (first === "acp") {
    return { command: "acp" };
  }

  if (first === "onboard") {
    let agentName: string | undefined;
    let chainType: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--chain" && args[i + 1]) {
        chainType = args[++i];
      } else if (!agentName && !args[i].startsWith("--")) {
        agentName = args[i];
      }
    }
    return { command: "onboard", agentName, chainType };
  }

  if (SUBCOMMANDS.has(first)) {
    return { command: first as "setup" | "doctor" };
  }

  // Everything else is a one-shot prompt
  return { command: "oneshot", prompt: args.join(" ") };
}

async function runHooksCommand(
  action:
    | { kind: "list" }
    | { kind: "test"; toolName: string }
    | { kind: "add"; phase: string; matcher: string; cmd: string },
): Promise<void> {
  const { listUserHooks, addUserHook, testUserHook } = await import("./hooks-cli.js");
  switch (action.kind) {
    case "list":
      listUserHooks();
      return;
    case "test":
      await testUserHook(action.toolName);
      return;
    case "add":
      addUserHook(action.phase, action.matcher, action.cmd);
      return;
  }
}

function parseCronArgs(args: string[]): CronAction {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };
    case "create": {
      const cronExpr = args[1] ?? "";
      const prompt = args.slice(2).join(" ");
      if (!cronExpr || !prompt) {
        console.error("Usage: cron create <expr> <prompt>");
        process.exit(1);
      }
      return { kind: "create", cronExpr, prompt };
    }
    case "edit": {
      const id = args[1] ?? "";
      if (!id) {
        console.error("Usage: cron edit <id> [--cron <expr>] [--prompt <text>]");
        process.exit(1);
      }
      let cronExpr: string | undefined;
      let prompt: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--cron" && args[i + 1]) {
          cronExpr = args[++i];
        } else if (args[i] === "--prompt") {
          prompt = args.slice(i + 1).join(" ");
          i = args.length;
        }
      }
      if (!cronExpr && !prompt) {
        console.error("cron edit: provide --cron <expr> and/or --prompt <text>");
        process.exit(1);
      }
      return { kind: "edit", id, cronExpr, prompt };
    }
    case "pause":
    case "resume":
    case "remove": {
      const id = args[1] ?? "";
      if (!id) {
        console.error(`Usage: cron ${sub} <id>`);
        process.exit(1);
      }
      return { kind: sub, id };
    }
    case "status":
      return { kind: "status" };
    default:
      console.error(`Unknown cron subcommand: ${sub}`);
      console.error("Valid: list, create, edit, pause, resume, remove, status");
      process.exit(1);
  }
}

function parseSessionsArgs(args: string[]): SessionsAction {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };
    case "stats":
      return { kind: "stats", sessionId: args[1] };
    case "rename": {
      const id = args[1] ?? "";
      const title = args.slice(2).join(" ");
      if (!id || !title) {
        console.error("Usage: sessions rename <id> <title>");
        process.exit(1);
      }
      return { kind: "rename", id, title };
    }
    case "delete": {
      const id = args[1] ?? "";
      if (!id) {
        console.error("Usage: sessions delete <id>");
        process.exit(1);
      }
      return { kind: "delete", id };
    }
    case "prune": {
      let olderThan: string | undefined;
      let empty = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--older-than" && args[i + 1]) {
          olderThan = args[++i];
        } else if (args[i] === "--empty") {
          empty = true;
        }
      }
      if (!olderThan && !empty) {
        console.error("Usage: sessions prune [--older-than 30d] [--empty]");
        process.exit(1);
      }
      return { kind: "prune", olderThan, empty };
    }
    case "export": {
      let format: "jsonl" | "md" = "jsonl";
      let id = "";
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--format" && args[i + 1]) {
          const f = args[++i];
          if (f !== "jsonl" && f !== "md") {
            console.error("--format must be jsonl or md");
            process.exit(1);
          }
          format = f;
        } else if (!id) {
          id = args[i];
        }
      }
      if (!id) {
        console.error("Usage: sessions export [--format jsonl|md] <id>");
        process.exit(1);
      }
      return { kind: "export", id, format };
    }
    case "browse":
      return { kind: "browse" };
    case "checkpoint": {
      const sub2 = args[1];
      if (sub2 === "list") {
        const sessionId = args[2] ?? "";
        if (!sessionId) {
          console.error("Usage: sessions checkpoint list <session-id>");
          process.exit(1);
        }
        return { kind: "checkpoint-list", sessionId };
      }
      if (sub2 === "resume") {
        const sessionId = args[2] ?? "";
        const checkpointId = args[3] ?? "";
        if (!sessionId || !checkpointId) {
          console.error("Usage: sessions checkpoint resume <session-id> <checkpoint-id>");
          process.exit(1);
        }
        return { kind: "checkpoint-resume", sessionId, checkpointId };
      }
      console.error("Usage: sessions checkpoint <list|resume> ...");
      process.exit(1);
    }
    default:
      console.error(`Unknown sessions subcommand: ${sub}`);
      console.error(
        "Valid: list, stats, rename, delete, prune, export, browse, checkpoint",
      );
      process.exit(1);
  }
}

async function runCronCommand(action: CronAction): Promise<void> {
  const cron = await import("./cron.js");
  switch (action.kind) {
    case "list": cron.cronList(); return;
    case "create": cron.cronCreate(action.cronExpr, action.prompt); return;
    case "edit": cron.cronEdit(action.id, { cron: action.cronExpr, prompt: action.prompt }); return;
    case "pause": cron.cronPause(action.id); return;
    case "resume": cron.cronResume(action.id); return;
    case "remove": cron.cronRemove(action.id); return;
    case "status": cron.cronStatus(); return;
  }
}

async function runSessionsCommand(action: SessionsAction): Promise<void> {
  const sess = await import("./sessions.js");
  switch (action.kind) {
    case "list":
      sess.printSessionSummaries(sess.listSessionSummaries());
      return;
    case "stats": {
      const usage = action.sessionId
        ? sess.getSessionTokenUsage(action.sessionId)
        : sess.getAggregateTokenUsage();
      const model = action.sessionId
        ? sess.listSessions().find((s) => s.id === action.sessionId)?.model ?? null
        : null;
      sess.printSessionStats(action.sessionId ?? "all sessions", usage, model);
      return;
    }
    case "rename":
      sess.renameSession(action.id, action.title);
      return;
    case "delete":
      sess.deleteSession(action.id);
      return;
    case "prune":
      sess.pruneSessions({ olderThan: action.olderThan, empty: action.empty });
      return;
    case "export":
      sess.exportSession(action.id, action.format);
      return;
    case "browse":
      await sess.browseSessions();
      return;
    case "checkpoint-list":
      sess.printCheckpoints(action.sessionId, sess.listCheckpoints(action.sessionId));
      return;
    case "checkpoint-resume": {
      try {
        const { sessionId } = sess.restoreCheckpoint(action.checkpointId);
        console.log(`\nCheckpoint restored as new session: ${sessionId}`);
        console.log(`\nResume with:\n  purrfect --resume ${sessionId}\n`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
  }
}

async function runToolsCommand(
  action: { kind: "list" } | { kind: "enable" | "disable"; name: string },
): Promise<void> {
  const { listToolEnablement, setToolEnabled } = await import("./toggles.js");
  if (action.kind === "list") {
    const rows = listToolEnablement();
    if (rows.length === 0) {
      console.log("No tool overrides set in config.");
      return;
    }
    console.log("\nTool enablement overrides:\n");
    for (const r of rows) {
      console.log(`  ${r.enabled ? "[on] " : "[off]"} ${r.name}`);
    }
    console.log();
    return;
  }
  setToolEnabled(action.name, action.kind === "enable");
  console.log(
    `Tool "${action.name}" ${action.kind === "enable" ? "enabled" : "disabled"}.`,
  );
}

async function runPluginToggle(action: {
  kind: "enable" | "disable";
  name: string;
}): Promise<void> {
  const { setPluginEnabled } = await import("./toggles.js");
  setPluginEnabled(action.name, action.kind === "enable");
  console.log(
    `Plugin "${action.name}" ${action.kind === "enable" ? "enabled" : "disabled"}.`,
  );
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Apply --profile <name> globally before any subcommand resolves config dirs.
  // Strip the flag from process.argv so downstream parseArgs() does not see it.
  try {
    const profileOverride = stripProfileFlag(process.argv);
    if (profileOverride) {
      process.env.PURRFECT_PROFILE = profileOverride;
    }
    if (process.env.PURRFECT_PROFILE) {
      const { dir } = resolveProfileDir({ profileOverride: process.env.PURRFECT_PROFILE });
      process.env.PURRFECT_CONFIG_DIR = dir;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case "help": {
      const { printUsage } = await import("./help.js");
      printUsage();
      break;
    }
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      break;
    }
    case "doctor": {
      const { runDoctor, printDoctorResults } = await import("./doctor.js");
      const results = await runDoctor();
      printDoctorResults(results);
      break;
    }
    case "sessions": {
      await runSessionsCommand(parsed.action);
      break;
    }
    case "insights": {
      const { runInsightsCommand } = await import("./insights.js");
      runInsightsCommand({ sessionId: parsed.sessionId, last: parsed.last });
      break;
    }
    case "pairing": {
      const { runPairingCommand } = await import("./pairing.js");
      try {
        runPairingCommand(parsed.action);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }
    case "webhook": {
      const { runWebhookCommand } = await import("./webhook.js");
      try {
        await runWebhookCommand(parsed.action);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }
    case "profile": {
      const { runProfileCommand } = await import("./profiles.js");
      try {
        runProfileCommand(parsed.action);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }
    case "acp": {
      const { startAcpServer } = await import("./acp.js");
      await startAcpServer();
      // Keep process alive — server lifecycle bound to stdin EOF / SIGTERM
      await new Promise(() => {});
      break;
    }
    case "onboard": {
      const { runOnboard } = await import("./onboard.js");
      try {
        await runOnboard({ agentName: parsed.agentName, chainType: parsed.chainType });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }
    case "tools": {
      await runToolsCommand(parsed.action);
      break;
    }
    case "cron": {
      await runCronCommand(parsed.action);
      break;
    }
    case "hooks": {
      await runHooksCommand(parsed.action);
      break;
    }
    case "plugins": {
      if (parsed.action) {
        await runPluginToggle(parsed.action);
        break;
      }
      const { pluginsCommand } = await import("./commands/extension-commands.js");
      const { loadConfigV2, defaultConfigDir } = await import("./config.js");
      const { PluginDiscovery } = await import("../core/plugins/discovery.js");
      const { PluginLoader } = await import("../core/plugins/loader.js");
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { HookRegistry } = await import("../core/plugins/hooks.js");

      const configDir = defaultConfigDir();
      const config = loadConfigV2(configDir);
      const pluginDirs: string[] = (config as any).pluginDirs ?? [];
      const loadedPlugins: Array<{ name: string; version: string; description: string; capabilities: Record<string, string[] | undefined> }> = [];

      if (pluginDirs.length > 0) {
        const manifests = await PluginDiscovery.scan(pluginDirs);
        const loader = new PluginLoader();
        const toolRegistry = new ToolRegistry();
        const hookRegistry = new HookRegistry();
        for (const manifest of manifests) {
          try {
            await loader.load(manifest, toolRegistry, hookRegistry);
            loadedPlugins.push({
              name: manifest.name,
              version: manifest.version,
              description: manifest.description,
              capabilities: manifest.capabilities as Record<string, string[] | undefined>,
            });
          } catch { /* skip broken plugins */ }
        }
      }

      await pluginsCommand.handler("", {
        config,
        loadedPlugins,
        output: (text: string) => console.log(text),
      });
      break;
    }
    case "mcp": {
      const { runMcpCommand } = await import("./mcp.js");
      try {
        await runMcpCommand(parsed.action ?? { kind: "list" });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }
    case "auth": {
      const { authCommand } = await import("./auth.js");
      const { defaultConfigDir } = await import("./config.js");
      await authCommand(parsed.rest, {
        configDir: defaultConfigDir(),
        output: (text: string) => console.log(text),
      });
      break;
    }
    case "skills": {
      const { skillsCommand } = await import("./skills.js");
      const { defaultConfigDir } = await import("./config.js");
      await skillsCommand(parsed.rest, {
        configDir: defaultConfigDir(),
        output: (text: string) => console.log(text),
      });
      break;
    }
    case "memory": {
      const { memoryCommand } = await import("./commands/memory-commands.js");
      const { loadConfigV2, defaultConfigDir } = await import("./config.js");
      const { join } = await import("node:path");

      const configDir = defaultConfigDir();
      const config = loadConfigV2(configDir);
      const memoriesDir = config.memoriesDir ?? join(configDir, "memories");

      const actionArgs = parsed.action === "list" ? "list"
        : parsed.rest ? `${parsed.action} ${parsed.rest}` : parsed.action;

      await memoryCommand.handler(actionArgs, {
        config,
        memoriesDir,
        output: (text: string) => console.log(text),
      });
      break;
    }
    case "tasks": {
      const { formatTaskList, formatTaskOutput, readTaskOutputLines } = await import("./tasks.js");
      const { join } = await import("node:path");
      const { defaultConfigDir } = await import("./config.js");
      const { TaskStore } = await import("../core/tasks/store.js");
      const { TaskRunner } = await import("../core/tasks/runner.js");

      const configDir = defaultConfigDir();
      const storePath = join(configDir, "tasks.json");
      const outputDir = join(configDir, "tasks");
      const store = new TaskStore(storePath);

      if (parsed.action === "run") {
        if (!parsed.rest) {
          console.error("Usage: purrfect tasks run <prompt>");
          process.exit(1);
        }
        const runner = new TaskRunner(store, outputDir, undefined, configDir);
        const task = runner.create(parsed.rest);
        runner.spawn(task.id);
        console.log(`Task ${task.id} started.`);
      } else if (parsed.action === "show") {
        if (!parsed.rest) {
          console.error("Usage: purrfect tasks show <id>");
          process.exit(1);
        }
        const taskId = parsed.rest.trim();
        const task = store.get(taskId);
        if (!task) {
          // Try prefix match
          const all = store.list();
          const matches = all.filter((t) => t.id.startsWith(taskId));
          if (matches.length === 1) {
            const outputLines = readTaskOutputLines(join(outputDir, matches[0].id, "output.jsonl"));
            console.log(formatTaskOutput(matches[0], outputLines));
          } else if (matches.length > 1) {
            console.error(`Ambiguous task id "${taskId}" — matches ${matches.length} tasks.`);
            process.exit(1);
          } else {
            console.error(`Task not found: ${taskId}`);
            process.exit(1);
          }
        } else {
          const outputLines = readTaskOutputLines(join(outputDir, task.id, "output.jsonl"));
          console.log(formatTaskOutput(task, outputLines));
        }
      } else {
        // list (default)
        const tasks = store.list();
        console.log(formatTaskList(tasks));
      }
      break;
    }
    case "serve": {
      const { createServer } = await import("../server/index.js");
      const port = parsed.port ?? 3000;
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { registerBuiltins } = await import("../core/tools/index.js");
      const { HttpProvider } = await import("../core/provider.js");
      const { loadConfigV2, defaultConfigDir } = await import("./config.js");
      const { join } = await import("node:path");
      const { McpClient } = await import("../core/mcp/client.js");
      const { PluginDiscovery } = await import("../core/plugins/discovery.js");
      const { PluginLoader } = await import("../core/plugins/loader.js");
      const { HookRegistry } = await import("../core/plugins/hooks.js");
      const { CredentialPool } = await import("../core/credential-pool.js");

      const configDir = defaultConfigDir();
      const config = loadConfigV2(configDir);
      const { SessionStore } = await import("../core/session-store.js");
      const sessionStore = new SessionStore(join(configDir, "server-sessions.db"));
      const { resolveApiKey } = await import("../core/secrets.js");
      const providerType = (config.providerType ?? "openai") as "openai" | "anthropic";
      const credentialPool = new CredentialPool({ path: join(configDir, "credentials.json") });
      const apiKey = resolveApiKey(config.apiKey, providerType) ?? "";
      const provider = new HttpProvider({
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey,
        model: config.model ?? "gpt-4o",
        credentialPool,
        providerType,
      });
      const toolRegistry = new ToolRegistry();
      registerBuiltins(toolRegistry, {
        sessionStore,
        provider,
        platform: "purrfect-api",
        modelName: config.model,
        sandboxMode: config.sandbox,
      });

      // Load MCP servers
      const mcpServers = (config as any).mcpServers ?? [];
      for (const server of mcpServers) {
        try {
          const client = new McpClient(toolRegistry, {
            command: server.command,
            args: server.args,
            env: server.env,
            enabledTools: server.enabledTools,
          });
          await client.connect();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`MCP server "${server.name}" unavailable: ${msg}`);
        }
      }

      // Load plugins
      const hookRegistry = new HookRegistry();
      const pluginDirs: string[] = (config as any).pluginDirs ?? [];
      if (pluginDirs.length > 0) {
        try {
          const manifests = await PluginDiscovery.scan(pluginDirs);
          const loader = new PluginLoader();
          for (const manifest of manifests) {
            try {
              await loader.load(manifest, toolRegistry, hookRegistry);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`Plugin "${manifest.name}" failed to load: ${msg}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Plugin discovery failed: ${msg}`);
        }
      }

      const providerFactory = () =>
        new HttpProvider({
          baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
          apiKey: resolveApiKey(config.apiKey, providerType) ?? "",
          model: config.model ?? "gpt-4o",
          credentialPool,
          providerType,
        });

      const token = process.env.PURRFECT_CLI_SERVER_TOKEN ?? "dev-token";

      const srv = createServer({
        token,
        providerFactory,
        streamingProviderFactory: providerFactory,
        toolRegistry,
        sessionDbPath: join(configDir, "server-sessions.db"),
      });

      srv.listen(port, () => {
        console.log(`Server listening on http://localhost:${port}`);
      });

      // Keep process alive
      await new Promise(() => {});
      break;
    }
    case "gateway": {
      if (parsed.action === "start") {
        const { startGateway } = await import("./gateway-runner.js");
        const { defaultConfigDir } = await import("./config.js");
        await startGateway(defaultConfigDir());
        // Keep process alive — shutdown is handled via SIGTERM/SIGINT
        await new Promise(() => {});
      } else if (parsed.action === "status") {
        const { existsSync, readFileSync } = await import("node:fs");
        const { defaultConfigDir } = await import("./config.js");
        const pidFile = (await import("node:path")).join(defaultConfigDir(), "gateway.pid");
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          try {
            process.kill(pid, 0); // check if alive
            console.log(`Gateway running (PID ${pid})`);
          } catch {
            console.log("Gateway not running (stale PID file)");
          }
        } else {
          console.log("Gateway not running");
        }
      } else if (parsed.action === "stop") {
        const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
        const { defaultConfigDir } = await import("./config.js");
        const pidFile = (await import("node:path")).join(defaultConfigDir(), "gateway.pid");
        if (existsSync(pidFile)) {
          const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          try {
            process.kill(pid, "SIGTERM");
            unlinkSync(pidFile);
            console.log(`Gateway stopped (sent SIGTERM to PID ${pid})`);
          } catch {
            unlinkSync(pidFile);
            console.log("Gateway was not running (cleaned up stale PID file)");
          }
        } else {
          console.log("Gateway not running");
        }
      }
      break;
    }
    case "oneshot": {
      const { runOneshot } = await import("./oneshot.js");
      await runOneshot(parsed.prompt);
      break;
    }
    case "repl": {
      const { startRepl } = await import("./repl.js");
      await startRepl(undefined, { planMode: parsed.planMode });
      break;
    }
  }
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/cli/index.js") ||
   process.argv[1].endsWith("/cli/index.ts") ||
   process.argv[1].endsWith("purrfect"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
