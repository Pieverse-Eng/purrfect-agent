/**
 * CLI helpers for `purrfect hooks list/test/add` — manages `hooks` section of config.json.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { defaultConfigDir } from "./config.js";
import { runUserHooks, type UserHooksConfig } from "../core/user-hooks.js";
import type { UserHookConfig } from "../core/config-schema.js";

interface RawConfigFile extends Record<string, unknown> {
  hooks?: UserHooksConfig;
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

const PHASES = ["preToolUse", "postToolUse", "stop"] as const;
type Phase = (typeof PHASES)[number];

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export function listUserHooks(configDir?: string): void {
  const raw = loadRaw(configDir);
  const hooks = raw.hooks;
  if (!hooks) {
    console.log("No user hooks configured.");
    return;
  }
  let total = 0;
  for (const phase of PHASES) {
    const list = hooks[phase] ?? [];
    if (list.length === 0) continue;
    console.log(`\n${phase} (${list.length}):`);
    for (const h of list) {
      const matcher = phase === "stop" ? "—" : h.matcher;
      const onFailure = h.onFailure ?? "warn";
      console.log(
        `  matcher=${matcher}  onFailure=${onFailure}  cmd=${h.command}`,
      );
      total++;
    }
  }
  if (total === 0) {
    console.log("No user hooks configured.");
  }
}

export function addUserHook(
  phase: string,
  matcher: string,
  command: string,
  configDir?: string,
): void {
  if (!isPhase(phase)) {
    console.error(`Invalid phase "${phase}". Use one of: ${PHASES.join(", ")}.`);
    process.exit(1);
  }
  const raw = loadRaw(configDir);
  const hooks: UserHooksConfig = raw.hooks ?? { preToolUse: [], postToolUse: [], stop: [] };
  const list = (hooks[phase] ?? []) as UserHookConfig[];
  const next: UserHookConfig = {
    matcher: phase === "stop" ? "*" : matcher,
    command,
    onFailure: "warn",
  };
  list.push(next);
  hooks[phase] = list;
  raw.hooks = hooks;
  saveRaw(raw, configDir);
  console.log(`Added ${phase} hook for matcher "${matcher}".`);
}

export async function testUserHook(
  toolName: string,
  configDir?: string,
): Promise<void> {
  const raw = loadRaw(configDir);
  const hooks = raw.hooks;
  if (!hooks) {
    console.log("No hooks configured.");
    return;
  }
  console.log(`Testing preToolUse and postToolUse hooks for tool "${toolName}":\n`);

  const ctxArgs = { sample: "value" };
  const ctxResult = JSON.stringify({ ok: true });

  const pre = await runUserHooks(hooks, "preToolUse", {
    toolName,
    args: ctxArgs,
  });
  for (const o of pre) {
    console.log(
      `  [pre] exit=${o.exitCode} blocked=${o.blocked} timedOut=${o.timedOut}`,
    );
    if (o.stdout) console.log(`    stdout: ${o.stdout.trim().slice(0, 200)}`);
    if (o.stderr) console.log(`    stderr: ${o.stderr.trim().slice(0, 200)}`);
  }
  const post = await runUserHooks(hooks, "postToolUse", {
    toolName,
    args: ctxArgs,
    result: ctxResult,
  });
  for (const o of post) {
    console.log(
      `  [post] exit=${o.exitCode} timedOut=${o.timedOut}`,
    );
    if (o.stdout) console.log(`    stdout: ${o.stdout.trim().slice(0, 200)}`);
    if (o.stderr) console.log(`    stderr: ${o.stderr.trim().slice(0, 200)}`);
  }
  if (pre.length === 0 && post.length === 0) {
    console.log("  (no matching hooks)");
  }
}
