/**
 * Pairing-based gateway ACL.
 *
 * Persistent file-backed store (`~/.purrfect/pairing.json`) that tracks
 * which (platform, userId) pairs are allowed to drive the agent and what
 * role each one has. New users are auto-issued a one-time pairing code on
 * their first message; an admin runs `purrfect pairing approve <code>` to
 * promote them from `pending` to a usable role.
 *
 * The store is intentionally stateless across processes: every read /
 * write loads + writes the JSON file, so the long-running gateway and the
 * one-shot admin CLI never disagree.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type PairingRole = "admin" | "user" | "guest";
export type PairingStatus = "pending" | "approved" | "revoked";

export interface PairingEntry {
  platform: string;
  userId: string;
  /** Display hint persisted from the user's last message (if known). */
  userName?: string;
  /** Active pairing code while status === "pending". */
  code?: string;
  status: PairingStatus;
  role: PairingRole;
  /** Epoch ms of first appearance. */
  createdAt: number;
  /** Epoch ms of approval (only when status === "approved"). */
  approvedAt?: number;
}

interface PairingFile {
  version: 1;
  entries: PairingEntry[];
}

const FILE_VERSION = 1;

function entryKey(platform: string, userId: string): string {
  return `${platform}:${userId}`;
}

/** Generates a 6-character upper-case alphanumeric pairing code. */
export function generatePairingCode(): string {
  // 4 random bytes → 6 base32-ish characters. Ambiguous chars (0/O, 1/I)
  // are skipped so codes can be read aloud reliably.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
}

export interface PairingStoreOptions {
  /** Path to pairing.json. Created on first write if absent. */
  path: string;
  /** Override clock in tests. */
  now?: () => number;
  /** Override code generator in tests. */
  generateCode?: () => string;
}

