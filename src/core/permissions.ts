import { resolve } from "node:path";
import { homedir } from "node:os";
import { PermissionDeniedError } from "./errors.js";

/**
 * Result of a permission check.
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Options for constructing a PermissionModel.
 */
export interface PermissionModelOptions {
  /** Tools explicitly allowed. When set, only these tools pass (allowlist mode). */
  allowList?: string[];
  /** Tools explicitly denied. Deny list takes precedence over allow list. */
  denyList?: string[];
  /** When true, checkOrThrow throws PermissionDeniedError instead of returning. */
  enforce?: boolean;
  /**
   * Permission mode:
   * - "allow-all" (default): tools are allowed unless on the deny list or not on an explicit allow list.
   * - "deny-by-default": tools NOT in allowList are denied (reverse of current logic).
   */
  mode?: "allow-all" | "deny-by-default";
  /**
   * Allowed file-system paths for file_read / file_write.
   * Requested paths must be under one of these directories.
   * Defaults to [process.cwd(), os.homedir()].
   */
  allowedPaths?: string[];
  /**
   * Optional label used to enrich denial reasons (e.g. "gateway mode").
   */
  contextLabel?: string;
}

/**
 * Normalize a command string for pattern matching: collapse runs of
 * whitespace to a single space and trim.  SQL-oriented patterns already
 * use the `i` flag, so we intentionally do NOT lowercase here — that
 * keeps filesystem paths (which are case-sensitive on Linux) intact
 * while SQL regexes remain case-insensitive via their own flag.
 */
function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

/**
 * Dangerous command patterns ported from hermes-agent tools/approval.py.
 * Each entry is [regex, human-readable description].
 */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[^\s]*\s+)*\//, "delete in root path"],
  [/\brm\s+-[^\s]*r/, "recursive delete"],
  [/\brm\s+--recursive\b/, "recursive delete (long flag)"],
  [/\brm\s+.*--no-preserve-root\b/, "explicit root delete"],
  [/\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/, "world/other-writable permissions"],
  [/\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)/, "recursive world/other-writable (long flag)"],
  [/\bchown\s+(-[^\s]*)?R\s+root/, "recursive chown to root"],
  [/\bmkfs\b/, "format filesystem"],
  [/\bwipefs\b/, "wipe filesystem signatures"],
  [/\bshred\b/, "secure delete"],
  [/\bdd\s+.*if=/, "disk copy"],
  [/>\s*\/dev\/sd/, "write to block device"],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, "SQL DROP"],
  [/\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, "SQL DELETE without WHERE"],
  [/\bTRUNCATE\s+(TABLE)?\s*\w/i, "SQL TRUNCATE"],
  [/>\s*\/etc\//, "overwrite system config"],
  [/\bsystemctl\s+.*\b(stop|disable)\b/, "stop/disable system service"],
  [/\bkill\s+-9\s+-1\b/, "kill all processes"],
  [/\bkill\s+-s\s+KILL\b/, "kill all processes (signal name)"],
  [/\bkill\s+-KILL\b/, "kill all processes (short signal)"],
  [/\bpkill\s+-9\b/, "force kill processes"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
  [/\b(curl|wget)\b.*\|\s*(ba)?sh\b/, "pipe remote content to shell"],
  [/\bxargs\s+.*\brm\b/, "xargs with rm"],
  [/\bfind\b.*-exec\s+(\/\S*\/)?rm\b/, "find -exec rm"],
  [/\bfind\b.*-delete\b/, "find -delete"],
];

/**
 * Detect whether a shell command matches any dangerous pattern.
 * Returns [isDangerous, description] or [false, undefined].
 */
function detectDangerousCommand(command: string): [boolean, string | undefined] {
  const normalized = normalizeCommand(command);
  for (const [pattern, description] of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) {
      return [true, description];
    }
  }
  return [false, undefined];
}

/**
 * Tool-level allow/deny lists with runtime validation and dangerous command detection.
 */
export class PermissionModel {
  private readonly allowList: Set<string> | null;
  private readonly denyList: Set<string>;
  private readonly enforce: boolean;
  private readonly mode: "allow-all" | "deny-by-default";
  private readonly allowedPaths: string[];
  private readonly contextLabel: string | undefined;
  /** Per-session approved commands, keyed by "toolName::command" */
  private readonly sessionApprovals = new Set<string>();

