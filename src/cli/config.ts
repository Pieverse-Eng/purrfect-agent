/**
 * CLI configuration loading and saving.
 * Config is stored at <configDir>/config.json (default ~/.purrfect/config.json).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateConfig, migrateConfig } from "../core/config-schema.js";
import type { Config } from "../core/config-schema.js";
import type { SecretRef } from "../core/secrets.js";

// ── Types ───────────────────────────────────────────────────────────────

/** @deprecated Use Config from core/config-schema instead */
export interface CliConfig {
  apiKey: string | SecretRef;
  model: string;
  baseUrl: string;
  skillsDir: string;
}

// Re-export the v2 Config type for consumers
export type { Config };

// ── Defaults ────────────────────────────────────────────────────────────

export function defaultConfig(): CliConfig {
  return {
    apiKey: "",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    skillsDir: "",
  };
}

// ── Paths ───────────────────────────────────────────────────────────────

export function defaultConfigDir(): string {
  // Honor a process-wide profile override set early in main() (--profile flag
  // or PURRFECT_PROFILE env var). When unset, fall back to the base ~/.purrfect.
  const overrideDir = process.env.PURRFECT_CONFIG_DIR;
  if (overrideDir) return overrideDir;
  return join(homedir(), ".purrfect");
}

function configFilePath(configDir: string): string {
  return join(configDir, "config.json");
}

// ── Load / Save ─────────────────────────────────────────────────────────

export function loadConfig(configDir?: string): CliConfig {
  const dir = configDir ?? defaultConfigDir();
  const filePath = configFilePath(dir);

  if (!existsSync(filePath)) {
    return defaultConfig();
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = migrateConfig(parsed);
    const defaults = defaultConfig();
    return {
      apiKey: validated.apiKey ?? defaults.apiKey,
      model: validated.model ?? defaults.model,
      baseUrl: validated.baseUrl ?? defaults.baseUrl,
      skillsDir: validated.skillsDir ?? defaults.skillsDir,
    };
  } catch {
    return defaultConfig();
  }
}

/**
 * Load config as v2 Config type with full schema validation and migration.
 */
export function loadConfigV2(configDir?: string): Config {
  const dir = configDir ?? defaultConfigDir();
  const filePath = configFilePath(dir);

  if (!existsSync(filePath)) {
    return validateConfig({});
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return migrateConfig(parsed);
}

export function saveConfig(config: CliConfig, configDir?: string): void {
  const dir = configDir ?? defaultConfigDir();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = configFilePath(dir);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Persist a full v2 Config object back to disk. Used by commands that
 * mutate the structured config (mcp add/remove/configure, tools toggle,
 * etc.) so they don't have to round-trip through the legacy CliConfig
 * shape — which only knows about a tiny subset of fields.
 */
export function saveConfigV2(config: Config, configDir?: string): void {
  const dir = configDir ?? defaultConfigDir();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = configFilePath(dir);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
