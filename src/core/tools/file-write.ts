import { writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { FileStateCache } from "./file-state-cache.js";

const FILE_WRITE_SCHEMA: ToolDefinition["schema"] = {
  type: "function",
  function: {
    name: "file_write",
    description:
      "Create a new file at the given path, creating directories as needed. " +
      "For editing existing files, use file_edit instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to create." },
        content: { type: "string", description: "Content to write to the file." },
      },
      required: ["path", "content"],
    },
  },
};

/** Static file_write tool — no validation (kept for backward compat). */
export const fileWriteTool: ToolDefinition = {
  name: "file_write",
  description: "Write content to a file at the given path, creating directories as needed.",
  schema: FILE_WRITE_SCHEMA,
  toolset: "files",
  async handler(args) {
    try {
      const filePath = args.path as string;
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content as string, "utf-8");
      return JSON.stringify({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  },
};

/** Check whether a file exists on disk. Returns stat result or null. */
async function trystat(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/** Factory: creates a file_write tool restricted to new file creation only. */
export function createFileWriteTool(cache: FileStateCache): ToolDefinition {
  return {
    name: "file_write",
    description:
      "Create a new file at the given path, creating directories as needed. " +
      "For editing existing files, use file_edit instead.",
    schema: FILE_WRITE_SCHEMA,
    toolset: "files",
    async handler(args) {
      const filePath = resolve(args.path as string);
      const content = args.content as string;

      try {
        const existing = await trystat(filePath);

        if (existing) {
          return JSON.stringify({
            error:
              "File already exists. Use file_edit to modify existing files, or file_read then file_write if you need a full rewrite.",
          });
        }

        // New file — proceed with write
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, "utf-8");

        // Record in cache so subsequent edits don't require a separate read
        const newStat = await stat(filePath);
        cache.recordRead(filePath, newStat.mtimeMs, content);

        return JSON.stringify({ success: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };
}
