/**
 * Structured secret management.
 *
 * SecretRef supports three resolution strategies:
 * - Raw string (backward compat): used directly
 * - { env: "VAR_NAME" }: resolved from environment variable
 * - { file: "/path" }: read from file at runtime
 *
 * SecretRegistry tracks resolved values for log redaction.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

// ── SecretRef schema ──────────────────────────────────────────────────

export const SecretRefSchema = z.union([
  z.string(),
  z.object({ env: z.string() }),
  z.object({ file: z.string() }),
]);

export type SecretRef = z.infer<typeof SecretRefSchema>;

// ── Resolution ────────────────────────────────────────────────────────

/**
 * Resolve a SecretRef to its plain string value.
 * Throws if the reference cannot be resolved.
 */
export function resolveSecret(ref: SecretRef): string {
  if (typeof ref === "string") {
    return ref;
  }

  if ("env" in ref) {
    const value = process.env[ref.env];
    if (value === undefined) {
      throw new Error(`Secret env var '${ref.env}' is not set`);
    }
    return value;
  }

  if ("file" in ref) {
    try {
      return readFileSync(ref.file, "utf-8").trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Secret file '${ref.file}' unreadable: ${msg}`);
    }
  }

  throw new Error("Invalid SecretRef format");
}

/** Provider type used to prioritize the correct fallback env var. */
export type ProviderType = "openai" | "anthropic";

/**
 * Env vars to try per provider, ordered by priority.
 * The provider's own key is checked first, then the generic key,
 * then any other provider key as a last resort.
 */
const ENV_VARS_BY_PROVIDER: Record<ProviderType, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "PURRFECT_API_KEY", "OPENAI_API_KEY"],
  openai: ["OPENAI_API_KEY", "PURRFECT_API_KEY", "ANTHROPIC_API_KEY"],
};

/** Default fallback order when no provider type is specified. */
const ENV_VARS_DEFAULT: readonly string[] = [
  "PURRFECT_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

/**
 * Try resolving an API key from config, falling back to well-known env vars.
 * When `providerType` is given the provider's own env var is checked first,
 * preventing cross-provider key mix-ups.
 * Returns undefined if nothing is found.
 */
export function resolveApiKey(
  ref: SecretRef | undefined,
  providerType?: ProviderType,
): string | undefined {
  if (ref !== undefined) {
    try {
      return resolveSecret(ref);
    } catch {
      // Fall through to env var detection
    }
  }

  // Auto-detect from well-known env vars, ordered by provider affinity
  const envVars = providerType
    ? ENV_VARS_BY_PROVIDER[providerType]
    : ENV_VARS_DEFAULT;

  for (const name of envVars) {
    const value = process.env[name];
    if (value) return value;
  }

  return undefined;
}

// ── Secret Registry (for log redaction) ───────────────────────────────

export class SecretRegistry {
  private readonly secrets = new Set<string>();

  /** Track a resolved secret value for redaction. */
  track(value: string): void {
    if (value.length >= 4) {
      this.secrets.add(value);
    }
  }

  /** Replace all known secret values in text with [REDACTED]. */
  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) {
      // Use split+join for global replacement without regex escaping issues
      result = result.split(secret).join("[REDACTED]");
    }
    return result;
  }

  /** Check if any secrets are tracked. */
  get size(): number {
    return this.secrets.size;
  }
}
