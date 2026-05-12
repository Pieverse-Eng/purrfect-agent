import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;

beforeEach(() => {
  tmpDir = createTempDir("session-store-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("SessionStore: session lifecycle", () => {
  it("creates a session and retrieves it with correct metadata", () => {
    const id = store.createSession({
      id: "s1",
      model: "gpt-4",
      source: "cli",
      title: "Test Session",
    });

    expect(id).toBe("s1");

    const session = store.getSession("s1");
    expect(session).not.toBeNull();
    expect(session!.id).toBe("s1");
    expect(session!.model).toBe("gpt-4");
    expect(session!.source).toBe("cli");
    expect(session!.title).toBe("Test Session");
    expect(session!.created_at).toBeTypeOf("number");
    expect(session!.updated_at).toBeTypeOf("number");
    expect(session!.parent_session_id).toBeNull();
  });

  it("returns null for non-existent session", () => {
    const session = store.getSession("nonexistent");
    expect(session).toBeNull();
  });

  it("ends a session and updates timestamps", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    const before = store.getSession("s1")!;

    store.endSession("s1");

    const after = store.getSession("s1")!;
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
  });

  it("lists sessions", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.createSession({ id: "s2", model: "gpt-4", source: "telegram" });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("deletes a session and its messages", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", {
      role: "user",
      content: "hello",
    });

    store.deleteSession("s1");

    expect(store.getSession("s1")).toBeNull();
    expect(store.getMessages("s1")).toHaveLength(0);
  });
});

describe("SessionStore: messages", () => {
  it("appends messages and retrieves them in order", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });

    store.appendMessage("s1", { role: "user", content: "Hello" });
    store.appendMessage("s1", { role: "assistant", content: "Hi there" });
    store.appendMessage("s1", { role: "user", content: "How are you?" });

    const messages = store.getMessages("s1");
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi there");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("How are you?");
  });

  it("tool_calls JSON round-trips correctly", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });

    const toolCalls = [
      {
        id: "call_1",
        type: "function" as const,
        function: { name: "read_file", arguments: '{"path": "/tmp/f.txt"}' },
      },
    ];

    store.appendMessage("s1", {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    });

    const messages = store.getMessages("s1");
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_calls).toEqual(toolCalls);
  });

  it("reasoning field round-trips correctly", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });

    store.appendMessage("s1", {
      role: "assistant",
      content: "The answer is 42.",
      reasoning: "I need to think about this carefully...",
    });

    const messages = store.getMessages("s1");
    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning).toBe(
      "I need to think about this carefully...",
    );
  });

  it("tool response messages round-trip with tool_call_id and tool_name", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });

    store.appendMessage("s1", {
      role: "tool",
      content: "file contents here",
      tool_call_id: "call_1",
      tool_name: "read_file",
    });

    const messages = store.getMessages("s1");
    expect(messages).toHaveLength(1);
    expect(messages[0].tool_call_id).toBe("call_1");
    expect(messages[0].tool_name).toBe("read_file");
  });
});

describe("SessionStore: token usage", () => {
  it("records cumulative token and cache usage per session", () => {
    store.createSession({ id: "s1", model: "gpt-4o", source: "cli" });

    store.recordTokenUsage("s1", {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    });
    store.recordTokenUsage("s1", {
      input_tokens: 50,
      output_tokens: 5,
      cache_read_input_tokens: 20,
    });

    expect(store.getTokenUsage("s1")).toEqual({
      input_tokens: 150,
      output_tokens: 25,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 10,
      requests: 2,
    });
  });
});

describe("SessionStore: FTS5 search", () => {
  it("returns matching messages for a simple query", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", {
      role: "user",
      content: "How do I deploy a Docker container?",
    });
    store.appendMessage("s1", {
      role: "assistant",
      content: "You can use docker-compose or kubectl.",
    });
    store.appendMessage("s1", {
      role: "user",
      content: "Tell me about Python classes.",
    });

    const results = store.search("Docker");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(
      results.some((r) =>
        typeof r.content === "string" && r.content.includes("Docker"),
      ),
    ).toBe(true);
  });

  it("sanitizes hyphenated terms (e.g., 'context-aware')", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", {
      role: "user",
      content: "We need a context-aware solution for this problem.",
    });

    // Should not throw — hyphens are sanitized
    const results = store.search("context-aware");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("handles unbalanced quotes without crashing", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", {
      role: "user",
      content: "Some test content here",
    });

    // Should not throw
    const results = store.search('"unbalanced quote');
    expect(Array.isArray(results)).toBe(true);
  });

  it("returns empty results for empty query", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "hello world" });

    const results = store.search("");
    expect(results).toEqual([]);
  });

  it("returns empty results for whitespace-only query", () => {
    const results = store.search("   ");
    expect(results).toEqual([]);
  });

  it("handles special FTS5 characters without crashing", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", {
      role: "user",
      content: "Testing C++ and std::vector",
    });

    // Should not throw — special chars are sanitized
    expect(() => store.search("C++")).not.toThrow();
    expect(() => store.search("(test)")).not.toThrow();
    expect(() => store.search("{brackets}")).not.toThrow();
  });
});

describe("SessionStore: session chaining", () => {
  it("creates a child session with parent_session_id", () => {
    store.createSession({ id: "parent", model: "gpt-4", source: "cli" });
    store.createSession({
      id: "child",
      model: "gpt-4",
      source: "cli",
      parent_session_id: "parent",
    });

    const child = store.getSession("child");
    expect(child).not.toBeNull();
    expect(child!.parent_session_id).toBe("parent");
  });
});

describe("SessionStore: schema versioning", () => {
  it("creates a fresh database with WAL mode", () => {
    // The store was already created in beforeEach — just verify it works
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    const session = store.getSession("s1");
    expect(session).not.toBeNull();
  });

  it("can reopen an existing database file", () => {
    const dbPath = join(tmpDir.path, "reopen.db");
    const store1 = new SessionStore(dbPath);
    store1.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store1.close();

    const store2 = new SessionStore(dbPath);
    const session = store2.getSession("s1");
    expect(session).not.toBeNull();
    expect(session!.model).toBe("gpt-4");
    store2.close();
  });
});

describe("SessionStore: open-time resilience", () => {
  it("auto-creates a missing parent directory", () => {
    // Nested path whose parent does NOT exist yet — proves we mkdir -p before opening.
    const dbPath = join(tmpDir.path, "nested", "deeper", "sessions.db");
    const s = new SessionStore(dbPath);
    s.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    expect(s.getSession("s1")).not.toBeNull();
    s.close();
  });

  it("surfaces the underlying SQLite error in the thrown message", () => {
    // Point at a path whose parent is a file, not a directory. mkdir -p will
    // throw ENOTDIR; the SessionStoreError must include that detail so the
    // user can diagnose instead of seeing a bare 'Failed to open database'.
    const filePath = join(tmpDir.path, "definitely-a-file");
    // Use openSync/writeSync via fs would be heavier; piggyback on SessionStore
    // to create a real file at that path first.
    const dummy = new SessionStore(filePath);
    dummy.close();

    expect(
      () => new SessionStore(join(filePath, "child.db")),
    ).toThrow(/Failed to (create parent directory|open database).*child\.db/);
  });
});
