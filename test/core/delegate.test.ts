import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentLoop } from "../../src/core/agent-loop.js";
import type { AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { PermissionModel } from "../../src/core/permissions.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { createDelegateTool, DELEGATE_BLOCKED_TOOLS } from "../../src/core/tools/delegate.js";
import type { ToolDefinition } from "../../src/core/types.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

describe("delegate tool", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("runs a child AgentLoop and returns its completion content as JSON", async () => {
    const childResponse = makeTextResponse("child result");
    const parentFinalResponse = makeTextResponse("done");
    const parentToolCallResponse = makeToolCallResponse([
      makeToolCall("delegate", { prompt: "do something" }, "call_d1"),
    ]);

    const mockFetch = createMockFetch([
      { body: parentToolCallResponse },
      { body: childResponse },
      { body: parentFinalResponse },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    const events = await collectEvents(loop.run("please delegate"));

    const toolResult = events.find((event) => event.type === "tool_result" && event.name === "delegate");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(JSON.parse(toolResult.result).result).toBe("child result");
    }
  });

  it("returns structured summary metadata for a single child run", async () => {
    const mockFetch = createMockFetch([
      { body: makeTextResponse("structured child result") },
    ]);
    const provider = makeProvider(mockFetch);
    const delegateTool = createDelegateTool({ provider, toolRegistry: registry });

    const result = JSON.parse(await delegateTool.handler({ prompt: "do one thing" }));

    expect(result.result).toBe("structured child result");
    expect(result.summary).toBe("structured child result");
    expect(result.trajectoryRef).toMatch(/^subagent:\/\//);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.tokensUsed).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });

  it("counts token usage from every child provider turn", async () => {
    registry.register({
      name: "child_tool",
      description: "Child tool",
      schema: {
        type: "function",
        function: {
          name: "child_tool",
          description: "Child tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "tool result",
    });
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("child_tool", {}, "call_child_tool")]) },
      { body: makeTextResponse("child done") },
    ]);
    const provider = makeProvider(mockFetch);
    const delegateTool = createDelegateTool({ provider, toolRegistry: registry });

    const result = JSON.parse(await delegateTool.handler({ prompt: "use a tool" }));

    expect(result.tokensUsed).toEqual({
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
    });
  });

  it("runs parallel subagents and returns per-task summaries", async () => {
    const mockFetch = createMockFetch([
      { body: makeTextResponse("alpha done") },
      { body: makeTextResponse("beta done") },
      { body: makeTextResponse("gamma done") },
    ]);
    const provider = makeProvider(mockFetch);
    const delegateTool = createDelegateTool({ provider, toolRegistry: registry });

    const result = JSON.parse(
      await delegateTool.handler({
        parallel: [
          { task: "alpha" },
          { task: "beta" },
          { task: "gamma" },
        ],
      }),
    );

    expect(result.summary).toBe("3 subagents completed");
    expect(result.results.map((entry: { summary: string }) => entry.summary)).toEqual([
      "alpha done",
      "beta done",
      "gamma done",
    ]);
    expect((mockFetch as any).calls.length).toBe(3);
  });

  it("rejects parallel fanout above the task cap before starting children", async () => {
    const mockFetch = createMockFetch([]);
    const provider = makeProvider(mockFetch);
    const delegateTool = createDelegateTool({ provider, toolRegistry: registry });

    const result = JSON.parse(
      await delegateTool.handler({
        parallel: [
          { task: "one" },
          { task: "two" },
          { task: "three" },
          { task: "four" },
          { task: "five" },
          { task: "six" },
        ],
      }),
    );

    expect(result.error).toContain("at most 5");
    expect((mockFetch as any).calls.length).toBe(0);
    const schema = delegateTool.schema.function.parameters;
    expect((schema.properties as any).parallel.maxItems).toBe(5);
  });

  it("child gets its own session (independent message context)", async () => {
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "what is 2+2" }, "call_d2")]) },
      { body: makeTextResponse("4") },
      { body: makeTextResponse("got it") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    const events = await collectEvents(loop.run("delegate this"));

    const toolResult = events.find((event) => event.type === "tool_result" && event.name === "delegate");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(JSON.parse(toolResult.result).result).toBe("4");
    }
    expect((mockFetch as any).calls.length).toBe(3);
  });

  it("returns error when max delegation depth exceeded", async () => {
    const provider = makeProvider(createMockFetch([]));
    const delegateTool = createDelegateTool({ provider, toolRegistry: registry, depth: 3, maxDepth: 3 });

    const result = await delegateTool.handler({ prompt: "do something" });
    expect(JSON.parse(result).error).toBe("Max delegation depth exceeded");
  });

  it("supports 2 levels of delegation (depth 0 -> 1 -> 2)", async () => {
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "delegate down" }, "call_l0")]) },
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "go deeper" }, "call_l1")]) },
      { body: makeTextResponse("grandchild done") },
      { body: makeTextResponse("level1 done") },
      { body: makeTextResponse("level0 done") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    const events = await collectEvents(loop.run("start chain"));

    const completion = events.find((event) => event.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect(completion.message.content).toBe("level0 done");
    }
    expect((mockFetch as any).calls.length).toBe(5);
  });

  it("returns error JSON when child AgentLoop fails", async () => {
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "fail" }, "call_fail")]) },
      { status: 500, body: JSON.stringify({ error: { message: "Internal Server Error" } }) },
      { body: makeTextResponse("handled") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    const events = await collectEvents(loop.run("delegate and fail"));

    const toolResult = events.find((event) => event.type === "tool_result" && event.name === "delegate");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(JSON.parse(toolResult.result).error).toBeDefined();
    }
  });

  it("child shares parent ToolRegistry", async () => {
    let customToolCalled = false;
    const customTool: ToolDefinition = {
      name: "custom_tool",
      description: "A custom tool",
      schema: {
        type: "function",
        function: {
          name: "custom_tool",
          description: "A custom tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => {
        customToolCalled = true;
        return "custom result";
      },
    };
    registry.register(customTool);

    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "use custom" }, "call_d6")]) },
      { body: makeToolCallResponse([makeToolCall("custom_tool", {}, "call_ct")]) },
      { body: makeTextResponse("child done") },
      { body: makeTextResponse("parent done") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    await collectEvents(loop.run("delegate with custom tool"));

    expect(customToolCalled).toBe(true);
  });

  it("limits child-advertised tools to the requested allowlist", async () => {
    registry.register({
      name: "allowed_tool",
      description: "Allowed child tool",
      schema: {
        type: "function",
        function: {
          name: "allowed_tool",
          description: "Allowed child tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "allowed",
    });
    registry.register({
      name: "blocked_tool",
      description: "Blocked child tool",
      schema: {
        type: "function",
        function: {
          name: "blocked_tool",
          description: "Blocked child tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "blocked",
    });

    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "delegate",
            { prompt: "use a limited toolset", tools: ["allowed_tool"] },
            "call_limited",
          ),
        ]),
      },
      { body: makeTextResponse("child complete") },
      { body: makeTextResponse("parent complete") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    await collectEvents(loop.run("delegate with limited tools"));

    const childRequest = JSON.parse((mockFetch as any).calls[1].init.body as string);
    const childToolNames = childRequest.tools.map((tool: any) => tool.function.name).sort();
    expect(childToolNames).toEqual(["allowed_tool"]);
  });

  it("never advertises DELEGATE_BLOCKED_TOOLS to the child agent", async () => {
    const blockedNames = [...DELEGATE_BLOCKED_TOOLS].filter((name) => name !== "delegate");
    for (const name of blockedNames) {
      registry.register({
        name,
        description: `${name} tool`,
        schema: {
          type: "function",
          function: {
            name,
            description: `${name} tool`,
            parameters: { type: "object", properties: {} },
          },
        },
        handler: async () => `${name} result`,
      });
    }

    registry.register({
      name: "safe_tool",
      description: "Safe child tool",
      schema: {
        type: "function",
        function: {
          name: "safe_tool",
          description: "Safe child tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "safe",
    });

    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("delegate", { prompt: "what tools do you see" }, "call_block"),
        ]),
      },
      { body: makeTextResponse("child done") },
      { body: makeTextResponse("parent done") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    await collectEvents(loop.run("inspect child tools"));

    const childRequest = JSON.parse((mockFetch as any).calls[1].init.body as string);
    const childToolNames: string[] = childRequest.tools.map((tool: any) => tool.function.name);

    for (const blocked of blockedNames) {
      expect(childToolNames).not.toContain(blocked);
    }
    // Non-blocked tools should still be present.
    expect(childToolNames).toContain("safe_tool");
    // Delegate itself is re-registered for deeper levels when depth + 1 < maxDepth.
    expect(childToolNames).toContain("delegate");
  });

  it("drops blocked tools even when explicitly requested via allowlist", async () => {
    registry.register({
      name: "memory",
      description: "parent memory",
      schema: {
        type: "function",
        function: {
          name: "memory",
          description: "parent memory",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "never",
    });
    registry.register({
      name: "safe_tool",
      description: "safe",
      schema: {
        type: "function",
        function: {
          name: "safe_tool",
          description: "safe",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "ok",
    });

    const mockFetch = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "delegate",
            { prompt: "smuggle memory in", tools: ["memory", "safe_tool"] },
            "call_smuggle",
          ),
        ]),
      },
      { body: makeTextResponse("child done") },
      { body: makeTextResponse("parent done") },
    ]);

    const provider = makeProvider(mockFetch);
    registry.register(createDelegateTool({ provider, toolRegistry: registry, depth: 0, maxDepth: 3 }));

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    await collectEvents(loop.run("try to smuggle blocked tool"));

    const childRequest = JSON.parse((mockFetch as any).calls[1].init.body as string);
    const childToolNames = childRequest.tools.map((tool: any) => tool.function.name).sort();
    expect(childToolNames).toEqual(["safe_tool"]);
  });

  it("child inherits permissions and approval callback", async () => {
    const dangerousHandler = vi.fn(async () => "dangerous");
    registry.register({
      name: "dangerous_tool",
      description: "Dangerous child tool",
      schema: {
        type: "function",
        function: {
          name: "dangerous_tool",
          description: "Dangerous child tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: dangerousHandler,
    });

    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "delegate safely" }, "call_parent")]) },
      { body: makeToolCallResponse([makeToolCall("dangerous_tool", {}, "call_child")]) },
      { body: makeTextResponse("child handled denial") },
      { body: makeTextResponse("parent handled child") },
    ]);

    const provider = makeProvider(mockFetch);
    const permissions = new PermissionModel({ denyList: ["dangerous_tool"] });
    const onApprovalRequired = vi.fn(async () => "deny" as const);
    registry.register(
      createDelegateTool({
        provider,
        toolRegistry: registry,
        permissions,
        onApprovalRequired,
        depth: 0,
        maxDepth: 3,
      }),
    );

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    await collectEvents(loop.run("delegate with denied tool"));

    expect(onApprovalRequired).toHaveBeenCalledWith(
      "dangerous_tool",
      {},
      { reason: 'Tool "dangerous_tool" is on the deny list' },
    );
    expect(dangerousHandler).not.toHaveBeenCalled();
  });

  it("does not inherit parent session approvals into child permission domain", async () => {
    const dangerousHandler = vi.fn(async () => "dangerous");
    registry.register({
      name: "dangerous_tool",
      description: "Dangerous child tool",
      schema: {
        type: "function",
        function: {
          name: "dangerous_tool",
          description: "Dangerous child tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: dangerousHandler,
    });

    const dangerousArgs = { command: "rm -rf /tmp/test" };
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("delegate", { prompt: "delegate safely" }, "call_parent")]) },
      { body: makeToolCallResponse([makeToolCall("dangerous_tool", dangerousArgs, "call_child")]) },
      { body: makeTextResponse("child handled denial") },
      { body: makeTextResponse("parent handled child") },
    ]);

    const provider = makeProvider(mockFetch);
    const permissions = new PermissionModel();
    permissions.approveForSession("dangerous_tool", dangerousArgs.command);
    const onApprovalRequired = vi.fn(async () => "deny" as const);
    registry.register(
      createDelegateTool({
        provider,
        toolRegistry: registry,
        permissions,
        onApprovalRequired,
        depth: 0,
        maxDepth: 3,
      }),
    );

    const loop = new AgentLoop({ provider, toolRegistry: registry });
    await collectEvents(loop.run("delegate with parent-approved command"));

    expect(onApprovalRequired).toHaveBeenCalledWith(
      "dangerous_tool",
      dangerousArgs,
      { reason: "delete in root path" },
    );
    expect(dangerousHandler).not.toHaveBeenCalled();
  });
});
