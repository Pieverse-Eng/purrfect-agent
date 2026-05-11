import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { AgentLoop, type AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { createTodoWriteTool } from "../../src/core/tools/todo-write.js";
import { createDelegateTool } from "../../src/core/tools/delegate.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";

/**
 * End-to-end: drive a real AgentLoop through the real tool_registry so that
 * the mock provider's tool_calls hit createTodoWriteTool's handler, which
 * persists via SessionStore. Then verify that resuming a new loop picks up
 * the outstanding todos in the resume recap system message.
 */

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;
const SESSION_ID = "e2e-session";

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

async function collectEvents(
  iter: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of iter) events.push(ev);
  return events;
}

beforeEach(() => {
  tmpDir = createTempDir("todo-e2e-");
  store = new SessionStore(join(tmpDir.path, "sessions.db"));
  store.createSession({ id: SESSION_ID, model: "test-model", source: "cli" });
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("todo_write end-to-end", () => {
  it("agent calls todo_write → state persisted → rendered via tool_result", async () => {
    const registry = new ToolRegistry();
    registry.registerBuiltin(
      createTodoWriteTool({ store, getSessionId: () => SESSION_ID }),
    );

    const tc = makeToolCall(
      "todo_write",
      {
        todos: [
          { content: "Analyze repo", status: "in_progress", activeForm: "Analyzing repo" },
          { content: "Write summary", status: "pending", activeForm: "Writing summary" },
        ],
      },
      "call_todo_1",
    );

    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("Task list initialized.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      sessionStore: store,
      sessionId: SESSION_ID,
    });

    const events = await collectEvents(loop.run("Please analyze and summarize."));

    const toolResult = events.find(
      (e) => e.type === "tool_result" && e.name === "todo_write",
    );
    expect(toolResult).toBeDefined();

    if (toolResult?.type === "tool_result") {
      const parsed = JSON.parse(toolResult.result);
      expect(parsed.success).toBe(true);
      expect(parsed.counts.in_progress).toBe(1);
      expect(parsed.counts.pending).toBe(1);
      expect(parsed.todos).toHaveLength(2);
    }

    // Persisted
    const persisted = store.getTodos(SESSION_ID);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].status).toBe("in_progress");
    expect(persisted[1].status).toBe("pending");

    // Completion emitted
    expect(events.some((e) => e.type === "completion")).toBe(true);
  });

  it("multi-turn todo_write updates replace the list", async () => {
    const registry = new ToolRegistry();
    registry.registerBuiltin(
      createTodoWriteTool({ store, getSessionId: () => SESSION_ID }),
    );

    const tc1 = makeToolCall(
      "todo_write",
      {
        todos: [
          { content: "Step A", status: "in_progress", activeForm: "Doing A" },
          { content: "Step B", status: "pending", activeForm: "Doing B" },
        ],
      },
      "c1",
    );
    const tc2 = makeToolCall(
      "todo_write",
      {
        todos: [
          { content: "Step A", status: "completed", activeForm: "Doing A" },
          { content: "Step B", status: "in_progress", activeForm: "Doing B" },
        ],
      },
      "c2",
    );

    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1]) },
      { body: makeToolCallResponse([tc2]) },
      { body: makeTextResponse("Done with A, working on B.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      sessionStore: store,
      sessionId: SESSION_ID,
    });

    await collectEvents(loop.run("Start the plan."));

    const persisted = store.getTodos(SESSION_ID);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ content: "Step A", status: "completed" });
    expect(persisted[1]).toMatchObject({ content: "Step B", status: "in_progress" });
  });

  it("delegate does not expose todo_write to child agents (no parent session pollution)", async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.registerBuiltin(
      createTodoWriteTool({ store, getSessionId: () => SESSION_ID }),
    );

    // Seed parent session with todos
    store.setTodos(SESSION_ID, [
      { content: "Parent task", status: "in_progress", activeForm: "Parent-ing" },
    ]);

    // Register delegate tool that would spawn a child registry cloned from parent
    parentRegistry.registerBuiltin(
      createDelegateTool({
        provider: makeProvider(createMockFetch([])),
        toolRegistry: parentRegistry,
      }),
    );

    // Simulate delegate cloning: inspect what tools it would pass to the child
    // by calling the internal buildChildRegistry path — we exercise this via
    // the public behaviour: a child loop triggered through delegate must not
    // see todo_write.
    //
    // Simpler: verify the handler's child registry via a mock child run.
    const childTurn = makeToolCall(
      "todo_write",
      {
        todos: [
          { content: "Child mutation", status: "in_progress", activeForm: "Mutating" },
        ],
      },
      "child_tc",
    );

    const parentTC = makeToolCall(
      "delegate",
      { prompt: "do a subtask" },
      "parent_tc",
    );

    // Responses: parent calls delegate → child tries todo_write (which should
    // NOT be available → child gets tool-not-found) → child completes with
    // text → delegate returns → parent completes.
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([parentTC]) }, // parent iter 1
      { body: makeToolCallResponse([childTurn]) }, // child iter 1
      { body: makeTextResponse("child tried and failed") }, // child iter 2 (after unknown tool)
      { body: makeTextResponse("parent done") }, // parent iter 2
    ]);

    // Replace delegate with one bound to the real mock fetch
    parentRegistry.registerBuiltin(
      createDelegateTool({
        provider: makeProvider(mockFetch),
        toolRegistry: parentRegistry,
      }),
    );

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: parentRegistry,
      sessionStore: store,
      sessionId: SESSION_ID,
    });

    await collectEvents(loop.run("Delegate a subtask."));

    // Parent's todos must be untouched — child never saw todo_write
    const parentTodos = store.getTodos(SESSION_ID);
    expect(parentTodos).toHaveLength(1);
    expect(parentTodos[0]).toMatchObject({
      content: "Parent task",
      status: "in_progress",
    });
  });

  it("childSystemPrompt is independent of parent and preserves collisions with nested '# Task List Guidance' headings", async () => {
    // Regression guard for PR review: the first strip attempt used a regex
    // that would have eaten a user-authored '# Task List Guidance' heading
    // inside a project-context section. The new plumbing rebuilds the child
    // prompt from structured inputs instead of stripping, so such collisions
    // are impossible. Verify by handing delegate a parent prompt that embeds
    // the phrase inside unrelated content and a child prompt that keeps it.
    const parentRegistry = new ToolRegistry();
    parentRegistry.registerBuiltin(
      createTodoWriteTool({ store, getSessionId: () => SESSION_ID }),
    );

    const parentWithTodoSection =
      "You are a test agent.\n\n" +
      "# Task List Guidance\n" +
      "Use todo_write etc.\n\n" +
      "# Project Context (.purrfect.md)\n" +
      "Our house style mentions '# Task List Guidance' as a planning heading in docs.";

    // Child prompt intentionally keeps the phrase inside project context.
    const childWithoutTopLevelTodoButKeepingNestedHeading =
      "You are a test agent.\n\n" +
      "# Project Context (.purrfect.md)\n" +
      "Our house style mentions '# Task List Guidance' as a planning heading in docs.";

    const reqs: any[] = [];
    const parentTC = makeToolCall("delegate", { prompt: "subtask" }, "t");
    const mockFetch: typeof fetch = async (_url, init) => {
      if (init?.body && typeof init.body === "string") {
        reqs.push(JSON.parse(init.body));
        if (reqs.length === 1) {
          return new Response(
            JSON.stringify(makeToolCallResponse([parentTC])),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return new Response(JSON.stringify(makeTextResponse("done")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    parentRegistry.registerBuiltin(
      createDelegateTool({
        provider: makeProvider(mockFetch),
        toolRegistry: parentRegistry,
        systemPrompt: parentWithTodoSection,
        childSystemPrompt: childWithoutTopLevelTodoButKeepingNestedHeading,
      }),
    );

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: parentRegistry,
      systemPrompt: parentWithTodoSection,
      sessionStore: store,
      sessionId: SESSION_ID,
    });

    await collectEvents(loop.run("delegate please"));

    const childSys = (reqs[1].messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    // User-authored mention of the heading inside project context must survive.
    expect(childSys).toContain("# Project Context (.purrfect.md)");
    expect(childSys).toContain("'# Task List Guidance'");
    expect(childSys).toContain("planning heading in docs");
  });

  it("delegate forwards childSystemPrompt to the child loop", async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.registerBuiltin(
      createTodoWriteTool({ store, getSessionId: () => SESSION_ID }),
    );

    const parentPrompt =
      "You are a test agent.\n\n" +
      "# Task List Guidance\n" +
      "Use todo_write for multi-step work. blah blah blah.\n\n" +
      "# Memory Guidance\n" +
      "Use memory tool.";
    const childPrompt =
      "You are a test agent.\n\n# Memory Guidance\nUse memory tool.";

    const childRequests: any[] = [];
    const parentTC = makeToolCall("delegate", { prompt: "subtask" }, "p_tc");

    const mockFetch: typeof fetch = async (_url, init) => {
      if (init?.body && typeof init.body === "string") {
        const parsed = JSON.parse(init.body);
        childRequests.push(parsed);
        if (childRequests.length === 1) {
          return new Response(
            JSON.stringify(makeToolCallResponse([parentTC])),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(makeTextResponse("child done")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(makeTextResponse("fallback")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    parentRegistry.registerBuiltin(
      createDelegateTool({
        provider: makeProvider(mockFetch),
        toolRegistry: parentRegistry,
        systemPrompt: parentPrompt,
        childSystemPrompt: childPrompt,
      }),
    );

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: parentRegistry,
      systemPrompt: parentPrompt,
      sessionStore: store,
      sessionId: SESSION_ID,
    });

    await collectEvents(loop.run("delegate something"));

    expect(childRequests.length).toBeGreaterThanOrEqual(2);
    const childSystemMsgs = (childRequests[1].messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    expect(childSystemMsgs).toContain("You are a test agent");
    expect(childSystemMsgs).toContain("# Memory Guidance");
    expect(childSystemMsgs).not.toContain("# Task List Guidance");
    expect(childSystemMsgs).not.toContain("todo_write");
  });

  it("resume injects outstanding todos into the system prompt context", async () => {
    const registry = new ToolRegistry();
    registry.registerBuiltin(
      createTodoWriteTool({ store, getSessionId: () => "new-session" }),
    );

    // Seed SESSION_ID with message history + outstanding todos, as if from a prior run
    store.appendMessage(SESSION_ID, { role: "user", content: "Analyze the repo" });
    store.appendMessage(SESSION_ID, { role: "assistant", content: "Starting analysis" });
    store.setTodos(SESSION_ID, [
      { content: "Scan files", status: "completed", activeForm: "Scanning files" },
      { content: "Summarize findings", status: "in_progress", activeForm: "Summarizing" },
      { content: "Propose fixes", status: "pending", activeForm: "Proposing fixes" },
    ]);

    // Capture what the provider sees on its first call — that's where the
    // resume recap system message must appear.
    let capturedBody: any;
    const capturingFetch: typeof fetch = async (url, init) => {
      if (init?.body && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body);
      }
      return new Response(JSON.stringify(makeTextResponse("Continuing.")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    store.createSession({ id: "new-session", model: "test-model", source: "cli" });

    const loop = new AgentLoop({
      provider: makeProvider(capturingFetch),
      toolRegistry: registry,
      sessionStore: store,
      sessionId: "new-session",
      resumeSessionId: SESSION_ID,
    });

    await collectEvents(loop.run("Continue where we left off."));

    expect(capturedBody).toBeDefined();
    const systemMsgs = capturedBody.messages.filter(
      (m: { role: string; content: string }) => m.role === "system",
    );
    const combined = systemMsgs.map((m: { content: string }) => m.content).join("\n");

    expect(combined).toContain("Previous conversation");
    expect(combined).toContain("Outstanding task list");
    expect(combined).toContain("[x] Scan files");
    expect(combined).toContain("[~] Summarize findings");
    expect(combined).toContain("[ ] Propose fixes");
    expect(combined).toContain("2 incomplete of 3");
  });
});
