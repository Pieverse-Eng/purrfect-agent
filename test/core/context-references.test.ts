import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentLoop, type AgentEvent } from "../../src/core/agent-loop.js";
import { ContextReferenceStore, createReadRefTool } from "../../src/core/context-references.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import type { ToolDefinition } from "../../src/core/types.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCall,
  makeToolCallResponse,
} from "../helpers/mock-server.js";

function tempPath(): string {
  return join(tmpdir(), `purrfect-context-refs-${randomUUID()}`);
}

async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

describe("ContextReferenceStore", () => {
  it("stores large tool results as refs and resolves them round-trip", async () => {
    const baseDir = tempPath();
    const store = new ContextReferenceStore({ baseDir, thresholdBytes: 16 });
    const largeResult = "x".repeat(128);

    try {
      const materialized = await store.materializeToolResult({
        sessionId: "session-a",
        toolCallId: "call-a",
        toolName: "shell_exec",
        content: largeResult,
      });

      expect(materialized.reference?.uri).toBe("ref://tool-result/session-a/call-a");
      expect(materialized.content.length).toBeLessThan(largeResult.length);
      expect(materialized.content).toContain("ref://tool-result/session-a/call-a");
      await expect(store.resolve(materialized.reference!.uri)).resolves.toBe(largeResult);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("shrinks 50 large tool results by at least 70 percent", async () => {
    const baseDir = tempPath();
    const store = new ContextReferenceStore({ baseDir, thresholdBytes: 128 });
    const largeResult = "0123456789abcdef".repeat(512);

    try {
      const originalBytes = largeResult.length * 50;
      let referencedBytes = 0;

      for (let i = 0; i < 50; i++) {
        const materialized = await store.materializeToolResult({
          sessionId: "long-session",
          toolCallId: `call-${i}`,
          toolName: "file_read",
          content: largeResult,
        });
        referencedBytes += materialized.content.length;
      }

      expect(referencedBytes).toBeLessThan(originalBytes * 0.3);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("read_ref tool", () => {
  it("resolves a stored tool-result ref", async () => {
    const baseDir = tempPath();
    const store = new ContextReferenceStore({ baseDir, thresholdBytes: 8 });

    try {
      const materialized = await store.materializeToolResult({
        sessionId: "session-b",
        toolCallId: "call-b",
        toolName: "web_fetch",
        content: "large web response",
      });
      const tool = createReadRefTool(store);
      const result = JSON.parse(await tool.handler({ uri: materialized.reference!.uri }));

      expect(result.content).toBe("large web response");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("AgentLoop context references", () => {
  it("automatically replaces large tool results before returning them to the model", async () => {
    const baseDir = tempPath();
    const store = new ContextReferenceStore({ baseDir, thresholdBytes: 16 });
    const bigPayload = "payload-".repeat(64);
    const bigTool: ToolDefinition = {
      name: "big_tool",
      description: "Return a large payload",
      schema: {
        type: "function",
        function: {
          name: "big_tool",
          description: "Return a large payload",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => bigPayload,
    };

    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("big_tool", {}, "call-large")]) },
      { body: makeTextResponse("summarized") },
    ]);

    try {
      const registry = new ToolRegistry();
      registry.register(bigTool);
      const loop = new AgentLoop({
        provider: makeProvider(mockFetch),
        toolRegistry: registry,
        sessionId: "session-loop",
        contextReferences: store,
      });

      const events = await collectEvents(loop.run("call the big tool"));
      const toolResult = events.find((event) => event.type === "tool_result");

      expect(toolResult).toBeDefined();
      if (toolResult?.type !== "tool_result") throw new Error("missing tool result");
      const parsed = JSON.parse(toolResult.result);
      expect(parsed.ref).toBe("ref://tool-result/session-loop/call-large");
      expect(JSON.stringify((mockFetch as any).calls[1].init.body)).not.toContain(bigPayload);
      await expect(store.resolve(parsed.ref)).resolves.toBe(bigPayload);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not re-materialize explicit read_ref results", async () => {
    const baseDir = tempPath();
    const store = new ContextReferenceStore({ baseDir, thresholdBytes: 16 });
    const bigPayload = "payload-".repeat(64);
    const bigTool: ToolDefinition = {
      name: "big_tool",
      description: "Return a large payload",
      schema: {
        type: "function",
        function: {
          name: "big_tool",
          description: "Return a large payload",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => bigPayload,
    };

    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("big_tool", {}, "call-large")]) },
      {
        body: makeToolCallResponse([
          makeToolCall(
            "read_ref",
            { uri: "ref://tool-result/session-loop/call-large" },
            "call-read-ref",
          ),
        ]),
      },
      { body: makeTextResponse("done") },
    ]);

    try {
      const registry = new ToolRegistry();
      registry.register(bigTool);
      registry.register(createReadRefTool(store));
      const loop = new AgentLoop({
        provider: makeProvider(mockFetch),
        toolRegistry: registry,
        sessionId: "session-loop",
        contextReferences: store,
      });

      const events = await collectEvents(loop.run("call and read the big tool"));
      const readRefResult = events
        .filter((event) => event.type === "tool_result" && event.name === "read_ref")
        .at(0);

      expect(readRefResult).toBeDefined();
      if (readRefResult?.type !== "tool_result") throw new Error("missing read_ref result");
      const parsed = JSON.parse(readRefResult.result);
      expect(parsed.content).toBe(bigPayload);
      expect(parsed.ref).toBeUndefined();
      expect(JSON.stringify((mockFetch as any).calls[2].init.body)).toContain(bigPayload);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
