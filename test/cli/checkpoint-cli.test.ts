/**
 * Integration tests for checkpoint CLI helpers:
 * - listCheckpoints
 * - restoreCheckpoint (creates new session with messages + todos)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";
import { listCheckpoints, restoreCheckpoint, printCheckpoints } from "../../src/cli/sessions.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;
const SESSION_ID = "test-session-cli";

beforeEach(() => {
  tmpDir = createTempDir("checkpoint-cli-test-");
  store = new SessionStore(join(tmpDir.path, "sessions.db"));
  store.createSession({ id: SESSION_ID, model: "claude-3", source: "repl" });
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("listCheckpoints", () => {
  it("returns empty list when no checkpoints exist", () => {
    const summaries = listCheckpoints(SESSION_ID, tmpDir.path);
    expect(summaries).toHaveLength(0);
  });

  it("returns summaries for existing checkpoints", () => {
    store.createCheckpoint({
      id: randomUUID(),
      session_id: SESSION_ID,
      label: "cp1",
      messages: [{ id: 1, session_id: SESSION_ID, role: "user", content: "hi", timestamp: 1 }],
      todos: [],
    });
    store.createCheckpoint({
      id: randomUUID(),
      session_id: SESSION_ID,
      label: "cp2",
      messages: [],
      todos: [{ content: "task", status: "pending", activeForm: "task" }],
    });

    const summaries = listCheckpoints(SESSION_ID, tmpDir.path);
    expect(summaries).toHaveLength(2);
    // Newest first
    expect(summaries[0].label).toBe("cp2");
    expect(summaries[0].todo_count).toBe(1);
    expect(summaries[1].label).toBe("cp1");
    expect(summaries[1].message_count).toBe(1);
  });
});

describe("restoreCheckpoint", () => {
  it("creates a new session with checkpoint messages and todos", () => {
    const cpId = randomUUID();
    store.createCheckpoint({
      id: cpId,
      session_id: SESSION_ID,
      label: "good state",
      messages: [
        { id: 1, session_id: SESSION_ID, role: "user", content: "hello", timestamp: 1 },
        { id: 2, session_id: SESSION_ID, role: "assistant", content: "hi there", timestamp: 2 },
      ],
      todos: [{ content: "finish work", status: "in_progress", activeForm: "Finishing work" }],
    });
    store.close(); // close before using CLI helper (it opens its own connection)

    const { sessionId: newId } = restoreCheckpoint(cpId, tmpDir.path);

    // Re-open to verify
    const verifyStore = new SessionStore(join(tmpDir.path, "sessions.db"));
    try {
      const session = verifyStore.getSession(newId);
      expect(session).not.toBeNull();
      expect(session!.parent_session_id).toBe(SESSION_ID);
      expect(session!.source).toBe("checkpoint-resume");

      const msgs = verifyStore.getMessages(newId);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].content).toBe("hello");
      expect(msgs[1].content).toBe("hi there");

      const todos = verifyStore.getTodos(newId);
      expect(todos).toHaveLength(1);
      expect(todos[0].content).toBe("finish work");
      expect(todos[0].status).toBe("in_progress");
    } finally {
      verifyStore.close();
    }
  });

  it("throws for unknown checkpoint id", () => {
    store.close();
    expect(() => restoreCheckpoint("nonexistent", tmpDir.path)).toThrow("Checkpoint not found");
  });
});

describe("printCheckpoints", () => {
  it("prints 'no checkpoints' for empty list", () => {
    const output: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      printCheckpoints(SESSION_ID, []);
      expect(output.some((l) => l.includes("No checkpoints"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it("prints checkpoint rows with id, date, and label", () => {
    const cpId = randomUUID();
    const summaries = [
      {
        id: cpId,
        session_id: SESSION_ID,
        label: "before refactor",
        created_at: 1700000000,
        message_count: 5,
        todo_count: 2,
      },
    ];

    const output: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      printCheckpoints(SESSION_ID, summaries);
      const joined = output.join("\n");
      expect(joined).toContain(cpId.slice(0, 8));
      expect(joined).toContain("before refactor");
      expect(joined).toContain("msgs=5");
      expect(joined).toContain("todos=2");
    } finally {
      console.log = origLog;
    }
  });
});
