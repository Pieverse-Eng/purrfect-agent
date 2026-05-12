import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { FileStateCache } from "./file-state-cache.js";
import { sanitizeToolResultObject } from "../safety/redact.js";

const FILE_READ_SCHEMA: ToolDefinition["schema"] = {
  type: "function",
  function: {
    name: "file_read",
    description: "Read the contents of a file at the given path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to read." },
      },
      required: ["path"],
    },
  },
};

/** Static file_read tool — no state tracking (kept for backward compat). */
export const fileReadTool: ToolDefinition = {
  name: "file_read",
  description: "Read the contents of a file at the given path.",
  schema: FILE_READ_SCHEMA,
  toolset: "files",
  async handler(args) {
    const filePath = args.path as string;
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.stringify(sanitizeFileReadResult(filePath, { content }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify(sanitizeToolResultObject({ error: message }));
    }
  },
};

/** Factory: creates a file_read tool that records state into the shared cache. */
export function createFileReadTool(cache: FileStateCache): ToolDefinition {
  return {
    name: "file_read",
    description: "Read the contents of a file at the given path.",
    schema: FILE_READ_SCHEMA,
    toolset: "files",
    async handler(args) {
      const filePath = resolve(args.path as string);
      try {
        const content = await readFile(filePath, "utf-8");
        const st = await stat(filePath);
        cache.recordRead(filePath, st.mtimeMs, content);
        return JSON.stringify(sanitizeFileReadResult(filePath, { content }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify(sanitizeToolResultObject({ error: message }));
      }
    },
  };
}

function sanitizeFileReadResult(
  filePath: string,
  result: { content: string },
): { content: string; safety?: unknown } {
  const scanKeys = /\.(md|markdown|mdx)$/i.test(filePath)
    ? ["content"]
    : [];
  return sanitizeToolResultObject(result, { scanKeys, redactKeys: ["content"] });
}
