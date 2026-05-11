/**
 * CLI surface for managing MCP servers: list / test / add / remove / configure.
 *
 * Mirrors the hermes `mcp` subcommand. Stores state in the v2 config under
 * `mcpServers[]`. Tools-per-server filtering uses an `enabledTools?: string[]`
 * list on each server entry.
 */

import * as readline from "node:readline";
import { loadConfigV2, saveConfigV2, defaultConfigDir } from "./config.js";
import type { Config, McpServerConfig } from "../core/config-schema.js";
import {
  probeMcpServer,
  type McpProbeFailure,
  type McpProbeResult,
  type McpProbeTool,
} from "../core/mcp/client.js";
import type { McpAction } from "./mcp-args.js";
export { parseMcpArgs, type McpAction } from "./mcp-args.js";

export interface McpCommandContext {
  configDir?: string;
  /** Inject a fake probe for tests. */
  probe?: typeof probeMcpServer;
  /** Inject readline interface for tests; defaults to process.stdin/stdout. */
  ask?: (prompt: string) => Promise<string>;
  output?: (text: string) => void;
}

const log = (ctx: McpCommandContext) =>
  ctx.output ?? ((text: string) => console.log(text));

function loadServers(configDir: string): { config: Config; servers: McpServerConfig[] } {
  const config = loadConfigV2(configDir);
  return { config, servers: config.mcpServers ?? [] };
}

function findServer(servers: McpServerConfig[], name: string): McpServerConfig | undefined {
  return servers.find((s) => s.name === name);
}

function persist(config: Config, servers: McpServerConfig[], configDir: string): void {
  const next: Config = { ...config, mcpServers: servers };
  saveConfigV2(next, configDir);
}

// ── list ──────────────────────────────────────────────────────────────

export function mcpList(ctx: McpCommandContext = {}): void {
  const out = log(ctx);
  const dir = ctx.configDir ?? defaultConfigDir();
  const { servers } = loadServers(dir);

  if (servers.length === 0) {
    out("No MCP servers configured. Use `purrfect mcp add <name> --command <cmd>` to add one.");
    return;
  }

  out(`MCP servers (${servers.length}):`);
  for (const s of servers) {
    const argList = s.args && s.args.length > 0 ? ` ${s.args.join(" ")}` : "";
    const tools = s.enabledTools
      ? `enabled tools: ${s.enabledTools.length > 0 ? s.enabledTools.join(", ") : "(none — server disabled)"}`
      : "enabled tools: all";
    out(`  ${s.name}`);
    out(`    command: ${s.command}${argList}`);
    out(`    ${tools}`);
  }
}

// ── add ───────────────────────────────────────────────────────────────

export function mcpAdd(
  action: Extract<McpAction, { kind: "add" }>,
  ctx: McpCommandContext = {},
): void {
  const out = log(ctx);
  const dir = ctx.configDir ?? defaultConfigDir();
  const { config, servers } = loadServers(dir);

  if (findServer(servers, action.name)) {
    throw new Error(
      `MCP server "${action.name}" already exists. Use \`mcp remove ${action.name}\` first.`,
    );
  }

  const server: McpServerConfig = {
    name: action.name,
    command: action.command,
    ...(action.args && action.args.length > 0 ? { args: action.args } : {}),
    ...(action.env && Object.keys(action.env).length > 0 ? { env: action.env } : {}),
  };

  persist(config, [...servers, server], dir);
  out(`Added MCP server "${action.name}".`);
}

// ── remove ────────────────────────────────────────────────────────────

export function mcpRemove(
  action: Extract<McpAction, { kind: "remove" }>,
  ctx: McpCommandContext = {},
): void {
  const out = log(ctx);
  const dir = ctx.configDir ?? defaultConfigDir();
  const { config, servers } = loadServers(dir);

  if (!findServer(servers, action.name)) {
    throw new Error(`MCP server "${action.name}" not found.`);
  }

  const next = servers.filter((s) => s.name !== action.name);
  persist(config, next, dir);
  out(`Removed MCP server "${action.name}".`);
}

// ── test ──────────────────────────────────────────────────────────────

export async function mcpTest(
  action: Extract<McpAction, { kind: "test" }>,
  ctx: McpCommandContext = {},
): Promise<McpProbeResult | McpProbeFailure> {
  const out = log(ctx);
  const dir = ctx.configDir ?? defaultConfigDir();
  const { servers } = loadServers(dir);
  const server = findServer(servers, action.name);
  if (!server) {
    throw new Error(`MCP server "${action.name}" not found.`);
  }

  out(`Testing MCP server "${server.name}"…`);
  const probe = ctx.probe ?? probeMcpServer;
  const result = await probe({
    command: server.command,
    args: server.args,
    env: server.env,
  });

  if (!result.ok) {
    out(`✖ Failed in ${result.elapsed_ms}ms: ${result.error}`);
    return result;
  }

  out(`✔ Connected in ${result.elapsed_ms}ms — ${result.tools.length} tool${
    result.tools.length === 1 ? "" : "s"
  }:`);
  for (const t of result.tools) {
    const desc = t.description ? ` — ${t.description.slice(0, 80)}` : "";
    out(`    ${t.name}${desc}`);
  }
  return result;
}

