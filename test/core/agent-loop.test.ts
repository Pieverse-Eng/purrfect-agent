import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoop, AgentEvent, IterationBudget } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { PermissionModel } from "../../src/core/permissions.js";
import { ProviderError } from "../../src/core/errors.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
  makeSSEStream,
  makeStreamChunk,
} from "../helpers/mock-server.js";
import type { ToolDefinition, ToolCall as TC } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

function makeTool(name: string, handler?: (args: Record<string, unknown>) => Promise<string>): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    schema: {
      type: "function",
      function: { name, description: `Test tool ${name}`, parameters: { type: "object", properties: {} } },
    },
    handler: handler ?? (async () => `result from ${name}`),
  };
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

describe("AgentLoop", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ── 1. Text response ──────────────────────────────────────────────────
  it("1. text response — yields completion event and exits loop", async () => {
    const mockFetch = createMockFetch([{ body: makeTextResponse("Hello!") }]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Hi"));

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    expect(completion!.type).toBe("completion");
    if (completion!.type === "completion") {
      expect(completion!.message.content).toBe("Hello!");
    }
  });

  it("1b. completion event carries normalized usage", async () => {
    const response = {
      ...makeTextResponse("Hello!"),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 12,
        total_tokens: 112,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    };
    const mockFetch = createMockFetch([{ body: response as any }]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Hi"));

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect((completion.message as any).usage).toMatchObject({
        prompt_tokens: 100,
        completion_tokens: 12,
        total_tokens: 112,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      });
    }
  });

  it("1c. records completion usage to the session store", async () => {
    const response = {
      ...makeTextResponse("Hello!"),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 12,
        total_tokens: 112,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    };
    const mockFetch = createMockFetch([{ body: response as any }]);
    const recordTokenUsage = vi.fn();
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      sessionStore: {
        appendMessage: vi.fn(),
        recordTokenUsage,
      } as any,
      sessionId: "test-session",
    });

    await collectEvents(loop.run("Hi"));

    expect(recordTokenUsage).toHaveBeenCalledWith("test-session", {
      input_tokens: 100,
      output_tokens: 12,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 0,
    });
  });

  // ── 2. Tool call → tool result → text response ────────────────────────
  it("2. tool call → result → text (2-iteration loop)", async () => {
    registry.register(makeTool("get_weather"));
    const tc = makeToolCall("get_weather", { city: "Paris" }, "call_1");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("It's sunny in Paris.") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("What's the weather?"));

    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_result");
    expect(types).toContain("completion");

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type === "tool_result") {
      expect(toolResult.name).toBe("get_weather");
      expect(toolResult.result).toBe("result from get_weather");
    }
  });

  // ── 3. Multiple tool calls in single response ─────────────────────────
  it("3. multiple tool calls in single response — all dispatched", async () => {
    registry.register(makeTool("read_file"));
    registry.register(makeTool("list_dir"));
    const tc1 = makeToolCall("read_file", { path: "/a.txt" }, "call_r");
    const tc2 = makeToolCall("list_dir", { path: "/tmp" }, "call_l");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1, tc2]) },
      { body: makeTextResponse("Done.") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Do stuff"));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    const names = results.map((e) => (e as any).name).sort();
    expect(names).toEqual(["list_dir", "read_file"]);
  });

  // ── 4. Streaming text deltas ──────────────────────────────────────────
  it("4. streaming text deltas yielded as events", async () => {
    const sse = makeSSEStream([
      makeStreamChunk("Hello"),
      makeStreamChunk(" world"),
      makeStreamChunk(undefined, undefined, "stop"),
    ]);
    const mockFetch = createMockFetch([{ body: sse, stream: true }]);
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      stream: true,
    });

    const events = await collectEvents(loop.run("Hi"));

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const text = deltas.map((e) => (e as any).content).join("");
    expect(text).toBe("Hello world");

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });

  it("4a. streaming completion event carries usage from OpenAI usage-only chunk", async () => {
    const sse = makeSSEStream([
      makeStreamChunk("Hello"),
      {
        id: "chatcmpl-finish",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      },
      {
        id: "chatcmpl-usage",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [],
        usage: {
          prompt_tokens: 90,
          completion_tokens: 7,
          total_tokens: 97,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      },
    ]);
    const mockFetch = createMockFetch([{ body: sse, stream: true }]);
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      stream: true,
    });

    const events = await collectEvents(loop.run("Hi"));

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect((completion.message as any).usage).toMatchObject({
        prompt_tokens: 90,
        completion_tokens: 7,
        total_tokens: 97,
        cache_read_input_tokens: 64,
        cache_creation_input_tokens: 0,
      });
    }
  });

  it("4b. streaming tool calls are executed and the loop continues", async () => {
    registry.register(
      makeTool("echo", async (args) => `echo:${String(args.msg ?? "")}`),
    );
    const firstStream = makeSSEStream([
      makeStreamChunk(undefined, [
        { index: 0, id: "call_1", function: { name: "echo", arguments: "" } },
      ]),
      makeStreamChunk(undefined, [
        { index: 0, function: { arguments: '{"msg":"hello"}' } },
      ], "tool_calls"),
    ]);
    const secondStream = makeSSEStream([
      makeStreamChunk("Tool handled."),
      makeStreamChunk(undefined, undefined, "stop"),
    ]);
    const mockFetch = createMockFetch([
      { body: firstStream, stream: true },
      { body: secondStream, stream: true },
    ]);
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      stream: true,
    });

    const events = await collectEvents(loop.run("Run streamed tool"));

    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toBe("echo:hello");
    }

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect(completion.message.content).toBe("Tool handled.");
    }
  });

  // ── 5. Budget exhaustion ──────────────────────────────────────────────
  it("5. budget exhausted after N iterations — yields budget_exceeded", async () => {
    registry.register(makeTool("echo"));
    // Every response is a tool call, never text — should exhaust budget
    const tc = makeToolCall("echo", {}, "call_x");
    const responses = Array.from({ length: 5 }, () => ({
      body: makeToolCallResponse([tc]),
    }));
    const mockFetch = createMockFetch(responses);
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      maxIterations: 3,
    });

    const events = await collectEvents(loop.run("Loop forever"));

    const types = events.map((e) => e.type);
    expect(types).toContain("budget_exceeded");
  });

  // ── 6. Session auto-persistence ───────────────────────────────────────
  it("6. session persistence — messages written to sessionStore", async () => {
    const mockFetch = createMockFetch([{ body: makeTextResponse("Hi back") }]);
    const appendMessage = vi.fn();
    const fakeSessionStore = {
      appendMessage,
      sessionId: "test-session",
    };
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      sessionStore: fakeSessionStore as any,
      sessionId: "test-session",
    });

    await collectEvents(loop.run("Hello"));

    // Should have persisted user message and assistant message
    expect(appendMessage).toHaveBeenCalledTimes(2);
    // First call: user message
    expect(appendMessage.mock.calls[0][0]).toBe("test-session");
    expect(appendMessage.mock.calls[0][1].role).toBe("user");
    // Second call: assistant message
    expect(appendMessage.mock.calls[1][0]).toBe("test-session");
    expect(appendMessage.mock.calls[1][1].role).toBe("assistant");
  });

  // ── 7. Skill dispatch ─────────────────────────────────────────────────
  it("7. skill dispatch — /skill-name triggers skill lookup", async () => {
    const mockFetch = createMockFetch([{ body: makeTextResponse("Skill done.") }]);
    const skillRegistry = new Map<string, string>();
    skillRegistry.set("deploy", "You are a deploy assistant. Follow these deploy steps...");

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      skillRegistry,
    });

    const events = await collectEvents(loop.run("/deploy production"));

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();

    // Verify the messages sent to provider included skill instructions
    const calls = (mockFetch as any).calls;
    const sentBody = JSON.parse(calls[0].init.body as string);
    const userMsg = sentBody.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("You are a deploy assistant");
    expect(userMsg.content).toContain("production");
  });

  // ── 8. Unknown tool in response ───────────────────────────────────────
  it("8. unknown tool → error result JSON sent to model, loop continues", async () => {
    const tc = makeToolCall("nonexistent_tool", {}, "call_u");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("Sorry, that tool doesn't exist.") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Use a fake tool"));

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toContain("Unknown tool");
    }

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });

  // ── 9. Empty response from model → retry ──────────────────────────────
  it("9. empty response from model — retries and succeeds", async () => {
    // First response: empty content, no tool calls
    const emptyResponse = {
      id: "chatcmpl-empty",
      object: "chat.completion",
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    };
    const mockFetch = createMockFetch([
      { body: emptyResponse as any },
      { body: makeTextResponse("Recovered!") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Say something"));

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect(completion.message.content).toBe("Recovered!");
    }
  });

  // ── 10. Tool result aggregation — correct tool_call_ids ────────────────
  it("10. tool results have correct tool_call_ids matching the request", async () => {
    registry.register(makeTool("alpha"));
    registry.register(makeTool("beta"));
    const tc1 = makeToolCall("alpha", {}, "call_a");
    const tc2 = makeToolCall("beta", {}, "call_b");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1, tc2]) },
      { body: makeTextResponse("All done") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Run both"));

    // Verify the second API call includes tool results with correct IDs
    const calls = (mockFetch as any).calls;
    expect(calls).toHaveLength(2);
    const secondBody = JSON.parse(calls[1].init.body as string);
    const toolMessages = secondBody.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    const ids = toolMessages.map((m: any) => m.tool_call_id).sort();
    expect(ids).toEqual(["call_a", "call_b"]);
  });

  // ── 11. Provider HTTP error → error event ─────────────────────────────
  it("11. provider HTTP error → yields error event", async () => {
    const mockFetch = createMockFetch([
      { status: 500, body: JSON.stringify({ error: { message: "Internal error" } }) },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Hi"));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error).toBeInstanceOf(ProviderError);
    }
  });

  // ── 12. Tool execution throws → error caught, JSON error sent to model ──
  it("12. tool throws → error caught, error result sent back to model", async () => {
    registry.register(
      makeTool("explode", async () => {
        throw new Error("BOOM");
      }),
    );
    const tc = makeToolCall("explode", {}, "call_boom");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("I handled the error.") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Break it"));

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toContain("error");
    }

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });

  // ── 13. AbortSignal cancels in-flight request ─────────────────────────
  it("13. AbortSignal cancels in-flight request — loop terminates cleanly", async () => {
    const controller = new AbortController();
    // Mock fetch that aborts
    const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    };
    (mockFetch as any).calls = [];

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch as typeof fetch),
      toolRegistry: registry,
    });

    const events = await collectEvents(loop.run("Hi", { signal: controller.signal }));

    // Should not throw, just terminate
    const types = events.map((e) => e.type);
    // Either error event or just no completion — loop terminated
    expect(types).not.toContain("completion");
  });

  // ── 14. AbortSignal cancels between tool executions ────────────────────
  it("14. AbortSignal cancels between tool executions — remaining tools skipped", async () => {
    const controller = new AbortController();
    let callCount = 0;
    registry.register(
      makeTool("slow_tool", async () => {
        callCount++;
        if (callCount === 1) {
          controller.abort();
        }
        return `result_${callCount}`;
      }),
    );
    const tc1 = makeToolCall("slow_tool", {}, "call_s1");
    const tc2 = makeToolCall("slow_tool", {}, "call_s2");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1, tc2]) },
    ]);
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
    });

    const events = await collectEvents(loop.run("Run tools", { signal: controller.signal }));

    // First tool runs, aborts, second tool should be skipped
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(1);
  });

  // ── 15. HTTP 413 → triggers compressor → retries ──────────────────────
  it("15. HTTP 413 → compressor triggered → retries with compressed context", async () => {
    const mockFetch = createMockFetch([
      {
        status: 413,
        body: JSON.stringify({
          error: { message: "context length exceeded", code: "context_length_exceeded" },
        }),
      },
      { body: makeTextResponse("Compressed response.") },
    ]);

    const compressMock = vi.fn(async (messages: any[]) => messages.slice(0, 2));
    const fakeCompressor = {
      shouldCompress: () => true,
      compress: compressMock,
    };

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      compressor: fakeCompressor as any,
    });

    const events = await collectEvents(loop.run("Big context"));

    expect(compressMock).toHaveBeenCalled();
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });

  it("15b. preflight runs trajectory compression before boundary compression", async () => {
    const capturedBoundaryInputs: string[][] = [];
    const providerMessages: string[][] = [];
    const provider: HttpProvider = {
      async chat(messages) {
        providerMessages.push(messages.map((m) => m.content ?? ""));
        return {
          choices: [{
            message: { role: "assistant", content: "Compressed response." },
            finish_reason: "stop",
          }],
        };
      },
      chatStream: vi.fn() as any,
    } as unknown as HttpProvider;

    const trajectoryCompressor = {
      compress: vi.fn((messages: any[]) => ({
        messages: [
          ...messages,
          { role: "assistant", content: "trajectory slimmed marker" },
        ],
        metrics: {},
      })),
    };
    const boundaryCompressor = {
      shouldCompress: () => true,
      shouldCompressPreflight: () => true,
      preflightCompress: vi.fn(async (messages: any[]) => {
        capturedBoundaryInputs.push(messages.map((m) => m.content ?? ""));
        return messages;
      }),
      compress: vi.fn(async (messages: any[]) => messages),
    };

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      compressor: boundaryCompressor as any,
      trajectoryCompressor: trajectoryCompressor as any,
    });

    const events = await collectEvents(loop.run("Big context"));

    expect(trajectoryCompressor.compress).toHaveBeenCalledBefore(
      boundaryCompressor.preflightCompress,
    );
    expect(capturedBoundaryInputs[0]).toContain("trajectory slimmed marker");
    expect(providerMessages[0]).toContain("trajectory slimmed marker");
    expect(events.some((e) => e.type === "completion")).toBe(true);
  });

  // ── 16. HTTP 413 → compression insufficient → error (no infinite loop) ──
  it("16. HTTP 413 → compression insufficient → max 1 retry → error surfaced", async () => {
    const mockFetch = createMockFetch([
      {
        status: 413,
        body: JSON.stringify({
          error: { message: "context length exceeded", code: "context_length_exceeded" },
        }),
      },
      {
        status: 413,
        body: JSON.stringify({
          error: { message: "context length exceeded", code: "context_length_exceeded" },
        }),
      },
    ]);

    const fakeCompressor = {
      shouldCompress: () => true,
      compress: vi.fn(async (messages: any[]) => messages),
    };

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      compressor: fakeCompressor as any,
    });

    const events = await collectEvents(loop.run("Huge context"));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
  });

  // ── 17. SessionStore failure mid-loop → warning emitted ────────────────
  it("17. sessionStore failure mid-loop — warning event, conversation continues", async () => {
    const mockFetch = createMockFetch([{ body: makeTextResponse("Fine") }]);
    const fakeSessionStore = {
      appendMessage: vi.fn(() => {
        throw new Error("DB write failed");
      }),
      sessionId: "test-session",
    };
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      sessionStore: fakeSessionStore as any,
      sessionId: "test-session",
    });

    const events = await collectEvents(loop.run("Hi"));

    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });

  // ── 18. Reasoning/thinking content preserved ──────────────────────────
  it("18. reasoning content extracted from response and preserved", async () => {
    const response = makeTextResponse("Answer.");
    // Add reasoning to the response
    (response.choices[0].message as any).reasoning = "Let me think about this...";
    const mockFetch = createMockFetch([{ body: response }]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Think about it"));

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect((completion.message as any).reasoning).toBe("Let me think about this...");
    }
  });

  // ── 19. Multi-tool parallel dispatch ──────────────────────────────────
  it("19. multi-tool parallel dispatch — results collected for all", async () => {
    const handler1 = vi.fn(async () => "result_1");
    const handler2 = vi.fn(async () => "result_2");
    const handler3 = vi.fn(async () => "result_3");
    registry.register(makeTool("t1", handler1));
    registry.register(makeTool("t2", handler2));
    registry.register(makeTool("t3", handler3));
    const tc1 = makeToolCall("t1", {}, "c1");
    const tc2 = makeToolCall("t2", {}, "c2");
    const tc3 = makeToolCall("t3", {}, "c3");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1, tc2, tc3]) },
      { body: makeTextResponse("All three done.") },
    ]);
    const loop = new AgentLoop({ provider: makeProvider(mockFetch), toolRegistry: registry });

    const events = await collectEvents(loop.run("Run three"));

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
    expect(handler3).toHaveBeenCalled();
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
  });

  // ── 20. Permission denied → denied result sent back ────────────────────
  it("20. denied tool → permission check fires, denied result sent back to model", async () => {
    registry.register(makeTool("dangerous_tool"));
    const permissions = new PermissionModel({ denyList: ["dangerous_tool"] });
    const tc = makeToolCall("dangerous_tool", {}, "call_d");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("I cannot use that tool.") },
    ]);
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
    });

    const events = await collectEvents(loop.run("Use dangerous tool"));

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toContain("denied");
    }

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// IterationBudget unit tests
// ---------------------------------------------------------------------------

describe("IterationBudget", () => {
  it("tracks consumed iterations", () => {
    const budget = new IterationBudget(5);
    expect(budget.exhausted).toBe(false);
    budget.consume();
    budget.consume();
    expect(budget.consumed).toBe(2);
    expect(budget.exhausted).toBe(false);
  });

  it("reports exhausted when limit reached", () => {
    const budget = new IterationBudget(2);
    budget.consume();
    budget.consume();
    expect(budget.exhausted).toBe(true);
  });

  it("defaults to 25 max iterations", () => {
    const budget = new IterationBudget();
    expect(budget.max).toBe(25);
  });
});
