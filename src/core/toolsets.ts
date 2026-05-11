/**
 * Platform-level toolset definitions.
 *
 * Each runtime surface (CLI, API server, editor integration) exposes
 * a different subset of tools. All share CORE_TOOLS as a base.
 */

export type Platform = "purrfect-cli" | "purrfect-api" | "purrfect-editor";

/** Tools available on every platform. */
export const CORE_TOOLS = [
  "file_read",
  "file_write",
  "file_edit",
  "shell_exec",
] as const;

/** Per-platform tool lists (superset of CORE_TOOLS). */
const PLATFORM_TOOLS: Record<Platform, readonly string[]> = {
  "purrfect-cli": [
    ...CORE_TOOLS,
    "clarify",
    "memory",
    "session_search",
    "delegate",
    "read_ref",
    "web_fetch",
    "todo_write",
    "checkpoint_create",
    "enter_plan_mode",
    "exit_plan_mode",
  ],
  "purrfect-api": [
    ...CORE_TOOLS,
    "read_ref",
    "web_fetch",
  ],
  "purrfect-editor": [
    ...CORE_TOOLS,
    "clarify",
    "memory",
    "session_search",
    "read_ref",
    "web_fetch",
  ],
};

/** Returns the tool names allowed for the given platform. */
export function getToolsForPlatform(platform: Platform): readonly string[] {
  return PLATFORM_TOOLS[platform];
}

/** Check if a tool is allowed on the given platform. */
export function isToolAllowed(toolName: string, platform: Platform): boolean {
  return PLATFORM_TOOLS[platform].includes(toolName);
}
