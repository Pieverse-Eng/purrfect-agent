/**
 * `purrfect pairing` runtime — wraps the gateway PairingStore for admin
 * use from the command line.
 */

import { join } from "node:path";
import { defaultConfigDir } from "./config.js";
import { PairingStore, type PairingEntry } from "../gateway/acl.js";
import type { PairingAction } from "./pairing-args.js";
export { parsePairingArgs, type PairingAction } from "./pairing-args.js";

export interface PairingCommandContext {
  configDir?: string;
  /** Inject store for tests. */
  store?: PairingStore;
  output?: (text: string) => void;
}

const DEFAULT_PAIRING_FILE = "pairing.json";

function getStore(ctx: PairingCommandContext): PairingStore {
  if (ctx.store) return ctx.store;
  const dir = ctx.configDir ?? defaultConfigDir();
  return new PairingStore({ path: join(dir, DEFAULT_PAIRING_FILE) });
}

function describeEntry(entry: PairingEntry): string {
  const target = `${entry.platform}:${entry.userId}`;
  const name = entry.userName ? ` (${entry.userName})` : "";
  if (entry.status === "pending") {
    return `  [pending]  ${target}${name}  code=${entry.code ?? "?"}`;
  }
  if (entry.status === "revoked") {
    return `  [revoked]  ${target}${name}`;
  }
  return `  [${entry.role.padEnd(5)}]  ${target}${name}`;
}

export function runPairingCommand(
  action: PairingAction,
  ctx: PairingCommandContext = {},
): void {
  const out = ctx.output ?? ((text: string) => console.log(text));
  const store = getStore(ctx);

  switch (action.kind) {
    case "list": {
      const entries = store.list();
      if (entries.length === 0) {
        out("No pairing entries.");
        return;
      }
      const sorted = [...entries].sort((a, b) => {
        const order = { pending: 0, approved: 1, revoked: 2 } as const;
        return order[a.status] - order[b.status];
      });
      out(`Pairing entries (${entries.length}):`);
      for (const e of sorted) out(describeEntry(e));
      return;
    }
    case "approve": {
      const entry = store.approve(action.code, action.role ?? "user");
      out(
        `Approved ${entry.platform}:${entry.userId} as ${entry.role}.`,
      );
      return;
    }
    case "revoke": {
      const entry = store.revoke(action.platform, action.userId);
      out(`Revoked ${entry.platform}:${entry.userId}.`);
      return;
    }
    case "clear-pending": {
      const dropped = store.clearPending();
      out(`Cleared ${dropped} pending pairing${dropped === 1 ? "" : "s"}.`);
      return;
    }
    case "promote": {
      const entry = store.setRole(action.platform, action.userId, action.role);
      out(
        `Set role for ${entry.platform}:${entry.userId} → ${entry.role}.`,
      );
      return;
    }
  }
}
