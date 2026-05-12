import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_PROFILE_NAME,
  ProfileStore,
  resolveProfileDir,
  profileAliasSnippet,
} from "../../src/core/profiles.js";

describe("ProfileStore", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "profiles-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.PURRFECT_PROFILE;
  });

  it("default profile always exists and points at base dir", () => {
    const store = new ProfileStore({ baseDir });
    expect(store.exists(DEFAULT_PROFILE_NAME)).toBe(true);
    expect(store.pathFor(DEFAULT_PROFILE_NAME)).toBe(baseDir);
    expect(store.pathFor(undefined)).toBe(baseDir);
  });

  it("create produces an isolated profile directory layout", () => {
    const store = new ProfileStore({ baseDir });
    const info = store.create("dev");
    expect(info.path).toBe(join(baseDir, "profiles", "dev"));
    expect(existsSync(join(info.path, "memories"))).toBe(true);
    expect(existsSync(join(info.path, "skills"))).toBe(true);
    expect(existsSync(join(info.path, "config.json"))).toBe(true);
  });

  it("create rejects duplicates and invalid names", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    expect(() => store.create("dev")).toThrow(/already exists/);
    expect(() => store.create("")).toThrow();
    expect(() => store.create("with space")).toThrow(/Invalid profile name/);
    expect(() => store.create(DEFAULT_PROFILE_NAME)).toThrow(/always exists/);
  });

  it("list returns default + created profiles", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.create("personal");
    const names = store.list().map((p) => p.name).sort();
    expect(names).toEqual(["default", "dev", "personal"]);
  });

  it("delete removes the directory and clears active when matching", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.setActive("dev");
    expect(store.getActive()).toBe("dev");
    store.delete("dev");
    expect(store.exists("dev")).toBe(false);
    expect(store.getActive()).toBe(DEFAULT_PROFILE_NAME);
  });

  it("delete refuses default profile and missing names", () => {
    const store = new ProfileStore({ baseDir });
    expect(() => store.delete(DEFAULT_PROFILE_NAME)).toThrow(/Cannot delete/);
    expect(() => store.delete("nope")).toThrow(/does not exist/);
  });

  it("setActive persists across instances", () => {
    const a = new ProfileStore({ baseDir });
    a.create("dev");
    a.setActive("dev");
    const b = new ProfileStore({ baseDir });
    expect(b.getActive()).toBe("dev");
  });

  it("isolated directory layout — two profiles cannot see each other's files", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.create("prod");
    writeFileSync(join(store.pathFor("dev"), "memories", "MEMORY.md"), "dev memory", "utf-8");
    writeFileSync(join(store.pathFor("prod"), "memories", "MEMORY.md"), "prod memory", "utf-8");
    expect(readFileSync(join(store.pathFor("dev"), "memories", "MEMORY.md"), "utf-8")).toBe("dev memory");
    expect(readFileSync(join(store.pathFor("prod"), "memories", "MEMORY.md"), "utf-8")).toBe("prod memory");
  });
});

describe("resolveProfileDir", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "profiles-resolve-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    delete process.env.PURRFECT_PROFILE;
  });

  it("returns base dir when no override / env / persisted profile", () => {
    const r = resolveProfileDir({ baseDir });
    expect(r.name).toBe(DEFAULT_PROFILE_NAME);
    expect(r.dir).toBe(baseDir);
  });

  it("explicit override wins over env and persisted active", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.create("personal");
    store.setActive("personal");
    process.env.PURRFECT_PROFILE = "personal";

    const r = resolveProfileDir({ baseDir, profileOverride: "dev" });
    expect(r.name).toBe("dev");
    expect(r.dir).toBe(store.pathFor("dev"));
  });

  it("env var wins over persisted active when no override", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.create("personal");
    store.setActive("personal");
    process.env.PURRFECT_PROFILE = "dev";

    const r = resolveProfileDir({ baseDir });
    expect(r.name).toBe("dev");
  });

  it("throws for unknown override profile", () => {
    expect(() => resolveProfileDir({ baseDir, profileOverride: "ghost" })).toThrow(/does not exist/);
  });
});

describe("profileAliasSnippet", () => {
  it("renders an alias setting PURRFECT_PROFILE", () => {
    expect(profileAliasSnippet("dev")).toBe(`alias purrfect-dev='PURRFECT_PROFILE=dev purrfect'`);
  });

  it("rejects invalid names", () => {
    expect(() => profileAliasSnippet("bad name")).toThrow(/Invalid profile name/);
  });
});
