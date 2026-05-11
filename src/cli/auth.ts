import { join } from "node:path";
import { CredentialPool, type CredentialProvider } from "../core/credential-pool.js";
import { defaultConfigDir } from "./config.js";

export interface AuthCommandContext {
  configDir?: string;
  output?: (line: string) => void;
}

export async function authCommand(
  args: string,
  context: AuthCommandContext = {},
): Promise<void> {
  const output = context.output ?? ((line: string) => console.log(line));
  const tokens = tokenize(args);
  const action = tokens[0] ?? "list";
  const pool = new CredentialPool({ path: credentialPoolPath(context.configDir) });

  switch (action) {
    case "add": {
      const provider = required(tokens[1], "provider");
      const key = required(tokens[2], "key");
      const label = readOption(tokens, "--label");
      const entry = pool.add({ provider, key, label });
      output(`Added ${entry.provider} credential ${entry.label}`);
      break;
    }
    case "list": {
      const provider = tokens[1];
      const entries = pool.list(provider);
      if (entries.length === 0) {
        output(provider ? `No credentials for ${provider}` : "No credentials");
        break;
      }
      for (const entry of entries) {
        const suffix = entry.lastError ? ` (${entry.lastError})` : "";
        output(`${entry.provider} ${entry.label} ${entry.status} ${maskKey(entry.key)}${suffix}`);
      }
      break;
    }
    case "rotate": {
      const provider = required(tokens[1], "provider");
      const entry = pool.rotate(provider);
      if (!entry) {
        output(`No healthy credentials for ${provider}`);
        break;
      }
      output(`Current key: ${entry.label}`);
      break;
    }
    case "reset": {
      const provider = tokens[1];
      pool.reset(provider);
      output(provider ? `Reset ${provider} credentials` : "Reset all credentials");
      break;
    }
    case "remove": {
      const provider = required(tokens[1], "provider");
      const labelOrKey = required(tokens[2], "label or key");
      const removed = pool.remove(provider, labelOrKey);
      output(removed ? `Removed ${provider} credential ${labelOrKey}` : `Credential not found: ${labelOrKey}`);
      break;
    }
    default:
      throw new Error(`Unknown auth command: ${action}`);
  }
}

export function credentialPoolPath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "credentials.json");
}

function required(value: string | undefined, name: string): CredentialProvider {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readOption(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}
