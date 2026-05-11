import { scanForPromptInjection, type SafetyFinding } from "./injection-scan.js";

export interface ContextFileGuardResult {
  content: string;
  blocked: boolean;
  findings: SafetyFinding[];
}

export function guardContextFileContent(
  content: string,
  filename: string,
): ContextFileGuardResult {
  const scan = scanForPromptInjection(content);
  if (scan.findings.length === 0) {
    return { content, blocked: false, findings: [] };
  }

  return {
    blocked: true,
    findings: scan.findings,
    content:
      `[BLOCKED: ${filename} contained potential prompt injection (` +
      `${scan.findings.map((finding) => finding.id).join(", ")}). Content not loaded.]`,
  };
}
