import type { SafetyFinding } from "./injection-scan.js";

export interface UrlPolicyOptions {
  allowlist?: string[];
  blocklist?: string[];
}

export interface UrlPolicyResult {
  allowed: boolean;
  reason?: string;
  findings: SafetyFinding[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function checkUrlPolicy(url: string, options: UrlPolicyOptions = {}): UrlPolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return blocked("invalid_url", "URL is invalid");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return blocked("url_policy", "Only http and https URLs are allowed");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (LOCAL_HOSTS.has(hostname) || isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return blocked("url_policy", "Local and private network URLs are blocked");
  }

  if (options.allowlist?.length) {
    const allowed = options.allowlist.some((entry) => hostMatches(hostname, entry));
    if (!allowed) {
      return blocked("url_policy", `Host ${hostname} is not on the URL allowlist`);
    }
  }

  if (options.blocklist?.some((entry) => hostMatches(hostname, entry))) {
    return blocked("url_policy", `Host ${hostname} is blocked by URL policy`);
  }

  return { allowed: true, findings: [] };
}

function blocked(id: string, reason: string): UrlPolicyResult {
  return {
    allowed: false,
    reason,
    findings: [{ id, severity: "high", message: reason }],
  };
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254);
}

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const normalized = hostname.toLowerCase();
  return normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb");
}
