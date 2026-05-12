import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { FileStateCache } from "./file-state-cache.js";

/** Factory: creates a file_edit tool for safe substring replacement. */
export function createFileEditTool(cache: FileStateCache): ToolDefinition {
  return {
    name: "file_edit",
    description:
      "Edit an existing file by replacing an exact substring. " +
      "The old_string must match exactly once in the file (unless replace_all is true). " +
      "You must read the file with file_read before editing it.",
    schema: {
      type: "function",
      function: {
        name: "file_edit",
        description:
          "Edit an existing file by replacing an exact substring. " +
          "You must read the file with file_read before editing.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file to edit." },
            old_string: { type: "string", description: "The exact text to find in the file." },
            new_string: { type: "string", description: "The text to replace it with." },
            replace_all: {
              type: "boolean",
              description: "Replace all occurrences (default: false, requires exactly one match).",
            },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    toolset: "files",
    async handler(args) {
      const filePath = resolve(args.path as string);
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const replaceAll = (args.replace_all as boolean) ?? false;

      try {
        // Validate: old_string !== new_string
        if (oldString === newString) {
          return JSON.stringify({ error: "old_string and new_string are identical. No edit needed." });
        }

        // Validate: file was previously read
        if (!cache.hasBeenRead(filePath)) {
          return JSON.stringify({
            error: "You must read this file with file_read before editing it.",
          });
        }

        // Validate: file not modified externally
        const currentStat = await stat(filePath);
        const cached = cache.getEntry(filePath)!;
        if (currentStat.mtimeMs !== cached.mtimeMs) {
          return JSON.stringify({
            error:
              "File has been modified since last read. Please re-read it with file_read before editing.",
          });
        }

        // Read current content
        const content = await readFile(filePath, "utf-8");

        // Count occurrences
        const matchCount = content.split(oldString).length - 1;

        if (matchCount === 0) {
          return JSON.stringify({
            error: "old_string not found in file. Make sure it matches the file content exactly.",
          });
        }

        if (matchCount > 1 && !replaceAll) {
          return JSON.stringify({
            error: `old_string matches ${matchCount} locations. Use replace_all: true to replace all, or provide a longer string with more context to match uniquely.`,
          });
        }

        // Perform replacement
        const updated = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);

        await writeFile(filePath, updated, "utf-8");

        // Update cache with new state
        const newStat = await stat(filePath);
        cache.recordRead(filePath, newStat.mtimeMs, updated);

        return JSON.stringify({ success: true, replacements: replaceAll ? matchCount : 1 });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };
}
