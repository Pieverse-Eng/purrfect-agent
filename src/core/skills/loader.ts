import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { SkillDefinition } from "./types.js";

/**
 * Loads skill definitions from markdown files with YAML frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: What this skill does
 * triggers:
 *   - trigger phrase
 * tools:
 *   - tool_name
 * context_files:
 *   - path/to/file
 * ---
 *
 * Markdown body with instructions.
 * ```
 */
export class SkillLoader {
  /**
   * Parse a markdown skill file and return a SkillDefinition.
   * Returns null if the file is malformed or missing required fields.
   */
  static load(filePath: string): SkillDefinition | null {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    // Must start with frontmatter delimiter
    if (!raw.startsWith("---")) {
      return null;
    }

    // Find closing delimiter
    const closingIndex = raw.indexOf("\n---", 3);
    if (closingIndex === -1) {
      return null;
    }

    const yamlContent = raw.slice(4, closingIndex); // skip opening "---\n"
    const afterDelimiter = closingIndex + 4; // skip "\n---"
    const bodyRaw = raw.slice(afterDelimiter);
    // Trim leading newline but preserve the rest of the body
    const body = bodyRaw.replace(/^\n/, "").trimEnd();

    let parsed: Record<string, unknown>;
    try {
      parsed = YAML.parse(yamlContent) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    // Require name field
    if (!parsed.name || typeof parsed.name !== "string") {
      return null;
    }

    return {
      name: parsed.name,
      description:
        typeof parsed.description === "string" ? parsed.description : "",
      triggers: Array.isArray(parsed.triggers)
        ? (parsed.triggers as string[])
        : [],
      tools: Array.isArray(parsed.tools) ? (parsed.tools as string[]) : [],
      contextFiles: Array.isArray(parsed.context_files)
        ? (parsed.context_files as string[])
        : [],
      body,
    };
  }
}
