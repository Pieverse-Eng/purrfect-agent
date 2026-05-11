import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type CredentialProvider = "openai" | "anthropic" | string;
export type CredentialStatus = "healthy" | "rate_limited" | "exhausted";

export interface CredentialPoolEntry {
  provider: CredentialProvider;
  key: string;
  label: string;
  status: CredentialStatus;
  lastError?: string;
  resetAt?: number;
}

export interface CredentialPoolOptions {
  path?: string;
}

interface CredentialFile {
  credentials: CredentialPoolEntry[];
}

export class CredentialPool {
  readonly path: string;
  private credentials: CredentialPoolEntry[];

  constructor(options: CredentialPoolOptions = {}) {
    this.path = options.path ?? join(homedir(), ".purrfect", "credentials.json");
    this.credentials = this.load();
  }

  add(entry: {
    provider: CredentialProvider;
    key: string;
    label?: string;
  }): CredentialPoolEntry {
    const label = entry.label ?? `${entry.provider}-${Date.now()}`;
    const existing = this.credentials.find(
      (item) => item.provider === entry.provider && item.label === label,
    );
    if (existing) {
      existing.key = entry.key;
      existing.status = "healthy";
      delete existing.lastError;
      delete existing.resetAt;
      this.save();
      return { ...existing };
    }

    const next: CredentialPoolEntry = {
      provider: entry.provider,
      key: entry.key,
      label,
      status: "healthy",
    };
    this.credentials.push(next);
    this.save();
    return { ...next };
  }

  list(provider?: CredentialProvider): CredentialPoolEntry[] {
    this.refreshExpired();
    return this.credentials
      .filter((entry) => !provider || entry.provider === provider)
      .map((entry) => ({ ...entry }));
  }

  acquire(provider: CredentialProvider): CredentialPoolEntry | undefined {
    this.refreshExpired();
    const entry = this.credentials.find(
      (item) => item.provider === provider && item.status === "healthy",
    );
    return entry ? { ...entry } : undefined;
  }

  releaseHealthy(entry: CredentialPoolEntry): void {
    this.update(entry, { status: "healthy", lastError: undefined, resetAt: undefined });
  }

  markExhausted(
    entry: CredentialPoolEntry,
    lastError: string,
    resetAt?: number,
  ): void {
    this.update(entry, {
      status: resetAt ? "rate_limited" : "exhausted",
      lastError,
      resetAt,
    });
  }

  reset(provider?: CredentialProvider): void {
    for (const entry of this.credentials) {
      if (provider && entry.provider !== provider) continue;
      entry.status = "healthy";
      delete entry.lastError;
      delete entry.resetAt;
    }
    this.save();
  }

  rotate(provider: CredentialProvider): CredentialPoolEntry | undefined {
    const current = this.acquire(provider);
    if (!current) return undefined;
    this.markExhausted(current, "rotated manually");
    return this.acquire(provider);
  }

  remove(provider: CredentialProvider, labelOrKey: string): boolean {
    const before = this.credentials.length;
    this.credentials = this.credentials.filter(
      (entry) =>
        !(entry.provider === provider && (entry.label === labelOrKey || entry.key === labelOrKey)),
    );
    const changed = this.credentials.length !== before;
    if (changed) this.save();
    return changed;
  }

  availableCount(provider: CredentialProvider): number {
    return this.list(provider).filter((entry) => entry.status === "healthy").length;
  }

  private update(
    target: CredentialPoolEntry,
    patch: Partial<CredentialPoolEntry>,
  ): void {
    const entry = this.credentials.find(
      (item) =>
        item.provider === target.provider &&
        item.label === target.label &&
        item.key === target.key,
    );
    if (!entry) return;
    Object.assign(entry, patch);
    if (patch.lastError === undefined) delete entry.lastError;
    if (patch.resetAt === undefined) delete entry.resetAt;
    this.save();
  }

  private refreshExpired(): void {
    const now = Date.now();
    let changed = false;
    for (const entry of this.credentials) {
      if (entry.resetAt && entry.resetAt <= now) {
        entry.status = "healthy";
        delete entry.lastError;
        delete entry.resetAt;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): CredentialPoolEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CredentialFile;
      return Array.isArray(parsed.credentials) ? parsed.credentials : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: CredentialFile = { credentials: this.credentials };
    writeFileSync(this.path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
