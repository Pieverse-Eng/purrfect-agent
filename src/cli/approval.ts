/**
 * Structured approval flow for tool invocations that fail permission checks.
 *
 * Provides prompt formatting, response parsing, and decision logging for the
 * interactive approval UI surfaced by the agent loop's onApprovalRequired callback.
 */

import { ansiColor } from "./formatter.js";

// ── Types ────────────────────────────────────────────────────────────

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

// ── Session store duck type (avoids hard dependency) ─────────────────

interface SessionStoreLike {
  appendMessage(
    sessionId: string,
    message: { role: string; content: string | null },
  ): void;
}

// ── Prompt formatting ────────────────────────────────────────────────

/**
 * Build a structured approval prompt showing the tool name, an args preview,
 * the risk reason, and three numbered options.
 */
export function formatApprovalPrompt(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
): string {
  const argsPreview = JSON.stringify(args, null, 2);

  const lines = [
    "",
    ansiColor("── Permission required ──", "yellow"),
    "",
    `  Tool:   ${ansiColor(toolName, "cyan")}`,
    `  Args:   ${argsPreview}`,
    `  Risk:   ${ansiColor(reason, "red")}`,
    "",
    "  Options:",
    `    ${ansiColor("1", "green")} - allow once   (execute this invocation only)`,
    `    ${ansiColor("2", "yellow")} - allow session (approve for the rest of this session)`,
    `    ${ansiColor("3", "red")} - deny          (block this invocation)`,
    "",
  ];

  return lines.join("\n");
}

// ── Response parsing ─────────────────────────────────────────────────

const ALLOW_ONCE_INPUTS = new Set(["1", "a", "y", "allow once", "allow_once"]);
const ALLOW_SESSION_INPUTS = new Set(["2", "s", "allow session", "allow_session"]);
const DENY_INPUTS = new Set(["3", "d", "n", "deny"]);

/**
 * Parse user input into an ApprovalDecision.
 * Unrecognised input defaults to "deny" (safe fallback).
 */
export function parseApprovalResponse(input: string): ApprovalDecision {
  const normalised = input.trim().toLowerCase();

  if (ALLOW_ONCE_INPUTS.has(normalised)) return "allow_once";
  if (ALLOW_SESSION_INPUTS.has(normalised)) return "allow_session";
  // Deny is the default for unrecognised input
  return "deny";
}

// ── Decision logging ─────────────────────────────────────────────────

/**
 * Log an approval decision as a metadata message in the session store.
 */
export function logApprovalDecision(
  sessionStore: SessionStoreLike,
  sessionId: string,
  toolName: string,
  decision: ApprovalDecision,
): void {
  const payload = JSON.stringify({
    type: "approval_decision",
    tool: toolName,
    decision,
    timestamp: Date.now(),
  });

  sessionStore.appendMessage(sessionId, {
    role: "metadata",
    content: payload,
  });
}
