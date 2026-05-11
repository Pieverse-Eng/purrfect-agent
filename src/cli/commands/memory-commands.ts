/**
 * Memory commands: /memory (inspect, add, remove, list, backend)
 */

import type { CommandDef } from "./registry.js";
import { MemoryStore } from "../../core/memory/store.js";
import { parseEntries } from "../../core/memory/parser.js";
import { ansiColor } from "../formatter.js";
import { defaultConfigDir, loadConfigV2, saveConfigV2 } from "../config.js";
import { createMemoryBackend } from "../../core/memory/backend.js";

export const memoryCommand: CommandDef = {
  name: "memory",
  description: "Inspect and manage durable memory entries",
  category: "Tools & Skills",
  aliases: ["mem"],
  argsHint: "[add <tag> <content> | remove <tag> | list | backend <status|setup|switch> ...]",
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    const firstWord = trimmed.split(/\s+/)[0];

    if (firstWord === "backend") {
      const rest = trimmed.slice("backend".length).trim();
      await runBackendSubcommand(rest, ctx.output);
      return;
    }

    const memoriesDir = ctx.memoriesDir;
    if (!memoriesDir) {
      ctx.output(ansiColor("Memory directory not configured.", "yellow"));
      return;
    }

    const store = new MemoryStore(memoriesDir);

    if (!trimmed) {
      // Show full snapshot
      const snapshot = store.getSnapshot();
      if (!snapshot) {
        ctx.output(ansiColor("No memory entries.", "yellow"));
        return;
      }
      const entries = parseEntries(snapshot);
      ctx.output(ansiColor(`Memory snapshot (${entries.length} entries):`, "cyan"));
      ctx.output("");
      ctx.output(snapshot);
      return;
    }

    const spaceIdx = trimmed.indexOf(" ");
    const subcommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    switch (subcommand) {
      case "add": {
        const tagEnd = rest.indexOf(" ");
        if (tagEnd === -1 || !rest) {
          ctx.output(ansiColor("Usage: /memory add <tag> <content>", "yellow"));
          return;
        }
        const tag = rest.slice(0, tagEnd);
        const content = rest.slice(tagEnd + 1).trim();
        if (!content) {
          ctx.output(ansiColor("Usage: /memory add <tag> <content>", "yellow"));
          return;
        }
        store.add(tag, content);
        ctx.output(ansiColor(`Added memory entry: ${tag}`, "green"));
        break;
      }
      case "remove": {
        if (!rest) {
          ctx.output(ansiColor("Usage: /memory remove <tag>", "yellow"));
          return;
        }
        store.remove(rest);
        ctx.output(ansiColor(`Removed memory entry: ${rest}`, "green"));
        break;
      }
      case "list": {
        const snapshot = store.getSnapshot();
        if (!snapshot) {
          ctx.output(ansiColor("No memory entries.", "yellow"));
          return;
        }
        const entries = parseEntries(snapshot);
        ctx.output(ansiColor(`Memory tags (${entries.length}):`, "cyan"));
        for (const entry of entries) {
          ctx.output(`  ${ansiColor("§", "gray")} ${entry.tag}`);
        }
        break;
      }
      default:
        ctx.output(ansiColor(`Unknown subcommand: ${subcommand}`, "yellow"));
        ctx.output(ansiColor("Usage: /memory [add <tag> <content> | remove <tag> | list | backend ...]", "gray"));
    }
  },
};

const BACKEND_USAGE =
  "Usage: memory backend <status | setup --type <local|http> [--endpoint <url>] [--api-key <ref>] [--namespace <ns>] | switch <local|http>>";

async function runBackendSubcommand(
  args: string,
  output: (text: string) => void,
): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "status";

  switch (sub) {
    case "status": {
      const cfg = loadConfigV2(defaultConfigDir());
      const memCfg = (cfg as any).memory ?? { backend: "local" };
      output(ansiColor("Memory backend status:", "cyan"));
      output(`  backend:   ${memCfg.backend ?? "local"}`);
      if (memCfg.endpoint) output(`  endpoint:  ${memCfg.endpoint}`);
      if (memCfg.namespace) output(`  namespace: ${memCfg.namespace}`);
      if (memCfg.apiKey) {
        const masked = typeof memCfg.apiKey === "string"
          ? `${memCfg.apiKey.slice(0, 6)}…`
          : "(secret ref)";
        output(`  apiKey:    ${masked}`);
      }
      // Probe reachability for HTTP
      if (memCfg.backend === "http" && memCfg.endpoint) {
        try {
          const backend = createMemoryBackend({
            dir: defaultConfigDir(),
            config: memCfg,
          });
          await backend.getLiveSnapshot();
          output(ansiColor("  reachable: yes", "green"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output(ansiColor(`  reachable: no (${msg})`, "red"));
        }
      }
      return;
    }

    case "setup": {
      const opts = parseSetupFlags(parts.slice(1));
      if (!opts.type) {
        output(ansiColor("setup: --type <local|http> is required", "yellow"));
        output(BACKEND_USAGE);
        return;
      }
      if (opts.type === "http" && !opts.endpoint) {
        output(ansiColor("setup: --endpoint <url> is required for type=http", "yellow"));
        return;
      }
      const cfg = loadConfigV2(defaultConfigDir());
      (cfg as any).memory = {
        backend: opts.type,
        endpoint: opts.endpoint,
        apiKey: opts.apiKey,
        namespace: opts.namespace,
      };
      saveConfigV2(cfg, defaultConfigDir());
      output(ansiColor(`Memory backend configured: ${opts.type}`, "green"));
      return;
    }

    case "switch": {
      const target = parts[1];
      if (target !== "local" && target !== "http") {
        output(ansiColor("switch: target must be 'local' or 'http'", "yellow"));
        return;
      }
      const cfg = loadConfigV2(defaultConfigDir());
      const current = (cfg as any).memory ?? {};
      if (target === "http" && !current.endpoint) {
        output(ansiColor("switch: cannot switch to http without an endpoint. Run `memory backend setup --type http --endpoint <url>` first.", "yellow"));
        return;
      }
      (cfg as any).memory = { ...current, backend: target };
      saveConfigV2(cfg, defaultConfigDir());
      output(ansiColor(`Switched memory backend to: ${target}`, "green"));
      return;
    }

    default:
      output(ansiColor(`Unknown backend subcommand: ${sub}`, "yellow"));
      output(BACKEND_USAGE);
  }
}

function parseSetupFlags(args: string[]): {
  type?: "local" | "http";
  endpoint?: string;
  apiKey?: string;
  namespace?: string;
} {
  const out: { type?: "local" | "http"; endpoint?: string; apiKey?: string; namespace?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--type":
        if (value === "local" || value === "http") out.type = value;
        i++;
        break;
      case "--endpoint":
        out.endpoint = value;
        i++;
        break;
      case "--api-key":
        out.apiKey = value;
        i++;
        break;
      case "--namespace":
        out.namespace = value;
        i++;
        break;
    }
  }
  return out;
}
