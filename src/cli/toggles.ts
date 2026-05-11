/**
 * CLI helpers for `purrfect tools enable/disable` and `purrfect plugins enable/disable`.
 *
 * Persists the disabled set in `config.json` under `disabledTools` /
 * `disabledPlugins`. The REPL / gateway hydrate ToolRegistry and PluginLoader
 * from these arrays at boot.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { defaultConfigDir } from "./config.js";

interface RawConfigFile extends Record<string, unknown> {
  disabledTools?: string[];
  disabledPlugins?: string[];
}

function configPath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "config.json");
}

function loadRaw(configDir?: string): RawConfigFile {
  const filePath = configPath(configDir);
  if (!existsSync(filePath)) {
    return {};
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as RawConfigFile;
}

function saveRaw(raw: RawConfigFile, configDir?: string): void {
  const dir = configDir ?? defaultConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath(configDir), JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

function toggle(
  raw: RawConfigFile,
  field: "disabledTools" | "disabledPlugins",
  name: string,
  enabled: boolean,
): void {
  const current = new Set(raw[field] ?? []);
  if (enabled) {
    current.delete(name);
  } else {
    current.add(name);
  }
  raw[field] = [...current].sort();
}

export function setToolEnabled(
  name: string,
  enabled: boolean,
  configDir?: string,
): void {
  const raw = loadRaw(configDir);
  toggle(raw, "disabledTools", name, enabled);
  saveRaw(raw, configDir);
}

export function setPluginEnabled(
  name: string,
  enabled: boolean,
  configDir?: string,
): void {
  const raw = loadRaw(configDir);
  toggle(raw, "disabledPlugins", name, enabled);
  saveRaw(raw, configDir);
}

export function listToolEnablement(
  configDir?: string,
): Array<{ name: string; enabled: boolean }> {
  const raw = loadRaw(configDir);
  const disabled = raw.disabledTools ?? [];
  return disabled.map((name) => ({ name, enabled: false }));
}

export function listPluginEnablement(
  configDir?: string,
): Array<{ name: string; enabled: boolean }> {
  const raw = loadRaw(configDir);
  const disabled = raw.disabledPlugins ?? [];
  return disabled.map((name) => ({ name, enabled: false }));
}

/**
 * Build the enablement-state map (name → enabled) for ToolRegistry.applyEnablement.
 * Names not in this map keep their default enabled=true state.
 */
export function buildToolEnablementMap(
  configDir?: string,
): Record<string, boolean> {
  const raw = loadRaw(configDir);
  const result: Record<string, boolean> = {};
  for (const name of raw.disabledTools ?? []) {
    result[name] = false;
  }
  return result;
}

export function isPluginDisabled(name: string, configDir?: string): boolean {
  const raw = loadRaw(configDir);
  return (raw.disabledPlugins ?? []).includes(name);
}
