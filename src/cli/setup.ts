/**
 * Setup command — interactive prompts for API key, model, base URL, skills dir.
 */

import * as readline from "node:readline";
import { loadConfig, saveConfig, defaultConfigDir } from "./config.js";
import type { CliConfig } from "./config.js";
import type { SecretRef } from "../core/secrets.js";
import { SkillHub } from "../core/skills/hub.js";
import { runOnboard, defaultAgentName } from "./onboard.js";

function ask(rl: readline.Interface, question: string, defaultValue: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

/**
 * Format a SecretRef for display in setup prompts.
 * Structured refs show their type/source rather than exposing the resolved value.
 */
function describeSecretRef(ref: string | SecretRef): string {
  if (typeof ref === "string") {
    return ref;
  }
  if ("env" in ref) {
    return `env:${ref.env}`;
  }
  if ("file" in ref) {
    return `file:${ref.file}`;
  }
  return "";
}

/**
 * Parse user input back into a SecretRef.
 * Recognizes "env:VAR_NAME" and "file:/path" prefixes; everything else
 * is treated as a raw string key.
 */
function parseSecretRefInput(input: string): string | SecretRef {
  if (input.startsWith("env:")) {
    return { env: input.slice(4) };
  }
  if (input.startsWith("file:")) {
    return { file: input.slice(5) };
  }
  return input;
}

export async function runSetup(configDir?: string): Promise<void> {
  const dir = configDir ?? defaultConfigDir();
  const existing = loadConfig(dir);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\npurrfect setup\n");

  let onboardChoice: { agentName: string } | null = null;
  try {
    const apiKeyDisplay = describeSecretRef(existing.apiKey);
    const apiKeyInput = await ask(rl, "API Key (use env:VAR or file:/path for refs)", apiKeyDisplay);
    // If user didn't change the displayed value, preserve the original SecretRef
    const apiKey = apiKeyInput === apiKeyDisplay ? existing.apiKey : parseSecretRefInput(apiKeyInput);
    const model = await ask(rl, "Model", existing.model);
    const baseUrl = await ask(rl, "Base URL", existing.baseUrl);
    const skillsDir = await ask(rl, "Skills directory", existing.skillsDir);

    const config: CliConfig = { apiKey, model, baseUrl, skillsDir };
    saveConfig(config, dir);

    console.log("\nConfig saved.\n");

    const onboardAnswer = (
      await ask(rl, "Onboard agent wallet via Purr-Fect Claws? (needed for onchain WRITE skills) (Y/n)", "Y")
    )
      .trim()
      .toLowerCase();
    if (onboardAnswer !== "n" && onboardAnswer !== "no") {
      const agentName = await ask(rl, "Agent name", defaultAgentName());
      onboardChoice = { agentName };
    }
  } finally {
    rl.close();
  }

  await autoInstallDefaultSkills({ configDir: dir });

  if (onboardChoice) {
    try {
      await runOnboard({ configDir: dir, agentName: onboardChoice.agentName });
    } catch (err) {
      console.log(`\nOnboard failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log("Run `purrfect onboard` later to retry.\n");
    }
  } else {
    console.log("Skipped onboard. Run `purrfect onboard` later for onchain WRITE operations.\n");
  }
}

export interface AutoInstallSkillsOptions {
  configDir: string;
  /** Override the output sink (tests pass a buffer; production prints to stdout). */
  output?: (line: string) => void;
  /** Override the SkillHub factory (tests pass a hub with a local tap). */
  hubFactory?: (configDir: string) => SkillHub;
}

export interface AutoInstallSkillsResult {
  installed: number;
  failed: number;
  errors: string[];
}

/**
 * Best-effort install of every skill in every registered tap.
 *
 * Runs after `purrfect setup` so that "ships with onchain skills" is true the
 * first time the user prompts the agent. Network failures are non-fatal —
 * setup completes regardless, and the user gets a one-line recovery hint.
 */
export async function autoInstallDefaultSkills(
  options: AutoInstallSkillsOptions,
): Promise<AutoInstallSkillsResult> {
  const log = options.output ?? ((line: string) => console.log(line));
  const hub = options.hubFactory ? options.hubFactory(options.configDir) : new SkillHub({ configDir: options.configDir });

  if (hub.listTaps().length === 0) {
    return { installed: 0, failed: 0, errors: [] };
  }

  log("Installing onchain skill commons (this may take a moment)...");

  let available;
  try {
    available = hub.browse();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  Skipped — couldn't reach the skill taps (${msg}).`);
    log("  Run `purrfect skills install <name>` later when you have network access.");
    return { installed: 0, failed: 0, errors: [msg] };
  }

  if (available.length === 0) {
    log("  No skills found in registered taps.");
    return { installed: 0, failed: 0, errors: [] };
  }

  let installed = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const skill of available) {
    try {
      hub.install(skill.name, { tap: skill.tap });
      installed++;
    } catch (err) {
      failed++;
      errors.push(`${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`  ${installed} installed${failed > 0 ? `, ${failed} skipped` : ""}.`);
  if (errors.length > 0 && errors.length <= 3) {
    for (const error of errors) log(`    - ${error}`);
  }

  return { installed, failed, errors };
}
