import type { ToolDefinition } from "../types.js";
import {
  LocalMarkdownBackend,
  type MemoryBackend,
} from "../memory/backend.js";

const DEFAULT_MEMORY_DIR = ".purrfect/memory";

export interface MemoryToolOptions {
  /** Pre-built backend (preferred). When omitted, a LocalMarkdownBackend is created from memory_dir arg. */
  backend?: MemoryBackend;
}

const SCHEMA = {
  type: "function" as const,
  function: {
    name: "memory",
    description: "Read or write a named memory key to persistent storage.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "remove"],
          description: "Whether to read, write, or remove.",
        },
        key: { type: "string", description: "Memory key (tag) name." },
        value: { type: "string", description: "Value to write (required for write)." },
        memory_dir: {
          type: "string",
          description: "Directory for memory files (optional, ignored when backend is configured).",
        },
      },
      required: ["action", "key"],
    },
  },
};

function resolveBackend(opts: MemoryToolOptions, callArgDir?: string): MemoryBackend {
  if (opts.backend) return opts.backend;
  return new LocalMarkdownBackend(callArgDir ?? DEFAULT_MEMORY_DIR);
}

export function createMemoryTool(opts: MemoryToolOptions = {}): ToolDefinition {
  return {
    name: "memory",
    description: "Read or write a named memory key to persistent storage.",
    schema: SCHEMA,
    toolset: "memory",
    async handler(args) {
      const action = args.action as string;
      const key = args.key as string;
      const memoryDir = args.memory_dir as string | undefined;
      const backend = resolveBackend(opts, memoryDir);

      try {
        if (action === "write") {
          const value = (args.value as string | undefined) ?? "";
          const snapshot = await backend.getSnapshot();
          if (snapshot.includes(`§ ${key}`)) {
            await backend.replace(key, value);
          } else {
            await backend.add(key, value);
          }
          return JSON.stringify({ success: true });
        }

        if (action === "remove") {
          await backend.remove(key);
          return JSON.stringify({ success: true });
        }

        const snapshot = await backend.getLiveSnapshot();
        return JSON.stringify({ snapshot });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };
}

/** Default memory tool — uses LocalMarkdownBackend with each call's memory_dir arg. */
export const memoryTool: ToolDefinition = createMemoryTool();
