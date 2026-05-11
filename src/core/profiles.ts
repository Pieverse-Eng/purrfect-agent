/**
 * Profile management — multiple isolated identities (dev, personal, group bot, etc.)
 * sharing the same install but with independent config / sessions / memory / skills.
 *
 * On disk layout:
 *   ~/.purrfect/                            # base dir (default profile lives here)
 *   ~/.purrfect/active-profile              # name of current active profile (or empty)
 *   ~/.purrfect/profiles/<name>/config.json
 *   ~/.purrfect/profiles/<name>/memories/
 *   ~/.purrfect/profiles/<name>/sessions.db
 *   ~/.purrfect/profiles/<name>/skills/
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_PROFILE_NAME = "default";

/** Filename under base dir that records the currently active profile. */
const ACTIVE_PROFILE_FILE = "active-profile";

/** Subdirectory holding per-profile state. */
const PROFILES_SUBDIR = "profiles";

export interface ProfileInfo {
  name: string;
  path: string;
  isDefault: boolean;
  createdAt?: number;
}

export interface ProfileStoreOptions {
  /** Base ~/.purrfect dir. */
  baseDir?: string;
}

export class ProfileStore {
  private readonly baseDir: string;

  constructor(opts: ProfileStoreOptions = {}) {
    this.baseDir = opts.baseDir ?? join(homedir(), ".purrfect");
  }

  /** Resolve absolute path for a profile's config dir. */
  pathFor(name?: string): string {
    if (!name || name === DEFAULT_PROFILE_NAME) return this.baseDir;
    return join(this.baseDir, PROFILES_SUBDIR, name);
  }

  exists(name: string): boolean {
    if (name === DEFAULT_PROFILE_NAME) return true;
    return existsSync(this.pathFor(name));
  }

  list(): ProfileInfo[] {
    const result: ProfileInfo[] = [
      {
        name: DEFAULT_PROFILE_NAME,
        path: this.baseDir,
        isDefault: true,
      },
    ];

    const profilesDir = join(this.baseDir, PROFILES_SUBDIR);
    if (!existsSync(profilesDir)) return result;

    for (const entry of readdirSync(profilesDir)) {
      const full = join(profilesDir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;
      result.push({
        name: entry,
        path: full,
        isDefault: false,
        createdAt: stats.ctimeMs,
      });
    }
    return result;
  }

  create(name: string): ProfileInfo {
    validateProfileName(name);
    if (name === DEFAULT_PROFILE_NAME) {
      throw new Error(`Profile "${DEFAULT_PROFILE_NAME}" always exists`);
    }
    const path = this.pathFor(name);
    if (existsSync(path)) {
      throw new Error(`Profile "${name}" already exists at ${path}`);
    }
    mkdirSync(join(path, "memories"), { recursive: true });
    mkdirSync(join(path, "skills"), { recursive: true });
    writeFileSync(join(path, "config.json"), JSON.stringify({}, null, 2) + "\n", "utf-8");
    return {
      name,
      path,
      isDefault: false,
      createdAt: Date.now(),
    };
  }

  delete(name: string): void {
    if (name === DEFAULT_PROFILE_NAME) {
      throw new Error("Cannot delete the default profile");
    }
    const path = this.pathFor(name);
    if (!existsSync(path)) {
      throw new Error(`Profile "${name}" does not exist`);
    }
    rmSync(path, { recursive: true, force: true });
    if (this.getActive() === name) {
      this.setActive(undefined);
    }
  }

  /** Read the persisted active profile, falling back to env / default. */
  getActive(): string {
    const stored = this.readActive();
    if (stored && this.exists(stored)) return stored;
    return DEFAULT_PROFILE_NAME;
  }

  setActive(name: string | undefined): void {
    if (name && !this.exists(name)) {
      throw new Error(`Profile "${name}" does not exist`);
    }
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(
      join(this.baseDir, ACTIVE_PROFILE_FILE),
      name ?? "",
      "utf-8",
    );
  }

  private readActive(): string | undefined {
    const path = join(this.baseDir, ACTIVE_PROFILE_FILE);
    if (!existsSync(path)) return undefined;
    try {
      const raw = readFileSync(path, "utf-8").trim();
      return raw === "" ? undefined : raw;
    } catch {
      return undefined;
    }
  }
}

const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function validateProfileName(name: string): void {
  if (!name) throw new Error("Profile name is required");
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use letters, digits, hyphen, underscore (max 64 chars).`,
    );
  }
}

/**
 * Resolve the effective config dir for the current process.
 *
 *   1. Explicit override (e.g. from --profile flag) → highest priority
 *   2. PURRFECT_PROFILE env var
 *   3. Persisted active profile (`~/.purrfect/active-profile`)
 *   4. Default base dir
 */
export function resolveProfileDir(opts: {
  baseDir?: string;
  profileOverride?: string;
} = {}): { name: string; dir: string } {
  const store = new ProfileStore({ baseDir: opts.baseDir });
  const explicit = opts.profileOverride ?? process.env.PURRFECT_PROFILE;

  if (explicit && explicit !== DEFAULT_PROFILE_NAME) {
    if (!store.exists(explicit)) {
      throw new Error(
        `Profile "${explicit}" does not exist. Run \`purrfect profile create ${explicit}\` first.`,
      );
    }
    return { name: explicit, dir: store.pathFor(explicit) };
  }

  const active = store.getActive();
  return { name: active, dir: store.pathFor(active) };
}

/**
 * Generate the shell snippet a user can drop into ~/.zshrc / ~/.bashrc to alias
 * a profile-bound invocation (e.g. `purrfect-dev`).
 */
export function profileAliasSnippet(name: string, binary = "purrfect"): string {
  validateProfileName(name);
  return `alias ${binary}-${name}='PURRFECT_PROFILE=${name} ${binary}'`;
}
