/**
 * Sandbox execution for shell commands.
 *
 * sandbox: 'none'      — current behavior (no isolation)
 * sandbox: 'process'   — lightweight restrictions (see below)
 * sandbox: 'container' — Docker/Podman container (future, real isolation)
 *
 * IMPORTANT: 'process' mode does NOT provide filesystem isolation.
 * It applies these restrictions:
 * - Restricted PATH (essential system binaries only)
 * - Minimal environment variable allowlist
 * - Default working directory set via cwd
 * - Resource limits via ulimit wrapper (memory + file size)
 *
 * However, commands can still access absolute paths (e.g. /etc/passwd),
 * use `cd ..` to navigate outside the working directory, and read/write
 * any file the process user has OS-level permission to access.
 *
 * Process mode is a convenience default, NOT a security boundary.
 * For true filesystem isolation, use 'container' mode once implemented.
 */

import { execFile, type ExecFileOptions } from "node:child_process";

export type SandboxMode = "none" | "process" | "container";

export interface SandboxOptions {
  mode: SandboxMode;
  /** Default working directory for command execution (does NOT restrict filesystem access). */
  cwd?: string;
  /** Additional env vars to pass through (beyond the safe defaults). */
  allowedEnvVars?: string[];
  /** Max memory in KB for ulimit (default: 512MB = 524288). */
  maxMemoryKB?: number;
  /** Max file size in KB for ulimit (default: 100MB = 102400). */
  maxFileSizeKB?: number;
}

/** Minimal safe PATH for sandboxed execution. */
const SAFE_PATH = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

/** Environment variables that are always safe to pass through. */
const SAFE_ENV_VARS = [
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
];

/**
 * Build the environment for a sandboxed process.
 * Only passes through safe env vars + any explicitly allowed ones.
 */
function buildSandboxEnv(allowedEnvVars?: string[]): Record<string, string> {
  const env: Record<string, string> = { PATH: SAFE_PATH };

  const allowed = [...SAFE_ENV_VARS, ...(allowedEnvVars ?? [])];
  for (const key of allowed) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  return env;
}

/**
 * Wrap a command with ulimit restrictions.
 */
function wrapWithLimits(
  command: string,
  maxMemoryKB: number,
  maxFileSizeKB: number,
): string {
  // ulimit -v = virtual memory, -f = file size (in 512-byte blocks on some systems, KB on others)
  return `ulimit -v ${maxMemoryKB} 2>/dev/null; ulimit -f ${maxFileSizeKB} 2>/dev/null; ${command}`;
}

/**
 * Execute a command with sandbox restrictions.
 */
export function execSandboxed(
  command: string,
  options: SandboxOptions & { timeout: number },
): Promise<string> {
  const { mode, cwd, allowedEnvVars, maxMemoryKB, maxFileSizeKB, timeout } = options;

  if (mode === "none") {
    // No sandbox — current behavior
    return new Promise<string>((resolve) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        { timeout, env: { PATH: process.env.PATH } },
        (err, stdout, stderr) => {
          if (err) {
            if (err.killed || err.signal === "SIGTERM") {
              resolve(JSON.stringify({ error: "Timeout: command exceeded time limit" }));
              return;
            }
            resolve(JSON.stringify({ error: stderr || err.message, exit_code: err.code }));
            return;
          }
          resolve(JSON.stringify({ stdout, stderr }));
        },
      );
    });
  }

  if (mode === "process") {
    // NOTE: Process mode restricts PATH, env, and resource limits but does NOT
    // provide filesystem isolation. The cwd is a default starting directory only.
    const env = buildSandboxEnv(allowedEnvVars);
    const memLimit = maxMemoryKB ?? 524_288; // 512MB
    const fileLimit = maxFileSizeKB ?? 102_400; // 100MB
    const wrappedCommand = wrapWithLimits(command, memLimit, fileLimit);

    const execOptions: ExecFileOptions = {
      timeout,
      env,
      cwd: cwd ?? process.cwd(),
    };

    return new Promise<string>((resolve) => {
      execFile("/bin/sh", ["-c", wrappedCommand], execOptions, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.signal === "SIGTERM") {
            resolve(JSON.stringify({ error: "Timeout: command exceeded time limit" }));
            return;
          }
          resolve(JSON.stringify({ error: stderr || err.message, exit_code: err.code }));
          return;
        }
        resolve(JSON.stringify({ stdout, stderr }));
      });
    });
  }

  if (mode === "container") {
    return Promise.resolve(
      JSON.stringify({
        error: "Container sandbox mode is not yet implemented. Use 'process' or 'none'.",
      }),
    );
  }

  return Promise.resolve(
    JSON.stringify({ error: `Unknown sandbox mode: ${mode}` }),
  );
}

/**
 * Check if Docker or Podman is available for container mode.
 */
export async function checkContainerRuntime(): Promise<{
  available: boolean;
  runtime?: "docker" | "podman";
  message: string;
}> {
  for (const runtime of ["docker", "podman"] as const) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        execFile(runtime, ["--version"], { timeout: 5000 }, (err) => {
          resolve(!err);
        });
      });
      if (result) {
        return { available: true, runtime, message: `${runtime} is available` };
      }
    } catch {
      // Not available
    }
  }
  return { available: false, message: "Neither docker nor podman found" };
}
