/**
 * Pure arg-parser + action types for the `purrfect mcp` subcommand.
 *
 * Kept dependency-free so the synchronous CLI parser in index.ts can
 * import it without dragging in the MCP runtime / config schema.
 */

export type McpAction =
  | { kind: "list" }
  | { kind: "test"; name: string }
  | {
      kind: "add";
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { kind: "remove"; name: string }
  | {
      kind: "configure";
      name: string;
      enableTools?: string[];
      disable?: boolean;
    };

export function parseMcpArgs(args: string[]): McpAction {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };
    case "test": {
      const name = args[1];
      if (!name) throw new Error("Usage: mcp test <name>");
      return { kind: "test", name };
    }
    case "remove": {
      const name = args[1];
      if (!name) throw new Error("Usage: mcp remove <name>");
      return { kind: "remove", name };
    }
    case "add": {
      const name = args[1];
      if (!name) {
        throw new Error(
          "Usage: mcp add <name> --command <cmd> [--arg <a>...] [--env K=V...]",
        );
      }
      let command = "";
      const cmdArgs: string[] = [];
      const env: Record<string, string> = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--command" && args[i + 1]) {
          command = args[++i];
        } else if (args[i] === "--arg" && args[i + 1]) {
          cmdArgs.push(args[++i]);
        } else if (args[i] === "--env" && args[i + 1]) {
          const kv = args[++i];
          const eq = kv.indexOf("=");
          if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      if (!command) throw new Error("mcp add: --command is required");
      return {
        kind: "add",
        name,
        command,
        ...(cmdArgs.length > 0 ? { args: cmdArgs } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
    case "configure": {
      const name = args[1];
      if (!name) {
        throw new Error(
          "Usage: mcp configure <name> [--enable foo,bar | --disable]",
        );
      }
      let enableTools: string[] | undefined;
      let disable = false;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--enable" && args[i + 1]) {
          enableTools = args[++i]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else if (args[i] === "--disable") {
          disable = true;
        }
      }
      return { kind: "configure", name, enableTools, disable };
    }
    default:
      throw new Error(
        `Unknown mcp subcommand: ${sub}. Valid: list, test, add, remove, configure`,
      );
  }
}