// ── configure ─────────────────────────────────────────────────────────

/**
 * Apply a tool-enablement decision to the server entry.
 *
 * - `tools = undefined`  → reset to "expose all tools"
 * - `tools = []`         → server effectively disabled (no tools exposed)
 * - `tools = [...]`      → only those names are exposed
 *
 * Pure helper so unit tests can verify the merge without spinning up readline.
 */
export function applyEnabledTools(
  server: McpServerConfig,
  tools: string[] | undefined,
): McpServerConfig {
  if (tools === undefined) {
    const { enabledTools, ...rest } = server;
    return rest;
  }
  return { ...server, enabledTools: tools };
}

export async function mcpConfigure(
  action: Extract<McpAction, { kind: "configure" }>,
  ctx: McpCommandContext = {},
): Promise<void> {
  const out = log(ctx);
  const dir = ctx.configDir ?? defaultConfigDir();
  const { config, servers } = loadServers(dir);
  const server = findServer(servers, action.name);
  if (!server) {
    throw new Error(`MCP server "${action.name}" not found.`);
  }

  // Non-interactive paths first: --enable foo,bar / --disable
  if (action.disable) {
    const next = servers.map((s) =>
      s.name === server.name ? applyEnabledTools(s, []) : s,
    );
    persist(config, next, dir);
    out(`Disabled all tools for "${server.name}".`);
    return;
  }
  if (action.enableTools !== undefined) {
    const next = servers.map((s) =>
      s.name === server.name ? applyEnabledTools(s, action.enableTools) : s,
    );
    persist(config, next, dir);
    out(`Updated enabled tools for "${server.name}": ${action.enableTools.join(", ") || "(none)"}.`);
    return;
  }

  // Interactive: probe + readline numbered selection
  out(`Probing "${server.name}" for available tools…`);
  const probe = ctx.probe ?? probeMcpServer;
  const result = await probe({
    command: server.command,
    args: server.args,
    env: server.env,
  });
  if (!result.ok) {
    throw new Error(`Could not probe "${server.name}": ${result.error}`);
  }
  if (result.tools.length === 0) {
    out(`Server "${server.name}" advertises no tools.`);
    return;
  }

  printToolMenu(out, server, result.tools);

  const ask = ctx.ask ?? defaultAsk;
  const answer = (await ask(
    "Enter comma-separated tool numbers (or names), `all`, `none`, or blank to keep current:\n> ",
  )).trim();

  if (answer === "") {
    out("No change.");
    return;
  }

  let selection: string[] | undefined;
  if (answer === "all") {
    selection = undefined;
  } else if (answer === "none") {
    selection = [];
  } else {
    selection = parseSelection(answer, result.tools);
  }

  const next = servers.map((s) =>
    s.name === server.name ? applyEnabledTools(s, selection) : s,
  );
  persist(config, next, dir);
  out(
    selection === undefined
      ? `Reset "${server.name}" to expose all tools.`
      : `Updated "${server.name}" enabled tools: ${selection.join(", ") || "(none)"}.`,
  );
}

function printToolMenu(
  out: (text: string) => void,
  server: McpServerConfig,
  tools: McpProbeTool[],
): void {
  const enabled = new Set(server.enabledTools ?? tools.map((t) => t.name));
  out("");
  out(`Tools advertised by "${server.name}":`);
  tools.forEach((t, idx) => {
    const marker = enabled.has(t.name) ? "[x]" : "[ ]";
    const desc = t.description ? ` — ${t.description.slice(0, 60)}` : "";
    out(`  ${marker} ${idx + 1}. ${t.name}${desc}`);
  });
  out("");
}

export function parseSelection(input: string, tools: McpProbeTool[]): string[] {
  const validNames = new Set(tools.map((t) => t.name));
  const selected = new Set<string>();
  for (const tokenRaw of input.split(",")) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const asNumber = Number.parseInt(token, 10);
    if (
      Number.isFinite(asNumber) &&
      asNumber >= 1 &&
      asNumber <= tools.length
    ) {
      selected.add(tools[asNumber - 1].name);
      continue;
    }
    if (validNames.has(token)) {
      selected.add(token);
      continue;
    }
    throw new Error(`Unknown tool: "${token}"`);
  }
  return [...selected];
}

function defaultAsk(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runMcpCommand(
  action: McpAction,
  ctx: McpCommandContext = {},
): Promise<void> {
  switch (action.kind) {
    case "list":
      mcpList(ctx);
      return;
    case "add":
      mcpAdd(action, ctx);
      return;
    case "remove":
      mcpRemove(action, ctx);
      return;
    case "test":
      await mcpTest(action, ctx);
      return;
    case "configure":
      await mcpConfigure(action, ctx);
      return;
  }
}
