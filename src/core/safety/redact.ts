import type { SafetyFinding } from "./injection-scan.js";
import { scanForPromptInjection } from "./injection-scan.js";

export type SafetyAction = "block" | "warn" | "log";

export interface Redaction {
  id: string;
  label: string;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

export interface ToolSafetyResult {
  action: SafetyAction;
  findings: SafetyFinding[];
  redactions: Redaction[];
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g, "bearer_token"],
  [/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, "github_token"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, "anthropic_api_key"],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "api_key"],
  [/\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|API_KEY|SECRET|TOKEN|PASSWORD)=\S+/g, "env_secret"],
  [/"(?:api[_-]?key|secret|token|password)"\s*:\s*"[^"]{4,}"/gi, "json_secret"],
];

export function redactSensitiveText(text: string): RedactionResult {
  let next = text;
  const redactions: Redaction[] = [];

  for (const [pattern, label] of SECRET_PATTERNS) {
    next = next.replace(pattern, (match) => {
      redactions.push({ id: label, label });
      if (label === "env_secret") {
        const eq = match.indexOf("=");
        return `${match.slice(0, eq + 1)}[REDACTED]`;
      }
      if (label === "json_secret") {
        const colon = match.indexOf(":");
        return `${match.slice(0, colon + 1)}"[REDACTED]"`;
      }
      if (match.startsWith("Bearer ")) {
        return "Bearer [REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  return { text: next, redactions };
}

export function sanitizeToolResultObject<T extends Record<string, unknown>>(
  result: T,
  options: {
    scanKeys?: string[];
    redactKeys?: string[];
    action?: SafetyAction;
  } = {},
): T & { safety?: ToolSafetyResult } {
  const scanKeys = options.scanKeys ?? ["content", "body", "stdout", "stderr", "error"];
  const redactKeys = options.redactKeys ?? scanKeys;
  const action = options.action ?? "warn";
  const findings: SafetyFinding[] = [];
  const redactions: Redaction[] = [];
  const next: Record<string, unknown> = { ...result };

  for (const key of redactKeys) {
    const value = next[key];
    if (typeof value !== "string") continue;

    const redacted = redactSensitiveText(value);
    next[key] = redacted.text;
    redactions.push(...redacted.redactions);
  }

  for (const key of scanKeys) {
    const value = next[key];
    if (typeof value !== "string") continue;

    const scanned = scanForPromptInjection(value);
    for (const finding of scanned.findings) {
      if (!findings.some((existing) => existing.id === finding.id)) {
        findings.push(finding);
      }
    }
  }

  if (findings.length === 0 && redactions.length === 0) {
    return next as T;
  }

  next.safety = { action, findings, redactions };
  if (action === "block" && findings.length > 0) {
    return {
      error: `Blocked unsafe tool result: ${findings.map((finding) => finding.id).join(", ")}`,
      safety: next.safety,
    } as unknown as T & { safety: ToolSafetyResult };
  }

  return next as T & { safety: ToolSafetyResult };
}
