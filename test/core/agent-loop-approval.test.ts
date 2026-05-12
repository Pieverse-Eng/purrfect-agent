/**
 * Unit 6 — Interactive Tool Approval tests.
 * Tests the onApprovalRequired callback in AgentLoopOptions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoop, AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { PermissionModel } from "../../src/core/permissions.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";
import type { ToolDefinition } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

function makeTool(
  name: string,
  handler?: (args: Record<string, unknown>) => Promise<string>,
): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    schema: {
      type: "function",
      function: {
        name,
        description: `Test tool ${name}`,
        parameters: { type: "object", properties: {} },
      },
    },
    handler: handler ?? (async () => `result from ${name}`),
  };
}

async function collectEvents(
  iter: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLoop — Interactive Tool Approval (Unit 6)", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ── 1. allow_once → tool executes, result returned ────────────────────
  it("1. denied tool + callback returns allow_once → tool executes, result returned", async () => {
    const handler = vi.fn(async () => "dangerous output");
    registry.register(makeTool("dangerous_tool", handler));
    const permissions = new PermissionModel({ denyList: ["dangerous_tool"] });

    const onApprovalRequired = vi.fn(async () => "allow_once" as const);

    const tc = makeToolCall("dangerous_tool", { foo: "bar" }, "call_1");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("Used dangerous tool.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
      onApprovalRequired,
    });

    const events = await collectEvents(loop.run("Do dangerous thing"));

      // Callback was invoked with correct tool name and args
      expect(onApprovalRequired).toHaveBeenCalledTimes(1);
      expect(onApprovalRequired).toHaveBeenCalledWith(
        "dangerous_tool",
        { foo: "bar" },
        { reason: 'Tool "dangerous_tool" is on the deny list' },
      );

    // Tool handler was executed
    expect(handler).toHaveBeenCalled();

    // Tool result event contains handler output (not permission denied)
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toBe("dangerous output");
      expect(toolResult.result).not.toContain("denied");
    }

    // Completion reached
    expect(events.some((e) => e.type === "completion")).toBe(true);
  });

  // ── 2. allow_session → tool executes, subsequent calls auto-approved ──
  it("2. denied tool + callback returns allow_session → tool executes, subsequent calls auto-approved", async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => `ran with ${JSON.stringify(args)}`);
    registry.register(makeTool("shell", handler));
    const permissions = new PermissionModel({ allowList: ["other_tool"] }); // shell not allowed

    const onApprovalRequired = vi.fn(async () => "allow_session" as const);

    const tc1 = makeToolCall("shell", { command: "ls" }, "call_1");
    const tc2 = makeToolCall("shell", { command: "ls" }, "call_2");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1]) },
      { body: makeToolCallResponse([tc2]) },
      { body: makeTextResponse("Done.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
      onApprovalRequired,
    });

    const events = await collectEvents(loop.run("Run shell twice"));

    // Callback called only once — second call was auto-approved via session
    expect(onApprovalRequired).toHaveBeenCalledTimes(1);

    // Both tool calls executed
    expect(handler).toHaveBeenCalledTimes(2);

    // Both tool results present (not denied)
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    for (const tr of toolResults) {
      if (tr.type === "tool_result") {
        expect(tr.result).not.toContain("denied");
      }
    }

    expect(events.some((e) => e.type === "completion")).toBe(true);
  });

  it("2b. allow_session is scoped to the exact invocation, not every later call", async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => `ran with ${JSON.stringify(args)}`);
    registry.register(makeTool("shell", handler));
    const permissions = new PermissionModel();

    const onApprovalRequired = vi.fn(async () => "allow_session" as const);

    const tc1 = makeToolCall("shell", { command: "rm -rf /tmp/test-a" }, "call_1");
    const tc2 = makeToolCall("shell", { command: "rm -rf /tmp/test-b" }, "call_2");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc1]) },
      { body: makeToolCallResponse([tc2]) },
      { body: makeTextResponse("Done.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
      onApprovalRequired,
    });

    const events = await collectEvents(loop.run("Run two dangerous commands"));

    expect(onApprovalRequired).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(2);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
  });

  // ── 3. deny → error result sent to model ──────────────────────────────
  it("3. denied tool + callback returns deny → error result sent to model", async () => {
    const handler = vi.fn(async () => "should not run");
    registry.register(makeTool("dangerous_tool", handler));
    const permissions = new PermissionModel({ denyList: ["dangerous_tool"] });

    const onApprovalRequired = vi.fn(async () => "deny" as const);

    const tc = makeToolCall("dangerous_tool", { x: 1 }, "call_d");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("OK, I won't use that.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
      onApprovalRequired,
    });

    const events = await collectEvents(loop.run("Use dangerous"));

    // Callback was invoked
    expect(onApprovalRequired).toHaveBeenCalledTimes(1);

    // Tool handler was NOT executed
    expect(handler).not.toHaveBeenCalled();

    // Tool result contains denial
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toContain("denied");
    }

    expect(events.some((e) => e.type === "completion")).toBe(true);
  });

  // ── 4. No callback → falls back to auto-deny (v1 behavior) ───────────
  it("4. no callback provided → falls back to auto-deny (v1 behavior)", async () => {
    const handler = vi.fn(async () => "should not run");
    registry.register(makeTool("dangerous_tool", handler));
    const permissions = new PermissionModel({ denyList: ["dangerous_tool"] });

    const tc = makeToolCall("dangerous_tool", {}, "call_v1");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("Cannot use that.") },
    ]);

    // No onApprovalRequired callback
    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
    });

    const events = await collectEvents(loop.run("Use dangerous"));

    // Tool handler NOT executed
    expect(handler).not.toHaveBeenCalled();

    // Denied result sent to model
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toContain("denied");
    }

    expect(events.some((e) => e.type === "completion")).toBe(true);
  });

  // ── 5. Integration: permission check → approval → dispatch → result ───
  it("5. callback integration: permission check → approval → tool dispatch → result in loop", async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => {
      return `file contents of ${args.path}`;
    });
    registry.register(makeTool("read_file", handler));

    // read_file is denied via dangerous command pattern detection
    // Use denyList to block it
    const permissions = new PermissionModel({ denyList: ["read_file"] });

    const approvalLog: string[] = [];
    const onApprovalRequired = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      approvalLog.push(`${toolName}:${JSON.stringify(args)}`);
      return "allow_once" as const;
    });

    const tc = makeToolCall("read_file", { path: "/etc/passwd" }, "call_rf");
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([tc]) },
      { body: makeTextResponse("Here are the file contents.") },
    ]);

    const loop = new AgentLoop({
      provider: makeProvider(mockFetch),
      toolRegistry: registry,
      permissions,
      onApprovalRequired,
    });

    const events = await collectEvents(loop.run("Read /etc/passwd"));
    const types = events.map((e) => e.type);

    // Full flow: tool_call_start → tool_result → completion
    expect(types).toContain("tool_call_start");
    expect(types).toContain("tool_result");
    expect(types).toContain("completion");

    // Approval callback received correct args
    expect(approvalLog).toEqual(['read_file:{"path":"/etc/passwd"}']);

    // Tool was dispatched with correct args
    expect(handler).toHaveBeenCalledWith({ path: "/etc/passwd" });

    // Result from tool handler flows through
    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result).toBe("file contents of /etc/passwd");
    }

    // Model received tool result and produced completion
    const calls = (mockFetch as any).calls;
    expect(calls).toHaveLength(2);
    const secondBody = JSON.parse(calls[1].init.body as string);
    const toolMsg = secondBody.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe("file contents of /etc/passwd");
  });
});
