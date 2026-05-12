/**
 * `purrfect onboard` — register the agent with Purr-Fect Claws and save the
 * resulting wallet identity at `~/.purrfect/agent.env`.
 *
 * Required for onchain WRITE skills (signing, swaps, sends). Read-only
 * skills work without it. Setup invokes this automatically (opt-in Y/n);
 * users can also run it manually.
 *
 * See https://purr.pieverse.io/agent-onboard.md
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { defaultConfigDir } from "./config.js";

const REGISTER_URL = "https://purr.pieverse.io/v1/agents/register";
const AGENT_ENV_FILE = "agent.env";
const DEFAULT_CHAIN_TYPE = "ethereum";

export interface OnboardOptions {
  configDir?: string;
  agentName?: string;
  chainType?: string;
  /** Override the HTTP fetch (tests pass a mock; production uses global fetch). */
  fetchFn?: typeof fetch;
  /** Override the output sink (tests pass a buffer; production prints to stdout). */
  output?: (line: string) => void;
}

export interface AgentWallet {
  address: string;
  chainId: number;
  chainType: string;
}

export interface OnboardResult {
  agentId: string;
  apiKey: string;
  wallet: AgentWallet | null;
  envPath: string;
}

interface RegisterSuccess {
  ok: true;
  data: {
    agentId: string;
    apiKey: string;
    walletProvisioned: boolean;
    wallet: AgentWallet | null;
  };
}

interface RegisterError {
  ok: false;
  error: string;
}

type RegisterResponse = RegisterSuccess | RegisterError;

/** Suggest a host-derived agent name; deterministic prefix + short random suffix. */
export function defaultAgentName(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "purrfect";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${host}-${suffix}`;
}

/** Path to the agent identity env file inside a given config dir. */
export function agentEnvPath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), AGENT_ENV_FILE);
}

/** Read agent.env back into a plain object. Returns null when the file doesn't exist. */
export function loadAgentEnv(configDir?: string): Record<string, string> | null {
  const path = agentEnvPath(configDir);
  if (!existsSync(path)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export async function runOnboard(options: OnboardOptions = {}): Promise<OnboardResult> {
  const configDir = options.configDir ?? defaultConfigDir();
  const agentName = options.agentName ?? defaultAgentName();
  const chainType = options.chainType ?? DEFAULT_CHAIN_TYPE;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const log = options.output ?? ((line: string) => console.log(line));

  log(`Registering agent "${agentName}" on Purr-Fect Claws...`);

  let response: Response;
  try {
    response = await fetchFn(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: agentName, chainType }),
    });
  } catch (err) {
    throw new Error(`Onboard failed (network): ${err instanceof Error ? err.message : String(err)}`);
  }

  let body: RegisterResponse;
  try {
    body = (await response.json()) as RegisterResponse;
  } catch {
    throw new Error(`Onboard failed: server returned non-JSON (status ${response.status})`);
  }

  if (response.status === 409) {
    const reason = !body.ok ? body.error : "name conflict";
    throw new Error(`Agent name "${agentName}" is already taken (${reason}). Try a different name.`);
  }
  if (!response.ok || !body.ok) {
    const reason = !body.ok ? body.error : `HTTP ${response.status}`;
    throw new Error(`Onboard failed: ${reason}`);
  }

  const { agentId, apiKey, walletProvisioned, wallet } = body.data;
  const envPath = writeAgentEnv(configDir, { agentId, apiKey, walletProvisioned, wallet });

  log(`  Agent ID: ${agentId}`);
  if (wallet) {
    log(`  Wallet:   ${wallet.address} (chain ${wallet.chainType}, id ${wallet.chainId})`);
  } else {
    log(`  Wallet:   pending provisioning`);
  }
  log(`  Saved:    ${envPath}`);
  log(`            (apiKey lives here; it is not shown again)`);

  return { agentId, apiKey, wallet, envPath };
}

function writeAgentEnv(
  configDir: string,
  data: {
    agentId: string;
    apiKey: string;
    walletProvisioned: boolean;
    wallet: AgentWallet | null;
  },
): string {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const path = agentEnvPath(configDir);

  const lines = [
    "# Pieverse agent identity — written by `purrfect onboard`.",
    "# Do not commit. Treat AGENT_API_KEY like a password.",
    `AGENT_ID=${data.agentId}`,
    `AGENT_API_KEY=${data.apiKey}`,
    `AGENT_WALLET_PROVISIONED=${String(data.walletProvisioned)}`,
  ];
  if (data.wallet) {
    lines.push(
      `AGENT_WALLET_ADDRESS=${data.wallet.address}`,
      `AGENT_WALLET_CHAIN_ID=${String(data.wallet.chainId)}`,
      `AGENT_WALLET_CHAIN_TYPE=${data.wallet.chainType}`,
    );
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return path;
}
