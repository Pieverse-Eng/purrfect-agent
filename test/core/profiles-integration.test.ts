import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore } from "../../src/core/profiles.js";
import { MemoryStore } from "../../src/core/memory/store.js";
import { SessionStore } from "../../src/core/session-store.js";

describe("profile isolation — memory + sessions", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "profile-iso-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("memory writes in profile A do not leak into profile B", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.create("personal");

    const devMem = new MemoryStore(join(store.pathFor("dev"), "memories"));
    devMem.add("note", "dev only");

    const personalMem = new MemoryStore(join(store.pathFor("personal"), "memories"));
    personalMem.add("note", "personal only");

    expect(devMem.getLiveSnapshot()).toContain("dev only");
    expect(devMem.getLiveSnapshot()).not.toContain("personal only");
    expect(personalMem.getLiveSnapshot()).toContain("personal only");
    expect(personalMem.getLiveSnapshot()).not.toContain("dev only");
  });

  it("session DBs are independent files", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.create("personal");

    const devDb = new SessionStore(join(store.pathFor("dev"), "sessions.db"));
    const personalDb = new SessionStore(join(store.pathFor("personal"), "sessions.db"));

    devDb.createSession({
      id: "dev-1",
      title: "dev session",
      source: "test",
      model: "claude-opus-4-7",
    } as any);
    personalDb.createSession({
      id: "personal-1",
      title: "personal session",
      source: "test",
      model: "claude-opus-4-7",
    } as any);

    expect(devDb.listSessions().map((s) => s.id)).toEqual(["dev-1"]);
    expect(personalDb.listSessions().map((s) => s.id)).toEqual(["personal-1"]);

    expect(existsSync(join(store.pathFor("dev"), "sessions.db"))).toBe(true);
    expect(existsSync(join(store.pathFor("personal"), "sessions.db"))).toBe(true);

    devDb.close();
    personalDb.close();
  });
});
