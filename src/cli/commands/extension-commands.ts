/**
 * Extension commands: /plugins and /mcp — list loaded plugins and MCP servers.
 */

import type { CommandDef } from "./registry.js";

export const pluginsCommand: CommandDef = {
  name: "plugins",
  description: "List loaded plugins; enable/disable persists across restarts",
  category: "Tools & Skills",
  aliases: [],
  argsHint: "[list|enable <name>|disable <name>]",
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || "list";

    if (sub === "enable" || sub === "disable") {
      const name = parts[1];
      if (!name) {
        ctx.output(`Usage: /plugins ${sub} <name>`);
        return;
      }
      const { setPluginEnabled } = await import("../toggles.js");
      setPluginEnabled(name, sub === "enable");
      ctx.output(
        `Plugin "${name}" ${sub === "enable" ? "enabled" : "disabled"} — restart to apply.`,
      );
      return;
    }

    const plugins = ctx.loadedPlugins ?? [];
    if (plugins.length === 0) {
      ctx.output("No plugins loaded.");
      return;
    }
    ctx.output(`Loaded plugins (${plugins.length}):\n`);
    for (const p of plugins) {
      const caps = Object.entries(p.capabilities)
        .filter(([, v]) => v && v.length > 0)
        .map(([k, v]) => `${k}: ${v!.join(", ")}`)
        .join("; ");
      ctx.output(`  ${p.name} v${p.version} — ${p.description}`);
      if (caps) {
        ctx.output(`    Capabilities: ${caps}`);
      }
    }
  },
};

export const mcpCommand: CommandDef = {
  name: "mcp",
  description: "List connected MCP servers with tool counts",
  category: "Tools & Skills",
  aliases: [],
  handler: async (_args, ctx) => {
    const servers = ctx.connectedMcpServers ?? [];
    if (servers.length === 0) {
      ctx.output("No MCP servers connected.");
      return;
    }
    ctx.output(`Connected MCP servers (${servers.length}):\n`);
    for (const s of servers) {
      ctx.output(`  ${s.name} — ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`);
    }
  },
};
