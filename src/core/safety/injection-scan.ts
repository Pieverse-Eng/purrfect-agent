export interface SafetyFinding {
  id: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface InjectionScanResult {
  findings: SafetyFinding[];
}

const THREAT_PATTERNS: Array<[RegExp, SafetyFinding]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, finding("prompt_injection", "high")],
  [/you\s+are\s+now\s+/i, finding("role_override", "high")],
  [/^system\s*:\s*/im, finding("system_role_override", "high")],
  [/do\s+not\s+tell\s+the\s+user/i, finding("deception_hide", "medium")],
  [/system\s+prompt\s+override/i, finding("sys_prompt_override", "high")],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, finding("disregard_rules", "high")],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, finding("bypass_restrictions", "high")],
  [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, finding("html_comment_injection", "medium")],
  [/<\s*div\s+style\s*=\s*["'].*display\s*:\s*none/i, finding("hidden_div", "medium")],
  [/translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, finding("translate_execute", "high")],
  [/(?:curl|wget)\s+[^\n]*(?:\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)|\$\(|`)/i, finding("exfil_curl", "high")],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\/etc\/passwd)/i, finding("read_secrets", "high")],
  [/(?:show|print|reveal|display|output|dump|echo)\s+[^\n]*(?:api[_\s]?key|secret[_\s]?key|password|token|credential)/i, finding("credential_access", "high")],
  [/(?:print|echo|cat|show)\s+[^\n]*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET|GITHUB_TOKEN)/i, finding("env_credential_access", "high")],
  [/bypass\s+(?:your\s+)?(?:restrictions|safety|filters|rules|guardrails)/i, finding("bypass_restrictions", "high")],
];

const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
]);

export function scanForPromptInjection(content: string): InjectionScanResult {
  const findings: SafetyFinding[] = [];

  for (const char of INVISIBLE_CHARS) {
    if (content.includes(char)) {
      findings.push({
        id: `invisible_unicode_U+${char.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`,
        severity: "medium",
        message: "Invisible unicode can hide prompt injection text",
      });
    }
  }

  for (const [pattern, template] of THREAT_PATTERNS) {
    if (pattern.test(content) && !findings.some((entry) => entry.id === template.id)) {
      findings.push({ ...template });
    }
  }

  return { findings };
}

function finding(id: string, severity: SafetyFinding["severity"]): SafetyFinding {
  return {
    id,
    severity,
    message: id.replaceAll("_", " "),
  };
}
