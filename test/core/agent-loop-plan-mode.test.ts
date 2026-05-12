import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoop, type AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";
import type { ToolDefinition } from "../../src/core/types.js";

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
  for await (const ev of iter) events.push(ev);
  return events;
}

describe("AgentLoop plan mode", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool("file_read"));
    registry.register(makeTool("shell_exec"));
    registry.register(makeTool("file_write"));
  });

  it("filters mutating tool schemas when plan mode is active", async () => {
    // The provider receives tool schemas. When plan mode is on, shell_exec and
    // file_write should be excluded from the schemas sent to the LLM.
    let capturedTools: unknown[] | undefined;

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedTools = body.tools;
      return new Response(JSON.stringify(makeTextResponse("plan looks good")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => true,
    });

    await collectEvents(loop.run("make a plan"));

    expect(capturedTools).toBeDefined();
    const toolNames = (capturedTools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(toolNames).toContain("file_read");
    expect(toolNames).not.toContain("shell_exec");
    expect(toolNames).not.toContain("file_write");
  });

  it("sends all tool schemas when plan mode is off", async () => {
    let capturedTools: unknown[] | undefined;

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedTools = body.tools;
      return new Response(JSON.stringify(makeTextResponse("done")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => false,
    });

    await collectEvents(loop.run("do something"));

    const toolNames = (capturedTools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(toolNames).toContain("file_read");
    expect(toolNames).toContain("shell_exec");
    expect(toolNames).toContain("file_write");
  });

  it("blocks mutating tool dispatch with not_allowed_in_plan_mode error", async () => {
    // Even if the LLM somehow sends a blocked tool call, it should be rejected
    const tc = makeToolCall("shell_exec", { command: "rm -rf /" }, "call_1");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("ok") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => true,
    });

    const events = await collectEvents(loop.run("run something"));
    const toolResult = events.find(
      (e) => e.type === "tool_result" && e.name === "shell_exec",
    );
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      const parsed = JSON.parse(toolResult.result);
      expect(parsed.error).toBe("not_allowed_in_plan_mode");
      expect(parsed.tool).toBe("shell_exec");
    }
  });

  it("allows read-only tool dispatch in plan mode", async () => {
    const tc = makeToolCall("file_read", { path: "/tmp/test" }, "call_1");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("file contents") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => true,
    });

    const events = await collectEvents(loop.run("read file"));
    const toolResult = events.find(
      (e) => e.type === "tool_result" && e.name === "file_read",
    );
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toBe("result from file_read");
    }
  });

  it("responds to dynamic plan mode changes between iterations", async () => {
    let planMode = true;
    const capturedToolNames: string[][] = [];

    // Iter 1: plan mode ON, agent calls shell_exec → blocked.
    // Iter 2: plan mode toggled OFF (in test loop), agent calls shell_exec → succeeds.
    // Iter 3: text response ends the run.
    const blockedCall = makeToolCall("shell_exec", { command: "ls" }, "call_1");
    const allowedCall = makeToolCall("shell_exec", { command: "echo hi" }, "call_2");

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedToolNames.push(
        (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
      );
      const callIdx = capturedToolNames.length;
      if (callIdx === 1) {
        return new Response(JSON.stringify(makeToolCallResponse([blockedCall])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (callIdx === 2) {
        return new Response(JSON.stringify(makeToolCallResponse([allowedCall])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(makeTextResponse("done")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => planMode,
    });

    const events: AgentEvent[] = [];
    for await (const ev of loop.run("test")) {
      events.push(ev);
      // Toggle off after the first blocked result
      if (ev.type === "tool_result" && ev.name === "shell_exec" && planMode) {
        planMode = false;
      }
    }

    // Iter 1 should have filtered shell_exec out of the schema
    expect(capturedToolNames[0]).not.toContain("shell_exec");
    // Iter 2 (after toggle) should expose shell_exec again
    expect(capturedToolNames[1]).toContain("shell_exec");

    const toolResults = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.name === "shell_exec",
    );
    expect(toolResults).toHaveLength(2);

    // First call blocked
    const firstParsed = JSON.parse(toolResults[0].result);
    expect(firstParsed.error).toBe("not_allowed_in_plan_mode");

    // Second call dispatched normally after toggle off
    expect(toolResults[1].result).toBe("result from shell_exec");
  });

  it("hides exit_plan_mode when not in plan mode", async () => {
    registry.register(makeTool("exit_plan_mode"));
    let capturedTools: unknown[] | undefined;

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedTools = body.tools;
      return new Response(JSON.stringify(makeTextResponse("ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => false,
    });

    await collectEvents(loop.run("hello"));

    const names = (capturedTools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(names).not.toContain("exit_plan_mode");
  });

  it("hides enter_plan_mode when already in plan mode", async () => {
    registry.register(makeTool("enter_plan_mode"));
    let capturedTools: unknown[] | undefined;

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedTools = body.tools;
      return new Response(JSON.stringify(makeTextResponse("ok")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      getPlanMode: () => true,
    });

    await collectEvents(loop.run("hello"));

    const names = (capturedTools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(names).not.toContain("enter_plan_mode");
  });
});
