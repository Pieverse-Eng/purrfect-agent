import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentLoop, AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { PermissionModel } from "../../src/core/permissions.js";
import { SessionStore } from "../../src/core/session-store.js";
import { ContextCompressor } from "../../src/core/compressor.js";
import { fileReadTool } from "../../src/core/tools/file-read.js";
import { fileWriteTool } from "../../src/core/tools/file-write.js";
import { shellExecTool } from "../../src/core/tools/shell-exec.js";
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
// Integration Tests
// ---------------------------------------------------------------------------

describe("Integration: full-loop", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort */ }
    }
    cleanups.length = 0;
  });

  // ── 1. Full tool-calling flow ──────────────────────────────────────────

  it("1. file_read tool call -> real execution -> text completion", async () => {
    // Set up temp dir with a test file
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const filePath = join(tmp.path, "hello.txt");
    writeFileSync(filePath, "Hello from integration test!", "utf-8");

    // Mock: first response is a tool call for file_read, second is a text summary
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("file_read", { path: filePath }, "call_1")]) },
      { body: makeTextResponse("The file contains a greeting.") },
    ]);

    const registry = new ToolRegistry();
    registry.register(fileReadTool);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
    });

    const events = await collectEvents(loop.run("Read hello.txt"));

    // Should have: tool_call_start, tool_result, completion
    const toolStart = events.find((e) => e.type === "tool_call_start");
    expect(toolStart).toBeDefined();
    expect(toolStart!.type === "tool_call_start" && toolStart!.toolCall.function.name).toBe("file_read");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult!.type === "tool_result") {
      const parsed = JSON.parse(toolResult!.result);
      expect(parsed.content).toBe("Hello from integration test!");
    }

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("The file contains a greeting.");
    }
  });

  // ── 2. Multi-tool flow ─────────────────────────────────────────────────

  it("2. file_write then file_read in sequence on real filesystem", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const filePath = join(tmp.path, "output.txt");

    // Mock sequence:
    // 1. Provider requests file_write
    // 2. Provider requests file_read of the written file
    // 3. Provider returns final text
    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("file_write", { path: filePath, content: "Written by agent" }, "call_w"),
        ]),
      },
      {
        body: makeToolCallResponse([
          makeToolCall("file_read", { path: filePath }, "call_r"),
        ]),
      },
      { body: makeTextResponse("File was written and verified.") },
    ]);

    const registry = new ToolRegistry();
    registry.register(fileWriteTool);
    registry.register(fileReadTool);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
    });

    const events = await collectEvents(loop.run("Write then read"));

    // Verify file_write succeeded
    const writeResult = events.find(
      (e) => e.type === "tool_result" && e.name === "file_write",
    );
    expect(writeResult).toBeDefined();
    if (writeResult!.type === "tool_result") {
      expect(JSON.parse(writeResult!.result).success).toBe(true);
    }

    // Verify file_read returned the written content
    const readResult = events.find(
      (e) => e.type === "tool_result" && e.name === "file_read",
    );
    expect(readResult).toBeDefined();
    if (readResult!.type === "tool_result") {
      expect(JSON.parse(readResult!.result).content).toBe("Written by agent");
    }

    // Final completion
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("File was written and verified.");
    }
  });

  // ── 3. Session persistence ─────────────────────────────────────────────

  it("3. messages persist in SessionStore across AgentLoop instances", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const dbPath = join(tmp.path, "sessions.db");

    const sessionId = "sess-integration-1";
    const store = new SessionStore(dbPath);
    cleanups.push(() => store.close());

    store.createSession({
      id: sessionId,
      model: "test-model",
      source: "integration-test",
    });

    // First loop — simple text exchange
    const mockFetch1 = createMockFetch([
      { body: makeTextResponse("First response.") },
    ]);

    const registry = new ToolRegistry();
    registry.register(fileReadTool);

    const loop1 = new AgentLoop({
      provider: makeProvider(mockFetch1),
      toolRegistry: registry,
      sessionStore: store,
      sessionId,
    });

    await collectEvents(loop1.run("Hello"));

    // Verify messages were stored
    const messagesAfterFirst = store.getMessages(sessionId);
    expect(messagesAfterFirst.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(messagesAfterFirst[0].role).toBe("user");
    expect(messagesAfterFirst[0].content).toBe("Hello");
    expect(messagesAfterFirst[1].role).toBe("assistant");
    expect(messagesAfterFirst[1].content).toBe("First response.");

    // Second loop — same store, same session — run another exchange
    const mockFetch2 = createMockFetch([
      { body: makeTextResponse("Second response.") },
    ]);

    const loop2 = new AgentLoop({
      provider: makeProvider(mockFetch2),
      toolRegistry: registry,
      sessionStore: store,
      sessionId,
    });

    await collectEvents(loop2.run("Follow-up"));

    // Verify all four messages are present
    const allMessages = store.getMessages(sessionId);
    expect(allMessages.length).toBeGreaterThanOrEqual(4);
    expect(allMessages[2].role).toBe("user");
    expect(allMessages[2].content).toBe("Follow-up");
    expect(allMessages[3].role).toBe("assistant");
    expect(allMessages[3].content).toBe("Second response.");
  });

  // ── 4. Permission denied flow ──────────────────────────────────────────

  it("4. permission denied for dangerous command is sent back to model", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    // Mock: model tries to rm -rf /, gets permission denied, then responds with text
    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("shell_exec", { command: "rm -rf /" }, "call_rm"),
        ]),
      },
      { body: makeTextResponse("I cannot delete system files.") },
    ]);

    const registry = new ToolRegistry();
    registry.register(shellExecTool);

    const permissions = new PermissionModel();

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
    });

    const events = await collectEvents(loop.run("Delete everything"));

    // Should see a tool_result with permission denied
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult!.type === "tool_result") {
      const parsed = JSON.parse(toolResult!.result);
      expect(parsed.error).toMatch(/Permission denied/);
    }

    // Model responds with safe text after seeing the denial
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("I cannot delete system files.");
    }
  });

  // ── 5. Context compression ─────────────────────────────────────────────

  it("5. compressor triggers on context length error and loop continues", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    // We simulate: first call returns tool call, tool runs, second call
    // returns 413 context_length_exceeded, compressor runs, third call succeeds.
    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("file_read", { path: "/dev/null" }, "call_c1"),
        ]),
      },
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "context length exceeded", code: "context_length_exceeded" },
        }),
      },
      { body: makeTextResponse("Recovered after compression.") },
    ]);

    const registry = new ToolRegistry();
    registry.register(fileReadTool);

    const compressor = new ContextCompressor({
      contextLength: 100, // very low so shouldCompress would trigger
      thresholdPercent: 0.01,
      protectFirstN: 1,
      protectLastN: 1,
    });

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      compressor,
      maxIterations: 10,
    });

    const events = await collectEvents(loop.run("Fill context"));

    // The loop should recover: we expect a completion event (not just an error)
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("Recovered after compression.");
    }
  });

  // ── 6. AbortSignal ─────────────────────────────────────────────────────

  it("6. abort signal terminates loop with partial events", async () => {
    // Mock: first response is a tool call, second would be text but we abort before
    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("file_read", { path: "/dev/null" }, "call_abort"),
        ]),
      },
      { body: makeTextResponse("Should not reach this.") },
    ]);

    const registry = new ToolRegistry();
    registry.register(fileReadTool);

    const controller = new AbortController();

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
    });

    const events: AgentEvent[] = [];
    for await (const ev of loop.run("Read something", { signal: controller.signal })) {
      events.push(ev);
      // Abort after we get the first tool result
      if (ev.type === "tool_result") {
        controller.abort();
      }
    }

    // Should have received tool_call_start and tool_result
    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);

    // Should NOT have a completion event (we aborted before the second call)
    expect(events.some((e) => e.type === "completion")).toBe(false);
  });

  // ── 7. Skill dispatch ──────────────────────────────────────────────────

  it("7. skill dispatch prepends skill body to user message", async () => {
    // Track messages sent to provider so we can verify skill instructions
    const capturedBodies: string[] = [];
    const mockFetch = createMockFetch([
      { body: makeTextResponse("Review complete.") },
    ]);
    const originalFetch = mockFetch;

    // Wrap to capture request bodies
    const capturingFetch: typeof fetch = async (input, init) => {
      if (init?.body) {
        capturedBodies.push(init.body as string);
      }
      return originalFetch(input, init);
    };

    const registry = new ToolRegistry();
    registry.register(fileReadTool);

    // Build a skill registry (Map<string, string>) as AgentLoop expects
    const skillMap = new Map<string, string>();
    skillMap.set("review-code", "You are a code reviewer. Check for bugs and style issues.");

    const loop = new AgentLoop({
      provider: makeProvider(capturingFetch),
      toolRegistry: registry,
      skillRegistry: skillMap,
    });

    const events = await collectEvents(loop.run("/review-code src/main.ts"));

    // Verify the message sent to provider contains the skill instructions
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const requestBody = JSON.parse(capturedBodies[0]);
    const userMessage = requestBody.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain("You are a code reviewer");
    expect(userMessage.content).toContain("src/main.ts");

    // Verify completion
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("Review complete.");
    }
  });
});
