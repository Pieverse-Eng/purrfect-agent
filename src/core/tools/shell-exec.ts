import type { ToolDefinition } from "../types.js";
import { execSandboxed, type SandboxMode, type SandboxOptions } from "../sandbox/index.js";
import { sanitizeToolResultObject } from "../safety/redact.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const SHELL_EXEC_SCHEMA: ToolDefinition["schema"] = {
  type: "function",
  function: {
    name: "shell_exec",
    description: "Execute a shell command and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default 30000).",
        },
      },
      required: ["command"],
    },
  },
};

/**
 * Factory: creates a shell_exec tool with sandbox options captured at creation
 * time (per-instance), avoiding the process-global singleton problem.
 */
export function createShellExecTool(sandboxOptions?: SandboxOptions): ToolDefinition {
  const opts: SandboxOptions = sandboxOptions ?? { mode: "none" };

  return {
    name: "shell_exec",
    description: "Execute a shell command and return stdout/stderr.",
    schema: SHELL_EXEC_SCHEMA,
    toolset: "terminal",
    handler(args) {
      const command = args.command as string;
      const timeoutArg = args.timeout_ms;
      if (
        timeoutArg !== undefined &&
        (typeof timeoutArg !== "number" ||
          !Number.isFinite(timeoutArg) ||
          timeoutArg <= 0)
      ) {
        return Promise.resolve(
          JSON.stringify({ error: "timeout_ms must be a positive finite number" }),
        );
      }
      const timeout = timeoutArg ?? DEFAULT_TIMEOUT_MS;

      return execSandboxed(command, { ...opts, timeout }).then((raw) => {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          return JSON.stringify(sanitizeToolResultObject(parsed));
        } catch {
          return JSON.stringify(sanitizeToolResultObject({ stdout: raw }));
        }
      });
    },
  };
}

/** Static shell_exec tool with no sandbox (mode: 'none'). Kept for backward compat. */
export const shellExecTool: ToolDefinition = createShellExecTool({ mode: "none" });