export class PairingStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly generate: () => string;

  constructor(options: PairingStoreOptions) {
    this.path = options.path;
    this.now = options.now ?? (() => Date.now());
    this.generate = options.generateCode ?? generatePairingCode;
  }

  // ── Persistence helpers ────────────────────────────────────────────

  private read(): PairingFile {
    if (!existsSync(this.path)) {
      return { version: FILE_VERSION, entries: [] };
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PairingFile>;
      if (
        parsed &&
        Array.isArray(parsed.entries) &&
        parsed.version === FILE_VERSION
      ) {
        return { version: FILE_VERSION, entries: parsed.entries };
      }
    } catch {
      // Corrupt file — start fresh rather than crashing the gateway.
    }
    return { version: FILE_VERSION, entries: [] };
  }

  private write(file: PairingFile): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n", "utf-8");
  }

  // ── Reads ──────────────────────────────────────────────────────────

  list(): PairingEntry[] {
    return this.read().entries;
  }

  find(platform: string, userId: string): PairingEntry | undefined {
    return this.read().entries.find(
      (e) => entryKey(e.platform, e.userId) === entryKey(platform, userId),
    );
  }

  findByCode(code: string): PairingEntry | undefined {
    const upper = code.trim().toUpperCase();
    return this.read().entries.find(
      (e) => e.status === "pending" && e.code === upper,
    );
  }

  // ── Writes ─────────────────────────────────────────────────────────

  /**
   * Look up the entry for `(platform, userId)`. If absent, create a
   * pending entry with a fresh pairing code. Idempotent: existing pending
   * entries return their existing code; approved entries return as-is.
   *
   * Returns the resulting entry — callers inspect `status` to decide
   * whether to forward the message into the agent (`approved`) or reply
   * with a code prompt (`pending` / freshly-created).
   */
  ensurePending(
    platform: string,
    userId: string,
    userName?: string,
  ): PairingEntry {
    const file = this.read();
    const idx = file.entries.findIndex(
      (e) => entryKey(e.platform, e.userId) === entryKey(platform, userId),
    );
    if (idx !== -1) {
      const existing = file.entries[idx];
      if (userName && existing.userName !== userName) {
        const next = { ...existing, userName };
        file.entries[idx] = next;
        this.write(file);
        return next;
      }
      return existing;
    }

    const entry: PairingEntry = {
      platform,
      userId,
      ...(userName ? { userName } : {}),
      code: this.generate(),
      status: "pending",
      role: "user",
      createdAt: this.now(),
    };
    file.entries.push(entry);
    this.write(file);
    return entry;
  }

  /**
   * Approve a pending entry by its code. Returns the updated entry on
   * success; throws when the code does not match a pending entry. The
   * caller can override the resulting role (default `user`).
   */
  approve(code: string, role: PairingRole = "user"): PairingEntry {
    const file = this.read();
    const upper = code.trim().toUpperCase();
    const idx = file.entries.findIndex(
      (e) => e.status === "pending" && e.code === upper,
    );
    if (idx === -1) {
      throw new Error(`No pending pairing matches code "${code}".`);
    }
    const entry = file.entries[idx];
    const next: PairingEntry = {
      ...entry,
      status: "approved",
      role,
      approvedAt: this.now(),
      code: undefined,
    };
    file.entries[idx] = next;
    this.write(file);
    return next;
  }

  /**
   * Revoke an approved (or pending) user. Marks the entry `revoked` so
   * future messages are denied without re-issuing a fresh pairing code
   * automatically.
   */
  revoke(platform: string, userId: string): PairingEntry {
    const file = this.read();
    const idx = file.entries.findIndex(
      (e) => entryKey(e.platform, e.userId) === entryKey(platform, userId),
    );
    if (idx === -1) {
      throw new Error(`No pairing entry for ${platform}:${userId}.`);
    }
    const next: PairingEntry = {
      ...file.entries[idx],
      status: "revoked",
      code: undefined,
    };
    file.entries[idx] = next;
    this.write(file);
    return next;
  }

  /**
   * Drop every entry currently stuck in `pending`. Useful when an admin
   * accidentally generated stale codes and wants a clean slate.
   */
  clearPending(): number {
    const file = this.read();
    const before = file.entries.length;
    file.entries = file.entries.filter((e) => e.status !== "pending");
    const dropped = before - file.entries.length;
    if (dropped > 0) this.write(file);
    return dropped;
  }

  /**
   * Update an approved user's role (e.g. promote `user` → `admin`).
   * Throws when the entry is not approved.
   */
  setRole(platform: string, userId: string, role: PairingRole): PairingEntry {
    const file = this.read();
    const idx = file.entries.findIndex(
      (e) => entryKey(e.platform, e.userId) === entryKey(platform, userId),
    );
    if (idx === -1) {
      throw new Error(`No pairing entry for ${platform}:${userId}.`);
    }
    const entry = file.entries[idx];
    if (entry.status !== "approved") {
      throw new Error(
        `Cannot set role on a ${entry.status} entry. Approve it first.`,
      );
    }
    const next: PairingEntry = { ...entry, role };
    file.entries[idx] = next;
    this.write(file);
    return next;
  }
}

// ── Decision helper used by the gateway handler ────────────────────────

export type AclDecision =
  | { kind: "allow"; entry: PairingEntry }
  | { kind: "pending"; entry: PairingEntry }
  | { kind: "denied"; reason: string };

/**
 * Combines `ensurePending` + status check into a single call so handlers
 * can branch on `kind`:
 *
 *   - "allow"   → forward the message to the agent loop
 *   - "pending" → reply with the pairing code, do NOT forward
 *   - "denied"  → reply with a generic refusal (revoked users)
 *
 * `requireApproval = false` short-circuits the whole flow with `allow`,
 * which is what the gateway does when pairing is disabled.
 */
export function evaluatePairing(
  store: PairingStore,
  platform: string,
  userId: string,
  options: { requireApproval: boolean; userName?: string } = {
    requireApproval: true,
  },
): AclDecision {
  if (!options.requireApproval) {
    const entry = store.find(platform, userId);
    return entry
      ? { kind: "allow", entry }
      : {
          kind: "allow",
          entry: {
            platform,
            userId,
            ...(options.userName ? { userName: options.userName } : {}),
            status: "approved",
            role: "user",
            createdAt: 0,
          },
        };
  }

  const entry = store.ensurePending(platform, userId, options.userName);
  if (entry.status === "approved") return { kind: "allow", entry };
  if (entry.status === "pending") return { kind: "pending", entry };
  return { kind: "denied", reason: "Access revoked." };
}

export function formatPairingPrompt(entry: PairingEntry): string {
  return [
    "You're not approved to use this agent yet.",
    "",
    `Pairing code: ${entry.code}`,
    "",
    "Ask an administrator to run:",
    `  purrfect pairing approve ${entry.code}`,
  ].join("\n");
}
