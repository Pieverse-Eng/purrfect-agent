/**
 * Doctor command — checks config file, API key, SQLite availability,
 * and skills directory.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, defaultConfigDir } from "./config.js";
import { resolveSecret, resolveApiKey } from "../core/secrets.js";
import { SessionStore } from "../core/session-store.js";
import { CredentialPool } from "../core/credential-pool.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  status: "ok" | "fail" | "warn";
  message: string;
}

// ── Doctor logic ────────────────────────────────────────────────────────

export async function runDoctor(configDir?: string): Promise<DoctorCheck[]> {
  const dir = configDir ?? defaultConfigDir();
  const results: DoctorCheck[] = [];

  // 1. Config file exists
  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) {
    results.push({ name: "config_file", status: "ok", message: `Config found at ${configPath}` });
  } else {
    results.push({ name: "config_file", status: "fail", message: `Config not found at ${configPath}. Run 'purrfect setup'.` });
  }

  // 2. API key set and resolvable
  const config = loadConfig(dir);
  const resolvedKey = resolveApiKey(config.apiKey);
  if (resolvedKey) {
    // Warn if raw string secret is used (suggest env/file ref)
    if (typeof config.apiKey === "string" && config.apiKey.length > 0) {
      results.push({
        name: "api_key",
        status: "warn",
        message: "API key is a raw string in config. Consider using { env: \"ANTHROPIC_API_KEY\" } instead.",
      });
    } else {
      results.push({ name: "api_key", status: "ok", message: "API key resolved successfully" });
    }
  } else {
    results.push({ name: "api_key", status: "fail", message: "API key not set or unresolvable. Run 'purrfect setup'." });
  }

  // 3. SQLite available
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    require("better-sqlite3");
    results.push({ name: "sqlite", status: "ok", message: "better-sqlite3 is available" });
  } catch {
    results.push({ name: "sqlite", status: "fail", message: "better-sqlite3 not available. Run 'npm install'." });
  }

  // 4. Skills directory
  if (config.skillsDir && config.skillsDir.length > 0) {
    if (existsSync(config.skillsDir)) {
      results.push({ name: "skills_dir", status: "ok", message: `Skills directory found at ${config.skillsDir}` });
    } else {
      results.push({ name: "skills_dir", status: "warn", message: `Skills directory not found at ${config.skillsDir}` });
    }
  } else {
    results.push({ name: "skills_dir", status: "warn", message: "No skills directory configured" });
  }

  // 5. Prompt cache usage visibility
  const pool = new CredentialPool({ path: join(dir, "credentials.json") });
  const credentials = pool.list();
  if (credentials.length > 0) {
    const healthy = credentials.filter((entry) => entry.status === "healthy").length;
    results.push({
      name: "credential_pool",
      status: healthy > 0 ? "ok" : "warn",
      message: `${healthy}/${credentials.length} credentials healthy`,
    });
  } else {
    results.push({
      name: "credential_pool",
      status: "warn",
      message: "No credential pool configured",
    });
  }

  // 6. Prompt cache usage visibility
  try {
    const store = new SessionStore(join(dir, "sessions.db"));
    try {
      const usage = store.getAggregateTokenUsage();
      if (!usage) {
        results.push({
          name: "prompt_cache",
          status: "warn",
          message: "No prompt cache usage recorded yet",
        });
      } else {
        const totalCacheTokens =
          usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
        const hitRate = totalCacheTokens === 0
          ? 0
          : Math.round((usage.cache_read_input_tokens / totalCacheTokens) * 100);
        results.push({
          name: "prompt_cache",
          status: totalCacheTokens > 0 ? "ok" : "warn",
          message: `Prompt cache hit rate ${hitRate}% (${usage.cache_read_input_tokens} read / ${usage.cache_creation_input_tokens} created input tokens across ${usage.requests} requests)`,
        });
      }
    } finally {
      store.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({
      name: "prompt_cache",
      status: "warn",
      message: `Prompt cache usage unavailable: ${message}`,
    });
  }

  return results;
}

// ── CLI output ──────────────────────────────────────────────────────────

export function printDoctorResults(results: DoctorCheck[]): void {
  console.log("\npurrfect doctor\n");
  for (const check of results) {
    const icon = check.status === "ok" ? "[OK]" : check.status === "warn" ? "[WARN]" : "[FAIL]";
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }
  console.log();
}
