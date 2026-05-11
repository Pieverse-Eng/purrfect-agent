/**
 * Plan Mode — read-only constraint definitions.
 *
 * Single source of truth for which tools are blocked / allowed while plan
 * mode is active.  Tool descriptions, system-prompt hints, and AgentLoop
 * filtering all derive from the constants in this file so they cannot drift
 * out of sync.
 */

/** Mutating tools rejected (schema-filtered + dispatch-guarded) when plan mode is active. */
export const PLAN_MODE_BLOCKED_TOOLS = new Set([
  "shell_exec",
  "file_write",
  "file_edit",
  "delegate",
  "skill_manage",
  "checkpoint_create",
]);

/** Read-only tools that remain available while plan mode is active. */
export const PLAN_MODE_ALLOWED_TOOLS = [
  "file_read",
  "web_fetch",
  "memory",
  "session_search",
  "todo_write",
] as const;

/** Hidden from schema while plan mode is ACTIVE (blocked + redundant toggles). */
export const PLAN_MODE_HIDDEN_WHEN_ACTIVE = new Set<string>([
  ...PLAN_MODE_BLOCKED_TOOLS,
  "enter_plan_mode",
]);

/** Hidden from schema while plan mode is INACTIVE (no point exposing exit). */
export const PLAN_MODE_HIDDEN_WHEN_INACTIVE = new Set<string>(["exit_plan_mode"]);

/** Comma-joined allowed-tool list for prompts and tool descriptions. */
export function planModeAllowedToolList(): string {
  return PLAN_MODE_ALLOWED_TOOLS.join(", ");
}

/** Comma-joined blocked-tool list for prompts and tool descriptions. */
export function planModeBlockedToolList(): string {
  return [...PLAN_MODE_BLOCKED_TOOLS].join(", ");
}
