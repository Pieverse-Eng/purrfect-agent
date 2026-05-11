import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";
import {
  parseDuration,
  renameSession,
  deleteSession,
  pruneSessions,
  exportSession,
} from "../../src/cli/sessions.js";

let tmpDir: { path: string; cleanup: () => void };
let configDir: string;

beforeEach(() => {
  tmpDir = createTempDir("sessions-ops-");
  configDir = tmpDir.path;
});

afterEach(() => {
  tmpDir.cleanup();
});

function seedSession(id: string, opts?: { ageDays?: number; messages?: number }): void {
  const dbPath = join(configDir, "sessions.db");
  const store = new SessionStore(dbPath);
  try {
    store.createSession({
      id,
      model: "test-model",
      source: "test",
      title: `Session ${id}`,
    });
    const messages = opts?.messages ?? 0;
    for (let i = 0; i < messages; i++) {
      store.appendMessage(id, { role: "user", content: `msg-${i}` });
    }
    if (opts?.ageDays !== undefined) {
      const target = (Date.now() - opts.ageDays * 86_400_000) / 1000;
      // Use raw SQL to back-date created_at and updated_at deterministically.
      const sqlite = (store as unknown as { db: { prepare: (q: string) => { run: (...args: unknown[]) => unknown } } }).db;
      sqlite
        .prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
        .run(target, target, id);
    }
  } finally {
    store.close();
  }
}

describe("parseDuration", () => {
  it("parses common units", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("90s")).toBe(90 * 1_000);
    expect(parseDuration("2w")).toBe(2 * 7 * 86_400_000);
  });
  it("returns null for invalid", () => {
    expect(parseDuration("forever")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("renameSession", () => {
  it("updates title via prefix match", () => {
    seedSession("session-renamable-001");
    const updated = renameSession("session-r", "New Title", configDir);
    expect(updated?.title).toBe("New Title");
    const dbPath = join(configDir, "sessions.db");
    const store = new SessionStore(dbPath);
    try {
      const row = store.getSession("session-renamable-001");
      expect(row?.title).toBe("New Title");
    } finally {
      store.close();
    }
  });
});

describe("deleteSession", () => {
  it("removes session from store", () => {
    seedSession("session-delete-001");
    expect(deleteSession("session-d", configDir)).toBe(true);
    const store = new SessionStore(join(configDir, "sessions.db"));
    try {
      expect(store.getSession("session-delete-001")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("pruneSessions", () => {
  it("--empty removes only message-less sessions", () => {
    seedSession("session-empty-001");
    seedSession("session-full-001", { messages: 2 });
    const result = pruneSessions({ empty: true }, configDir);
    expect(result.deleted).toContain("session-empty-001");
    expect(result.deleted).not.toContain("session-full-001");
  });

  it("--older-than removes only stale sessions", () => {
    seedSession("session-old-001", { ageDays: 60 });
    seedSession("session-new-001", { ageDays: 1 });
    const result = pruneSessions({ olderThan: "30d" }, configDir);
    expect(result.deleted).toContain("session-old-001");
    expect(result.deleted).not.toContain("session-new-001");
  });
});

describe("exportSession", () => {
  it("writes jsonl with one message per line", () => {
    seedSession("session-export-001", { messages: 3 });
    const out = exportSession("session-e", "jsonl", configDir);
    expect(out).toBeTruthy();
    expect(existsSync(out!)).toBe(true);
    const lines = readFileSync(out!, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.role).toBe("user");
      expect(parsed.content).toMatch(/^msg-/);
    }
  });

  it("writes md with section headers", () => {
    seedSession("session-md-001", { messages: 2 });
    const out = exportSession("session-m", "md", configDir);
    expect(out).toBeTruthy();
    const md = readFileSync(out!, "utf-8");
    expect(md).toContain("# Session");
    expect(md).toContain("## user");
    expect(md).toContain("msg-0");
  });
});
