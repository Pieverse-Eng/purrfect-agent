/**
 * Config schema definition and validation using Zod.
 * Supports v1 → v2 config migration.
 */

import { z } from "zod";
import { SecretRefSchema } from "./secrets.js";

// ── Schema ─────────────────────────────────────────────────────────────

const PermissionsSchema = z.object({
  allowTools: z.array(z.string()).default([]),
  denyTools: z.array(z.string()).default([]),
  denyPatterns: z.array(z.string()).default([]),
});

const IdentitySchema = z.object({
  name: z.string().optional(),
  persona: z.string().optional(),
  instructions: z.string().optional(),
});

const McpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * If set, only these tools are exposed to the agent. Unset means "all
   * tools advertised by the server" (current default behavior).
   */
  enabledTools: z.array(z.string()).optional(),
});

export type McpServerConfig = z.infer<typeof McpServerSchema>;

const ModelTiersSchema = z.object({
  fast: z.string().optional(),
  balanced: z.string().optional(),
  deep: z.string().optional(),
});

const SmartModelRoutingSchema = z.object({
  enabled: z.boolean().default(false),
});

const MemoryBackendConfigSchema = z.object({
  backend: z.enum(["local", "http"]).default("local"),
  endpoint: z.string().optional(),
  apiKey: SecretRefSchema.optional(),
  namespace: z.string().optional(),
});

export type MemoryBackendConfig = z.infer<typeof MemoryBackendConfigSchema>;

const UserHookSchema = z.object({
  /** Tool-name glob ("*" or "file_*"). For "stop" hooks the matcher is ignored. */
  matcher: z.string().default("*"),
  /** Shell command template. Supports {{tool_name}}, {{args_json}}, {{result_json}}. */
  command: z.string(),
  /** Hard timeout in milliseconds; default 5_000. */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * What to do when the hook fails:
   *   - "block" — for preToolUse only: skip the tool call.
   *   - "warn"  — log a warning, continue.
   *   - "log"   — silently record exit code, continue.
   */
  onFailure: z.enum(["block", "warn", "log"]).default("warn"),
});

export type UserHookConfig = z.infer<typeof UserHookSchema>;

const UserHooksSchema = z.object({
  preToolUse: z.array(UserHookSchema).default([]),
  postToolUse: z.array(UserHookSchema).default([]),
  stop: z.array(UserHookSchema).default([]),
});

export const ConfigSchema = z
  .object({
    apiKey: SecretRefSchema.optional(),
    model: z.string().default("gpt-4o"),
    baseUrl: z.string().default("https://api.openai.com/v1"),
    providerType: z.enum(["openai", "anthropic"]).default("openai"),
    fallbackModels: z.array(z.string()).default([]),
    modelTiers: ModelTiersSchema.default({}),
    smartModelRouting: SmartModelRoutingSchema.default({ enabled: false }),
    skillsDir: z.string().optional(),
    memoriesDir: z.string().optional(),
    memory: MemoryBackendConfigSchema.optional(),
    sessionDbPath: z.string().optional(),
    permissions: PermissionsSchema.optional(),
    permissionMode: z.enum(["allow-all", "deny-by-default"]).default("allow-all"),
    identity: IdentitySchema.optional(),
    mcpServers: z.array(McpServerSchema).default([]),
    pluginDirs: z.array(z.string()).default([]),
    allowedPaths: z.array(z.string()).optional(),
    sandbox: z.enum(["none", "process", "container"]).default("none"),
    /** User-defined shell hooks fired around tool calls. */
    hooks: UserHooksSchema.default({ preToolUse: [], postToolUse: [], stop: [] }),
    /** Tools toggled off via `purrfect tools disable <name>`. */
    disabledTools: z.array(z.string()).default([]),
    /** Plugins toggled off via `purrfect plugins disable <name>`. */
    disabledPlugins: z.array(z.string()).default([]),
    configVersion: z.number().default(2),
  })
  .passthrough();

// ── Inferred type ──────────────────────────────────────────────────────

export type Config = z.infer<typeof ConfigSchema>;

// ── Validate ───────────────────────────────────────────────────────────

/**
 * Validate raw config input against the schema.
 * Returns a typed Config on success; throws with descriptive Zod errors on failure.
 */
export function validateConfig(raw: unknown): Config {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid config: expected an object but received ${raw === null ? "null" : typeof raw}`,
    );
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new Error(`Config validation failed: ${messages}`);
  }
  return result.data;
}

// ── Migrate ────────────────────────────────────────────────────────────

/**
 * Detect v1 configs (no configVersion field) and migrate to v2 by adding defaults.
 * If already v2+, returns validated config as-is.
 */
export function migrateConfig(old: unknown): Config {
  if (old !== null && typeof old === "object" && !Array.isArray(old)) {
    const record = old as Record<string, unknown>;
    if (record.configVersion === undefined) {
      // v1 config detected — inject v2 defaults before validation
      record.configVersion = 2;
    }
  }
  return validateConfig(old);
}
