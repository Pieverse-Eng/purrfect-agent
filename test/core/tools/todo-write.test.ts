import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { SessionStore } from "../../../src/core/session-store.js";
import { createTodoWriteTool } from "../../../src/core/tools/todo-write.js";
import { ToolRegistry } from "../../../src/core/tool-registry.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;
const SESSION_ID = "test-session";

beforeEach(() => {
  tmpDir = createTempDir("todo-write-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
  store.createSession({ id: SESSION_ID, model: "gpt-4", source: "cli" });
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("todo_write tool", () => {
  it("persists a new todo list and returns rendered snapshot", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });
    const raw = await tool.handler({
      todos: [
        { content: "Fetch data", status: "in_progress", activeForm: "Fetching data" },
        { content: "Write tests", status: "pending", activeForm: "Writing tests" },
      ],
    });
    const result = JSON.parse(raw);

    expect(result.success).toBe(true);
    expect(result.counts).toEqual({ pending: 1, in_progress: 1, completed: 0, total: 2 });
    expect(result.todos).toHaveLength(2);
    expect(result.todos[0].status).toBe("in_progress");
    expect(result.rendered).toContain("Fetch data");
    expect(result.rendered).toContain("[~]");
    expect(result.rendered).toContain("[ ]");

    const stored = store.getTodos(SESSION_ID);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({
      content: "Fetch data",
      status: "in_progress",
      activeForm: "Fetching data",
    });
  });

  it("replaces the existing list on subsequent calls", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });

    await tool.handler({
      todos: [{ content: "A", status: "pending", activeForm: "Doing A" }],
    });
    await tool.handler({
      todos: [
        { content: "A", status: "completed", activeForm: "Doing A" },
        { content: "B", status: "in_progress", activeForm: "Doing B" },
      ],
    });

    const stored = store.getTodos(SESSION_ID);
    expect(stored).toHaveLength(2);
    expect(stored[0].status).toBe("completed");
    expect(stored[1].status).toBe("in_progress");
  });

  it("rejects more than one in_progress todo", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });
    const raw = await tool.handler({
      todos: [
        { content: "A", status: "in_progress", activeForm: "Doing A" },
        { content: "B", status: "in_progress", activeForm: "Doing B" },
      ],
    });
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/at most one.*in_progress/i);
    expect(store.getTodos(SESSION_ID)).toEqual([]);
  });

  it("rejects invalid status", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });
    const raw = await tool.handler({
      todos: [{ content: "A", status: "maybe", activeForm: "Doing A" }],
    });
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/status must be/);
  });

  it("rejects missing content", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });
    const r1 = JSON.parse(
      await tool.handler({
        todos: [{ content: "", status: "pending", activeForm: "x" }],
      }),
    );
    expect(r1.error).toMatch(/content/);
  });

  it("requires activeForm only for in_progress items", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });

    // pending/completed without activeForm — OK, falls back to content
    const ok = JSON.parse(
      await tool.handler({
        todos: [
          { content: "Step A", status: "completed" },
          { content: "Step C", status: "pending" },
        ],
      }),
    );
    expect(ok.success).toBe(true);
    const persisted = store.getTodos(SESSION_ID);
    expect(persisted[0].activeForm).toBe("Step A");
    expect(persisted[1].activeForm).toBe("Step C");

    // in_progress without activeForm — rejected
    const bad = JSON.parse(
      await tool.handler({
        todos: [{ content: "Doing", status: "in_progress" }],
      }),
    );
    expect(bad.error).toMatch(/activeForm.*in_progress/);
  });

  it("rejects non-array todos", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });
    const raw = await tool.handler({ todos: "not an array" });
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/must be an array/);
  });

  it("returns an error when session id is unresolved", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => undefined });
    const raw = await tool.handler({
      todos: [{ content: "A", status: "pending", activeForm: "Doing A" }],
    });
    const result = JSON.parse(raw);
    expect(result.error).toMatch(/no active session/i);
  });

  it("supports empty list (clears todos)", async () => {
    const tool = createTodoWriteTool({ store, getSessionId: () => SESSION_ID });
    await tool.handler({
      todos: [{ content: "A", status: "pending", activeForm: "Doing A" }],
    });
    const raw = await tool.handler({ todos: [] });
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
    expect(result.counts.total).toBe(0);
    expect(store.getTodos(SESSION_ID)).toEqual([]);
  });

  it("registers and dispatches via ToolRegistry", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTodoWriteTool({ store, getSessionId: () => SESSION_ID }),
    );
    expect(registry.getAllToolNames()).toContain("todo_write");

    const raw = await registry.dispatch("todo_write", {
      todos: [{ content: "A", status: "pending", activeForm: "Doing A" }],
    });
    const result = JSON.parse(raw);
    expect(result.success).toBe(true);
  });
});

describe("generateSessionRecap with todos", () => {
  it("appends outstanding todos to recap", async () => {
    const { generateSessionRecap } = await import(
      "../../../src/core/session-resume.js"
    );
    store.appendMessage(SESSION_ID, { role: "user", content: "Hi" });
    store.setTodos(SESSION_ID, [
      { content: "Done thing", status: "completed", activeForm: "Doing it" },
      { content: "Next thing", status: "in_progress", activeForm: "Doing next" },
      { content: "Later thing", status: "pending", activeForm: "Doing later" },
    ]);

    const recap = generateSessionRecap(store, SESSION_ID);
    expect(recap).toContain("Previous conversation");
    expect(recap).toContain("Outstanding task list");
    expect(recap).toContain("[x] Done thing");
    expect(recap).toContain("[~] Next thing");
    expect(recap).toContain("[ ] Later thing");
    expect(recap).toContain("2 incomplete of 3");
  });

  it("omits todo section when nothing is outstanding", async () => {
    const { generateSessionRecap } = await import(
      "../../../src/core/session-resume.js"
    );
    store.appendMessage(SESSION_ID, { role: "user", content: "Hi" });
    store.setTodos(SESSION_ID, [
      { content: "Done", status: "completed", activeForm: "Doing" },
    ]);

    const recap = generateSessionRecap(store, SESSION_ID);
    expect(recap).not.toContain("Outstanding task list");
  });
});

describe("SessionStore.todos", () => {
  it("returns empty array when no todos have been stored", () => {
    expect(store.getTodos(SESSION_ID)).toEqual([]);
  });

  it("get/set roundtrip preserves order and fields", () => {
    const todos = [
      { content: "A", status: "pending" as const, activeForm: "Doing A" },
      { content: "B", status: "in_progress" as const, activeForm: "Doing B" },
      { content: "C", status: "completed" as const, activeForm: "Doing C" },
    ];
    store.setTodos(SESSION_ID, todos);
    expect(store.getTodos(SESSION_ID)).toEqual(todos);
  });

  it("deleteSession cascades to todos", () => {
    store.setTodos(SESSION_ID, [
      { content: "A", status: "pending", activeForm: "Doing A" },
    ]);
    store.deleteSession(SESSION_ID);
    expect(store.getTodos(SESSION_ID)).toEqual([]);
  });
});
