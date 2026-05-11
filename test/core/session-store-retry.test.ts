import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import {
  SessionStore,
  isSqliteBusyError,
  retryOnBusy,
} from "../../src/core/session-store.js";

function makeBusyError(code = "SQLITE_BUSY"): Error {
  const err = new Error(`SQLite ${code}`);
  (err as Error & { code: string }).code = code;
  return err;
}

describe("isSqliteBusyError", () => {
  it("recognises SQLITE_BUSY family codes", () => {
    for (const code of [
      "SQLITE_BUSY",
      "SQLITE_BUSY_SNAPSHOT",
      "SQLITE_BUSY_RECOVERY",
      "SQLITE_BUSY_TIMEOUT",
      "SQLITE_LOCKED",
      "SQLITE_LOCKED_SHAREDCACHE",
    ]) {
      expect(isSqliteBusyError(makeBusyError(code))).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isSqliteBusyError(makeBusyError("SQLITE_CONSTRAINT"))).toBe(false);
    expect(isSqliteBusyError(new Error("generic"))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError("oops")).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
  });
});

describe("retryOnBusy", () => {
  it("returns the result when the operation succeeds immediately", () => {
    const fn = vi.fn(() => "ok");
    const sleep = vi.fn();
    expect(retryOnBusy(fn, { sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries until success with jittered sleeps", () => {
    let attempts = 0;
    const fn = vi.fn(() => {
      attempts++;
      if (attempts < 4) {
        throw makeBusyError();
      }
      return attempts;
    });
    const sleep = vi.fn();
    const result = retryOnBusy(fn, {
      sleep,
      minJitterMs: 10,
      maxJitterMs: 30,
    });
    expect(result).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    for (const call of sleep.mock.calls) {
      const ms = call[0] as number;
      expect(ms).toBeGreaterThanOrEqual(10);
      expect(ms).toBeLessThanOrEqual(30);
    }
  });

  it("throws after exceeding maxAttempts", () => {
    const fn = vi.fn(() => {
      throw makeBusyError();
    });
    const sleep = vi.fn();
    expect(() =>
      retryOnBusy(fn, { sleep, maxAttempts: 3, minJitterMs: 1, maxJitterMs: 2 }),
    ).toThrow(/SQLITE_BUSY/);
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-busy errors immediately", () => {
    const err = new Error("other failure");
    const fn = vi.fn(() => {
      throw err;
    });
    const sleep = vi.fn();
    expect(() => retryOnBusy(fn, { sleep })).toThrow(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("SessionStore: atomic multi-statement retry", () => {
  let tmpDir: { path: string; cleanup: () => void };
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = createTempDir("session-store-atomic-test-");
    store = new SessionStore(join(tmpDir.path, "atomic.db"));
  });

  afterEach(() => {
    store.close();
    tmpDir.cleanup();
  });

  function patchPrepareToFailOnce(
    target: SessionStore,
    matcher: (sql: string) => boolean,
    errCode = "SQLITE_CONSTRAINT_FOREIGNKEY",
  ): { calls: () => number } {
    const db = (target as unknown as { db: import("better-sqlite3").Database }).db;
    const realPrepare = db.prepare.bind(db);
    let calls = 0;
    db.prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (matcher(sql)) {
        const realRun = stmt.run.bind(stmt);
        stmt.run = ((...args: unknown[]) => {
          calls++;
          if (calls === 1) {
            const err = new Error("forced failure") as Error & { code: string };
            err.code = errCode;
            throw err;
          }
          return (realRun as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof realRun>;
        }) as typeof stmt.run;
      }
      return stmt;
    }) as typeof db.prepare;
    return { calls: () => calls };
  }

  it("appendMessage rolls back the message INSERT when the timestamp UPDATE throws", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    patchPrepareToFailOnce(store, (sql) =>
      sql.startsWith("UPDATE sessions SET updated_at"),
    );

    expect(() =>
      store.appendMessage("s1", { role: "user", content: "boom" }),
    ).toThrow(/forced failure/);

    expect(store.getMessages("s1").length).toBe(0);
  });

  it("recordTokenUsage rolls back the session_usage upsert when the tier upsert throws", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    patchPrepareToFailOnce(store, (sql) =>
      sql.includes("INSERT INTO session_model_tier_usage"),
    );

    expect(() =>
      store.recordTokenUsage("s1", {
        input_tokens: 100,
        output_tokens: 50,
        model_tier: "fast",
      }),
    ).toThrow(/forced failure/);

    expect(store.getTokenUsage("s1")).toBeNull();
  });

  it("retries the entire transaction when the second statement reports SQLITE_BUSY", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    const probe = patchPrepareToFailOnce(
      store,
      (sql) => sql.startsWith("UPDATE sessions SET updated_at"),
      "SQLITE_BUSY",
    );

    store.appendMessage("s1", { role: "user", content: "hi" });

    // Second statement was retried after BUSY; final state must contain
    // exactly one message — the first attempt's INSERT was rolled back.
    expect(probe.calls()).toBeGreaterThanOrEqual(2);
    const messages = store.getMessages("s1");
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe("hi");
  });
});

describe("SessionStore: concurrent writers", () => {
  let tmpDir: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmpDir = createTempDir("session-store-retry-test-");
  });

  afterEach(() => {
    tmpDir.cleanup();
  });

  it("handles interleaved writes from two stores on the same db", () => {
    const dbPath = join(tmpDir.path, "concurrent.db");
    const storeA = new SessionStore(dbPath);
    const storeB = new SessionStore(dbPath);

    try {
      for (let i = 0; i < 25; i++) {
        storeA.createSession({
          id: `a-${i}`,
          model: "gpt-4",
          source: "cli",
        });
        storeB.createSession({
          id: `b-${i}`,
          model: "gpt-4",
          source: "cli",
        });
        storeA.appendMessage(`a-${i}`, {
          role: "user",
          content: `hello from A ${i}`,
        });
        storeB.appendMessage(`b-${i}`, {
          role: "user",
          content: `hello from B ${i}`,
        });
        storeA.recordTokenUsage(`a-${i}`, {
          input_tokens: 10,
          output_tokens: 5,
        });
        storeB.recordTokenUsage(`b-${i}`, {
          input_tokens: 7,
          output_tokens: 3,
        });
      }

      expect(storeA.listSessions().length).toBe(50);
      expect(storeB.listSessions().length).toBe(50);
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});
