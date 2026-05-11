/**
 * Setup command — interactive prompts for API key, model, base URL, skills dir.
 */

import * as readline from "node:readline";
import { loadConfig, saveConfig, defaultConfigDir } from "./config.js";
import type { CliConfig } from "./config.js";
import type { SecretRef } from "../core/secrets.js";

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
  } finally {
    rl.close();
  }
}
