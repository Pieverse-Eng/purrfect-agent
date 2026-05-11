/**
 * v4 Unit 10 — Integration tests for v4 features.
 *
 * Wires REAL subsystems (SessionStore, ToolRegistry, PermissionModel,
 * AgentLoop, InterruptController) with mocked HTTP only.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { AgentLoop, type AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { PermissionModel } from "../../src/core/permissions.js";
import { SessionStore } from "../../src/core/session-store.js";
import { InterruptController } from "../../src/cli/interrupt.js";
import { createSessionSearchTool } from "../../src/core/tools/session-search.js";
import { createDelegateTool } from "../../src/core/tools/delegate.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: v4 features", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort */ }
    }
    cleanups.length = 0;
  });

  // ── 1. Session search tool in conversation ────────────────────────────

  it("1. session_search tool returns results from real SessionStore DB", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const dbPath = join(tmp.path, "sessions.db");

    const store = new SessionStore(dbPath);
    cleanups.push(() => store.close());

    // Seed two sessions with messages containing searchable content
    store.createSession({ id: "s1", model: "test", source: "test" });
    store.createSession({ id: "s2", model: "test", source: "test" });
    store.appendMessage("s1", { role: "user", content: "How do I deploy to kubernetes?" });
    store.appendMessage("s1", { role: "assistant", content: "Use kubectl apply to deploy." });
    store.appendMessage("s2", { role: "user", content: "Tell me about docker containers." });

    // Register session_search tool bound to the real store
    const registry = new ToolRegistry();
    const searchTool = createSessionSearchTool(store);
    registry.register(searchTool);

    // Mock: provider asks session_search for "kubernetes", then gives text answer
    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("session_search", { query: "kubernetes" }, "call_ss1"),
        ]),
      },
      { body: makeTextResponse("I found previous discussions about kubernetes.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
    });

    const events = await collectEvents(loop.run("Search for kubernetes info"));

    // Verify tool_result contains real DB matches
    const toolResult = events.find((e) => e.type === "tool_result" && e.name === "session_search");
    expect(toolResult).toBeDefined();
    expect(toolResult!.type).toBe("tool_result");
    if (toolResult!.type === "tool_result") {
      const parsed = JSON.parse(toolResult!.result);
      expect(parsed.matches).toBeDefined();
      expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
      // At least one match should contain kubernetes-related content
      const hasKubernetesMatch = parsed.matches.some(
        (m: { content: string }) => m.content.toLowerCase().includes("kubernetes"),
      );
      expect(hasKubernetesMatch).toBe(true);
      // Each match should have session_id and timestamp
      for (const m of parsed.matches) {
        expect(m.session_id).toBeDefined();
        expect(m.timestamp).toBeDefined();
      }
    }

    // Verify completion
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("I found previous discussions about kubernetes.");
    }
  });

  // ── 2. Subagent delegation ────────────────────────────────────────────

  it("2. delegate tool spawns child AgentLoop that runs with its own mock response", async () => {
    // We need a mock that serves both the parent and child loops.
    // Parent flow: provider returns delegate tool call -> child runs -> parent gets text.
    // Child flow: provider returns text answer.
    //
    // Call sequence:
    //   1. Parent chat -> tool_call(delegate)
    //   2. Child chat  -> text("Child result: 42")
    //   3. Parent chat -> text("The answer is 42")
    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "delegate",
            { prompt: "What is 6 * 7?" },
            "call_del1",
          ),
        ]),
      },
      { body: makeTextResponse("Child result: 42") },
      { body: makeTextResponse("The answer is 42.") },
    ]);

    const provider = makeProvider(mockFetch);
    const registry = new ToolRegistry();

    // Register the delegate tool at depth 0
    const delegateTool = createDelegateTool({
      provider,
      toolRegistry: registry,
      depth: 0,
      maxDepth: 3,
    });
    registry.register(delegateTool);

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
    });

    const events = await collectEvents(loop.run("Delegate: compute 6 * 7"));

    // Should see delegate tool_call_start
    const toolStart = events.find(
      (e) => e.type === "tool_call_start" && e.toolCall.function.name === "delegate",
    );
    expect(toolStart).toBeDefined();

    // Should see delegate tool_result with the child's completion
    const toolResult = events.find(
      (e) => e.type === "tool_result" && e.name === "delegate",
    );
    expect(toolResult).toBeDefined();
    if (toolResult!.type === "tool_result") {
      const parsed = JSON.parse(toolResult!.result);
      expect(parsed.result).toBe("Child result: 42");
    }

    // Should see parent completion
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("The answer is 42.");
    }
  });

  // ── 3. Deny-by-default + approval callback ────────────────────────────

  it("3. deny-by-default permission triggers onApprovalRequired, allow_once lets tool execute", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    // A simple echo tool for testing
    const echoTool = {
      name: "echo",
      description: "Echo back the input",
      schema: {
        type: "function" as const,
        function: {
          name: "echo",
          description: "Echo back the input",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
      async handler(args: Record<string, unknown>) {
        return JSON.stringify({ echoed: args.text });
      },
    };

    const registry = new ToolRegistry();
    registry.register(echoTool);

    // deny-by-default with empty allowList means ALL tools are denied
    const permissions = new PermissionModel({
      mode: "deny-by-default",
      allowList: [],
    });

    // Track approval calls
    const approvalCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("echo", { text: "hello world" }, "call_echo1"),
        ]),
      },
      { body: makeTextResponse("Echo complete.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
      onApprovalRequired: async (toolName, args) => {
        approvalCalls.push({ toolName, args });
        return "allow_once";
      },
    });

    const events = await collectEvents(loop.run("Echo hello world"));

    // Verify the approval callback was called
    expect(approvalCalls.length).toBe(1);
    expect(approvalCalls[0].toolName).toBe("echo");
    expect(approvalCalls[0].args.text).toBe("hello world");

    // Verify the tool actually executed (not denied)
    const toolResult = events.find((e) => e.type === "tool_result" && e.name === "echo");
    expect(toolResult).toBeDefined();
    if (toolResult!.type === "tool_result") {
      const parsed = JSON.parse(toolResult!.result);
      expect(parsed.echoed).toBe("hello world");
    }

    // Verify completion
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("Echo complete.");
    }
  });

  // ── 4. Session resume with recap ──────────────────────────────────────

  it("4. resumeSessionId injects recap system message before user message", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const dbPath = join(tmp.path, "sessions.db");

    const store = new SessionStore(dbPath);
    cleanups.push(() => store.close());

    // Create a previous session with some messages
    const oldSessionId = "old-session-1";
    store.createSession({ id: oldSessionId, model: "test", source: "test" });
    store.appendMessage(oldSessionId, { role: "user", content: "Explain quantum computing" });
    store.appendMessage(oldSessionId, {
      role: "assistant",
      content: "Quantum computing uses qubits that can be in superposition.",
    });
    store.appendMessage(oldSessionId, { role: "user", content: "What about entanglement?" });
    store.appendMessage(oldSessionId, {
      role: "assistant",
      content: "Entanglement links qubits so measuring one affects the other.",
    });

    // Create a new session to resume from the old one
    const newSessionId = "new-session-1";
    store.createSession({ id: newSessionId, model: "test", source: "test" });

    // Capture the messages sent to the provider to verify recap injection
    const capturedBodies: string[] = [];
    const baseMockFetch = createMockFetch([
      { body: makeTextResponse("Continuing our discussion on quantum computing.") },
    ]);
    const capturingFetch: typeof fetch = async (input, init) => {
      if (init?.body) {
        capturedBodies.push(init.body as string);
      }
      return baseMockFetch(input, init);
    };

    const registry = new ToolRegistry();

    const loop = new AgentLoop({
      provider: makeProvider(capturingFetch),
      toolRegistry: registry,
      sessionStore: store,
      sessionId: newSessionId,
      resumeSessionId: oldSessionId,
    });

    const events = await collectEvents(loop.run("Continue where we left off"));

    // Verify the provider received messages with a system recap BEFORE the user message
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const requestBody = JSON.parse(capturedBodies[0]);
    const messages = requestBody.messages as Array<{ role: string; content: string }>;

    // First message should be the system recap
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Previous conversation:");
    expect(messages[0].content).toContain("quantum");

    // Second message should be the user message
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Continue where we left off");

    // Verify the recap contains message count
    expect(messages[0].content).toMatch(/\d+ messages total/);

    // Verify completion
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("Continuing our discussion on quantum computing.");
    }
  });

  // ── 5. InterruptController lifecycle ──────────────────────────────────

  it("5. InterruptController: start returns signal, interrupt aborts, new start returns fresh signal", () => {
    const ic = new InterruptController();

    // start() returns an AbortSignal
    const signal1 = ic.start();
    expect(signal1).toBeInstanceOf(AbortSignal);
    expect(signal1.aborted).toBe(false);
    expect(ic.interrupted).toBe(false);

    // interrupt() aborts the current signal and sets interrupted flag
    const result1 = ic.interrupt();
    expect(result1).toBeUndefined(); // first interrupt -> not force-exit
    expect(signal1.aborted).toBe(true);
    expect(ic.interrupted).toBe(true);

    // new start() returns a fresh (non-aborted) signal and resets interrupted
    const signal2 = ic.start();
    expect(signal2).toBeInstanceOf(AbortSignal);
    expect(signal2.aborted).toBe(false);
    expect(ic.interrupted).toBe(false);

    // signal1 remains aborted (it is a separate controller)
    expect(signal1.aborted).toBe(true);

    // signal2 is a distinct object
    expect(signal2).not.toBe(signal1);
  });
});