  constructor(options: PermissionModelOptions = {}) {
    this.mode = options.mode ?? "allow-all";
    // In deny-by-default mode, treat a missing allowList as an empty set (deny everything).
    if (this.mode === "deny-by-default") {
      this.allowList = new Set(options.allowList ?? []);
    } else {
      this.allowList = options.allowList ? new Set(options.allowList) : null;
    }
    this.denyList = new Set(options.denyList ?? []);
    this.enforce = options.enforce ?? false;
    this.allowedPaths = (options.allowedPaths ?? [process.cwd(), homedir()]).map(
      (p) => resolve(p),
    );
    this.contextLabel = options.contextLabel;
  }

  /**
   * Check if a tool invocation is permitted.
   */
  check(toolName: string, args: Record<string, unknown>): PermissionCheckResult {
    // Deny list takes precedence
    if (this.denyList.has(toolName)) {
      if (this.contextLabel) {
        return { allowed: false, reason: `${toolName} denied: ${this.contextLabel} restricts ${toolName.replace(/_/g, " ")}` };
      }
      return { allowed: false, reason: `Tool "${toolName}" is on the deny list` };
    }

    // Allow list mode: reject tools not on the list
    if (this.allowList !== null && !this.allowList.has(toolName)) {
      if (this.contextLabel) {
        return { allowed: false, reason: `${toolName} denied: ${this.contextLabel} restricts ${toolName.replace(/_/g, " ")}` };
      }
      return { allowed: false, reason: `Tool "${toolName}" is not on the allow list` };
    }

    // File path scoping for file_read / file_write
    if (
      (toolName === "file_read" || toolName === "file_write") &&
      typeof args.path === "string"
    ) {
      const resolved = resolve(args.path);
      const inside = this.allowedPaths.some((dir) =>
        resolved === dir || resolved.startsWith(dir + "/"),
      );
      if (!inside) {
        return {
          allowed: false,
          reason: `${toolName} denied: path ${resolved} outside allowed directories`,
        };
      }
    }

    // Check dangerous shell commands
    if (typeof args.command === "string") {
      const command = args.command;
      const approvalKey = `${toolName}::${command}`;

      // Check session approvals first
      if (this.sessionApprovals.has(approvalKey)) {
        return { allowed: true };
      }

      const [isDangerous, description] = detectDangerousCommand(command);
      if (isDangerous) {
        return { allowed: false, reason: description };
      }
    }

    return { allowed: true };
  }

  /**
   * Like check(), but throws PermissionDeniedError when denied and enforce mode is on.
   */
  checkOrThrow(toolName: string, args: Record<string, unknown>): PermissionCheckResult {
    const result = this.check(toolName, args);
    if (!result.allowed && this.enforce) {
      throw new PermissionDeniedError(toolName, result.reason ?? "denied");
    }
    return result;
  }

  /**
   * Approve a specific tool+command combination for the current session.
   */
  approveForSession(toolName: string, command: string): void {
    this.sessionApprovals.add(`${toolName}::${command}`);
  }

  /**
   * Clear all per-session approvals.
   */
  clearSession(): void {
    this.sessionApprovals.clear();
  }

  /**
   * Create a child permission domain with the same static policy but no
   * parent session approvals. Subagents must ask for their own approvals.
   */
  forkSession(): PermissionModel {
    return new PermissionModel({
      mode: this.mode,
      allowList: this.allowList ? [...this.allowList] : undefined,
      denyList: [...this.denyList],
      enforce: this.enforce,
      allowedPaths: [...this.allowedPaths],
      contextLabel: this.contextLabel,
    });
  }
}

// ---------------------------------------------------------------------------
// Gateway-mode preset
// ---------------------------------------------------------------------------

/** Curated allow-list for gateway mode. */
export const GATEWAY_DEFAULT_ALLOW_LIST = [
  "file_read",
  "web_fetch",
  "session_search",
  "memory",
  "send_message",
];

/**
 * Create a PermissionModel configured for gateway mode:
 * deny-by-default with a curated allowlist, no shell_exec or file_write.
 */
export function createGatewayPermissions(
  options?: { allowedPaths?: string[] },
): PermissionModel {
  return new PermissionModel({
    mode: "deny-by-default",
    allowList: GATEWAY_DEFAULT_ALLOW_LIST,
    enforce: true,
    contextLabel: "gateway mode",
    allowedPaths: options?.allowedPaths,
  });
}
