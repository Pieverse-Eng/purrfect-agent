import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { SessionStore } from "../../../src/core/session-store.js";
import type { StoredMessage } from "../../../src/core/session-store.js";
import { createCheckpointCreateTool } from "../../../src/core/tools/checkpoint-create.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;
const SESSION_ID = "test-session";

beforeEach(() => {
  tmpDir = createTempDir("checkpoint-create-tool-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
  store.createSession({ id: SESSION_ID, model: "claude-3", source: "test" });
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

function makeMessages(n: number): StoredMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    session_id: SESSION_ID,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    timestamp: Date.now() / 1000 + i,
  }));
}

describe("checkpoint_create tool", () => {
  it("creates a checkpoint and returns success JSON", async () => {
    const messages = makeMessages(3);
    const tool = createCheckpointCreateTool({
      store,
      getSessionId: () => SESSION_ID,
      getMessages: () => messages,
    });

    const raw = await tool.handler({ label: "before refactor" });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.checkpoint_id).toBeTruthy();
    expect(result.label).toBe("before refactor");
    expect(result.message_count).toBe(3);
    expect(result.todo_count).toBe(0);

    const stored = store.getCheckpoint(result.checkpoint_id);
    expect(stored).not.toBeNull();
    expect(stored!.messages).toHaveLength(3);
  });

  it("creates a checkpoint without a label", async () => {
    const tool = createCheckpointCreateTool({
      store,
      getSessionId: () => SESSION_ID,
      getMessages: () => makeMessages(1),
    });

    const raw = await tool.handler({});
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.label).toBeNull();
  });

  it("captures todos from session store", async () => {
    store.setTodos(SESSION_ID, [
      { content: "task A", status: "in_progress", activeForm: "Doing A" },
      { content: "task B", status: "pending", activeForm: "task B" },
    ]);

    const tool = createCheckpointCreateTool({
      store,
      getSessionId: () => SESSION_ID,
      getMessages: () => [],
    });

    const raw = await tool.handler({});
    const result = JSON.parse(raw);

    expect(result.todo_count).toBe(2);
    const cp = store.getCheckpoint(result.checkpoint_id)!;
    expect(cp.todos).toHaveLength(2);
    expect(cp.todos[0].status).toBe("in_progress");
  });

  it("captures plan_mode and token_usage via callbacks", async () => {
    const tool = createCheckpointCreateTool({
      store,
      getSessionId: () => SESSION_ID,
      getMessages: () => makeMessages(2),
      getPlanMode: () => true,
      getTokenUsage: () => ({ input_tokens: 200, output_tokens: 80 }),
    });

    const raw = await tool.handler({ label: "mid-plan" });
    const result = JSON.parse(raw);

    const cp = store.getCheckpoint(result.checkpoint_id)!;
    expect(cp.plan_mode).toBe(true);
    expect(cp.token_usage?.input_tokens).toBe(200);
  });

  it("returns error when no active session", async () => {
    const tool = createCheckpointCreateTool({
      store,
      getSessionId: () => undefined,
      getMessages: () => [],
    });

    const raw = await tool.handler({});
    const result = JSON.parse(raw);
    expect(result.error).toContain("No active session");
  });

  it("trims whitespace-only label and treats it as null", async () => {
    const tool = createCheckpointCreateTool({
      store,
      getSessionId: () => SESSION_ID,
      getMessages: () => [],
    });

    const raw = await tool.handler({ label: "   " });
    const result = JSON.parse(raw);
    expect(result.label).toBeNull();
  });
});
