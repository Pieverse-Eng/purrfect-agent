/**
 * User-defined shell hooks fired around tool calls and at session end.
 *
 * Configured under `hooks` in `config.json`. Three phases:
 *   - preToolUse:  runs before tool dispatch. May block the call.
 *   - postToolUse: runs after dispatch. Cannot block.
 *   - stop:        runs at session shutdown. Matcher is ignored.
 *
 * Templates substitute `{{tool_name}}`, `{{args_json}}`, `{{result_json}}`.
 * Substitutions are JSON-encoded then shell-quoted, never inlined raw, so
 * embedded quotes/backticks/$VAR cannot escape the argument.
 */

import { spawn } from "node:child_process";
import type { UserHookConfig } from "./config-schema.js";

export type UserHookPhase = "preToolUse" | "postToolUse" | "stop";

export interface UserHooksConfig {
  preToolUse?: UserHookConfig[];
  postToolUse?: UserHookConfig[];
  stop?: UserHookConfig[];
}

export interface HookRunContext {
  /** Tool name being invoked. Empty string for "stop" phase. */
  toolName: string;
  /** Tool arguments (object). Empty object for "stop". */
  args: Record<string, unknown>;
  /** Tool result (post phase only). Undefined otherwise. */
  result?: string;
}

export interface HookOutcome {
  hook: UserHookConfig;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  blocked: boolean;
  timedOut: boolean;
  error?: string;
}

/** Default hook timeout. Generous enough for linters, tight enough to not stall the loop. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Match a tool name against a hook matcher pattern. Empty matcher and "*"
 * match everything. Otherwise treat as a glob with `*` wildcard.
 */
export function matchesMatcher(toolName: string, matcher: string): boolean {
  if (!matcher || matcher === "*") return true;
  if (!matcher.includes("*")) return matcher === toolName;
  // Convert glob → regex. Escape regex meta first, then convert escaped \*
  // back to `.*`. This is intentionally narrow — we only handle `*`, not
  // brace expansion or character classes.
  const escaped = matcher.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(pattern).test(toolName);
}

/**
 * Render a hook command template with safe shell quoting. JSON-encoding
 * defends against quote-escapes; single-quote wrapping prevents the shell
 * from interpreting the resulting string further.
 */
export function renderTemplate(
  template: string,
  ctx: HookRunContext,
): string {
  const replacements: Record<string, string> = {
    tool_name: shellQuote(ctx.toolName),
    args_json: shellQuote(JSON.stringify(ctx.args ?? {})),
    result_json: shellQuote(JSON.stringify(ctx.result ?? null)),
  };
  return template.replace(/\{\{(tool_name|args_json|result_json)\}\}/g, (_, key) => {
    return replacements[key] ?? "";
  });
}

/**
 * Wrap a string in single-quotes, escaping any embedded single-quotes by
 * closing the quoted region, inserting an escaped quote, and reopening.
 */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function selectHooks(
  cfg: UserHooksConfig | undefined,
  phase: UserHookPhase,
): UserHookConfig[] {
  if (!cfg) return [];
  return cfg[phase] ?? [];
}

/**
 * Run all hooks for the given phase against the context. Hooks are run
 * sequentially (so block decisions are deterministic). The first preToolUse
 * hook with onFailure=block that returns non-zero short-circuits.
 */
export async function runUserHooks(
  cfg: UserHooksConfig | undefined,
  phase: UserHookPhase,
  ctx: HookRunContext,
): Promise<HookOutcome[]> {
  const hooks = selectHooks(cfg, phase);
  if (hooks.length === 0) return [];

  const results: HookOutcome[] = [];
  for (const hook of hooks) {
    if (phase !== "stop" && !matchesMatcher(ctx.toolName, hook.matcher)) {
      continue;
    }
    const outcome = await runOneHook(hook, ctx);
    results.push(outcome);

    if (outcome.blocked) {
      // Stop chaining — caller will see blocked=true and skip the tool call.
      break;
    }
  }
  return results;
}

async function runOneHook(
  hook: UserHookConfig,
  ctx: HookRunContext,
): Promise<HookOutcome> {
  const command = renderTemplate(hook.command, ctx);
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookOutcome>((resolve) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        hook,
        exitCode: null,
        stdout,
        stderr,
        blocked: false,
        timedOut,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const failed = (code ?? 1) !== 0 || timedOut;
      const blocked = failed && hook.onFailure === "block";
      resolve({
        hook,
        exitCode: code,
        stdout,
        stderr,
        blocked,
        timedOut,
      });
    });
  });
}
