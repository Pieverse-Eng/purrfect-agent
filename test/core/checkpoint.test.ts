import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;
const SESSION_ID = "test-session-checkpoint";

beforeEach(() => {
  tmpDir = createTempDir("checkpoint-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
  store.createSession({ id: SESSION_ID, model: "claude-3", source: "test" });
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("CheckpointStore (via SessionStore)", () => {
  it("creates a checkpoint and retrieves it by id", () => {
    const id = randomUUID();
    const messages = [
      {
        id: 1,
        session_id: SESSION_ID,
        role: "user",
        content: "Hello",
        timestamp: Date.now() / 1000,
      },
    ];
    const todos = [{ content: "do something", status: "pending" as const, activeForm: "do something" }];

    const record = store.createCheckpoint({
      id,
      session_id: SESSION_ID,
      label: "first checkpoint",
      messages,
      todos,
      plan_mode: false,
      token_usage: { input_tokens: 100, output_tokens: 50 },
      compression_meta: null,
    });

    expect(record.id).toBe(id);
    expect(record.session_id).toBe(SESSION_ID);
    expect(record.label).toBe("first checkpoint");
    expect(record.plan_mode).toBe(false);
    expect(record.token_usage?.input_tokens).toBe(100);
    expect(record.messages).toHaveLength(1);
    expect(record.todos).toHaveLength(1);
    expect(record.created_at).toBeGreaterThan(0);

    const fetched = store.getCheckpoint(id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(id);
    expect(fetched!.label).toBe("first checkpoint");
    expect(fetched!.messages[0].content).toBe("Hello");
    expect(fetched!.todos[0].content).toBe("do something");
  });

  it("returns null for unknown checkpoint id", () => {
    expect(store.getCheckpoint("nonexistent-id")).toBeNull();
  });

  it("lists checkpoints for a session ordered newest first", () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    store.createCheckpoint({ id: id1, session_id: SESSION_ID, messages: [], todos: [], label: "first" });
    store.createCheckpoint({ id: id2, session_id: SESSION_ID, messages: [], todos: [], label: "second" });

    const summaries = store.listCheckpoints(SESSION_ID);
    expect(summaries).toHaveLength(2);
    // Newest first
    expect(summaries[0].label).toBe("second");
    expect(summaries[1].label).toBe("first");
  });

  it("summary includes correct message_count and todo_count", () => {
    const messages = [
      { id: 1, session_id: SESSION_ID, role: "user", content: "a", timestamp: 1 },
      { id: 2, session_id: SESSION_ID, role: "assistant", content: "b", timestamp: 2 },
    ];
    const todos = [
      { content: "task1", status: "pending" as const, activeForm: "task1" },
      { content: "task2", status: "completed" as const, activeForm: "task2" },
    ];

    store.createCheckpoint({
      id: randomUUID(),
      session_id: SESSION_ID,
      messages,
      todos,
      label: null,
    });

    const summaries = store.listCheckpoints(SESSION_ID);
    expect(summaries[0].message_count).toBe(2);
    expect(summaries[0].todo_count).toBe(2);
  });

  it("returns empty list for session with no checkpoints", () => {
    expect(store.listCheckpoints(SESSION_ID)).toHaveLength(0);
  });

  it("deleteCheckpoints removes all checkpoints for the session", () => {
    store.createCheckpoint({ id: randomUUID(), session_id: SESSION_ID, messages: [], todos: [] });
    store.createCheckpoint({ id: randomUUID(), session_id: SESSION_ID, messages: [], todos: [] });

    store.deleteCheckpoints(SESSION_ID);
    expect(store.listCheckpoints(SESSION_ID)).toHaveLength(0);
  });

  it("preserves compression_meta and plan_mode=true", () => {
    const id = randomUUID();
    store.createCheckpoint({
      id,
      session_id: SESSION_ID,
      messages: [],
      todos: [],
      plan_mode: true,
      compression_meta: {
        compressed_at: 1234567890,
        original_message_count: 50,
        compressed_message_count: 10,
      },
    });

    const cp = store.getCheckpoint(id)!;
    expect(cp.plan_mode).toBe(true);
    expect(cp.compression_meta?.original_message_count).toBe(50);
    expect(cp.compression_meta?.compressed_message_count).toBe(10);
  });

  it("handles null label, token_usage, compression_meta gracefully", () => {
    const id = randomUUID();
    store.createCheckpoint({ id, session_id: SESSION_ID, messages: [], todos: [] });

    const cp = store.getCheckpoint(id)!;
    expect(cp.label).toBeNull();
    expect(cp.token_usage).toBeNull();
    expect(cp.compression_meta).toBeNull();
  });
});
