/**
 * Pure arg-parser for the `purrfect pairing` subcommand.
 *
 * Lives separately from the runtime so the synchronous CLI parser in
 * index.ts can call it without dragging in PairingStore / fs.
 */

import type { PairingRole } from "../gateway/acl.js";

export type PairingAction =
  | { kind: "list" }
  | { kind: "approve"; code: string; role?: PairingRole }
  | { kind: "revoke"; platform: string; userId: string }
  | { kind: "clear-pending" }
  | { kind: "promote"; platform: string; userId: string; role: PairingRole };

const VALID_ROLES = new Set<PairingRole>(["admin", "user", "guest"]);

function parseRole(input: string | undefined): PairingRole | undefined {
  if (!input) return undefined;
  const v = input.toLowerCase() as PairingRole;
  if (!VALID_ROLES.has(v)) {
    throw new Error(`Invalid role "${input}". Valid: admin, user, guest.`);
  }
  return v;
}

function parseUserToken(token: string): { platform: string; userId: string } {
  const colon = token.indexOf(":");
  if (colon <= 0 || colon === token.length - 1) {
    throw new Error(`Expected platform:userId, got "${token}".`);
  }
  return {
    platform: token.slice(0, colon),
    userId: token.slice(colon + 1),
  };
}

export function parsePairingArgs(args: string[]): PairingAction {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };
    case "approve": {
      const code = args[1];
      if (!code) {
        throw new Error("Usage: pairing approve <code> [--role admin|user|guest]");
      }
      let role: PairingRole | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--role" && args[i + 1]) {
          role = parseRole(args[++i]);
        }
      }
      return { kind: "approve", code, ...(role ? { role } : {}) };
    }
    case "revoke": {
      const token = args[1];
      if (!token) {
        throw new Error("Usage: pairing revoke <platform:userId>");
      }
      return { kind: "revoke", ...parseUserToken(token) };
    }
    case "clear-pending":
      return { kind: "clear-pending" };
    case "promote": {
      const token = args[1];
      const roleInput = args[2];
      if (!token || !roleInput) {
        throw new Error("Usage: pairing promote <platform:userId> <role>");
      }
      const role = parseRole(roleInput);
      if (!role) throw new Error("Role is required.");
      return { kind: "promote", ...parseUserToken(token), role };
    }
    default:
      throw new Error(
        `Unknown pairing subcommand: ${sub}. Valid: list, approve, revoke, clear-pending, promote`,
      );
  }
}
