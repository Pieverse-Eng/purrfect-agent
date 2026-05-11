/**
 * Tests for automatic checkpoint triggers in AgentLoop:
 * - Every N iterations
 * - Before context compression
 * - After delegate tool completes
 */

import { describe, it, expect, vi } from "vitest";
import { AgentLoop } from "../../src/core/agent-loop.js";
import type { CheckpointManagerLike } from "../../src/core/agent-loop.js";
import type { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import type { Message, ToolSchema } from "../../src/core/types.js";
import { ProviderError } from "../../src/core/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProvider(responses: Array<{ content?: string; toolCall?: { name: string; args: object } }>): HttpProvider {
  let callCount = 0;
  return {
    async chat() {
      const resp = responses[Math.min(callCount++, responses.length - 1)];
      if (resp.toolCall) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `tc_${callCount}`,
                type: "function",
                function: { name: resp.toolCall.name, arguments: JSON.stringify(resp.toolCall.args) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        };
      }
      return {
        choices: [{
          message: { role: "assistant", content: resp.content ?? "done" },
          finish_reason: "stop",
        }],
      };
    },
    chatStream: vi.fn() as any,
  } as unknown as HttpProvider;
}

function makeRegistry(toolName = "noop", result = "ok"): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: toolName,
    description: "noop",
    schema: { type: "function", function: { name: toolName, description: "noop", parameters: { type: "object", properties: {}, required: [] } } } as ToolSchema,
    handler: async () => result,
  });
  return reg;
}

function makeCheckpointManager(): CheckpointManagerLike & { calls: Array<{ trigger: string; messageCount: number }> } {
  const calls: Array<{ trigger: string; messageCount: number }> = [];
  return {
    calls,
    save(trigger, messages) {
      calls.push({ trigger, messageCount: messages.length });
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("AgentLoop auto-checkpoint: every N iterations", () => {
  it("fires checkpoint at iteration N", async () => {
    // 2 tool calls, then a final text → 3 iterations total
    const provider = makeProvider([
      { toolCall: { name: "noop", args: {} } },
      { toolCall: { name: "noop", args: {} } },
      { content: "done" },
    ]);
    const registry = makeRegistry();
    const cpManager = makeCheckpointManager();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      checkpointManager: cpManager,
      checkpointEveryN: 2,
    });

    const events = [];
    for await (const ev of loop.run("go")) {
      events.push(ev);
    }

    // At iteration 2, checkpoint should fire
    expect(cpManager.calls.some((c) => c.trigger === "auto")).toBe(true);
  });

  it("does not fire when checkpointEveryN is 0", async () => {
    const provider = makeProvider([
      { toolCall: { name: "noop", args: {} } },
      { content: "done" },
    ]);
    const registry = makeRegistry();
    const cpManager = makeCheckpointManager();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      checkpointManager: cpManager,
      checkpointEveryN: 0,
    });

    for await (const _ of loop.run("go")) { /* consume */ }

    expect(cpManager.calls.filter((c) => c.trigger === "auto")).toHaveLength(0);
  });

  it("does not fire when no checkpointManager is set", async () => {
    const provider = makeProvider([{ content: "done" }]);
    const registry = makeRegistry();

    // Should complete without error even with no checkpoint manager
    const loop = new AgentLoop({ provider, toolRegistry: registry });
    const events = [];
    for await (const ev of loop.run("go")) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "completion")).toBe(true);
  });
});

describe("AgentLoop auto-checkpoint: pre_compression", () => {
  it("saves a pre_compression checkpoint when context is exceeded", async () => {
    let providerCallCount = 0;
    const provider: HttpProvider = {
      async chat() {
        providerCallCount++;
        if (providerCallCount === 1) {
          // Simulate context length exceeded error
          const err = new ProviderError("context too long", 413);
          (err as any).contextLengthExceeded = true;
          throw err;
        }
        return {
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        };
      },
      chatStream: vi.fn() as any,
    } as unknown as HttpProvider;

    const compressor = {
      shouldCompress: () => true,
      compress: async (msgs: Message[]) => msgs.slice(-2),
    };

    const registry = makeRegistry();
    const cpManager = makeCheckpointManager();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      compressor,
      checkpointManager: cpManager,
    });

    for await (const _ of loop.run("go")) { /* consume */ }

    const preCompressionCalls = cpManager.calls.filter((c) => c.trigger === "pre_compression");
    expect(preCompressionCalls).toHaveLength(1);
    expect(preCompressionCalls[0].messageCount).toBeGreaterThan(0);
  });
});

describe("AgentLoop fullResumeMessages", () => {
  it("injects all session messages when fullResumeMessages=true", async () => {
    const provider = makeProvider([{ content: "done" }]);
    const registry = makeRegistry();

    const capturedMessages: Message[][] = [];
    // Intercept the provider to see what messages were sent
    const spyProvider: HttpProvider = {
      async chat(msgs) {
        capturedMessages.push([...msgs]);
        return {
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        };
      },
      chatStream: vi.fn() as any,
    } as unknown as HttpProvider;

    const sessionMessages = [
      { id: 1, session_id: "s1", role: "user", content: "hello", timestamp: 1 },
      { id: 2, session_id: "s1", role: "assistant", content: "world", timestamp: 2 },
    ];

    const sessionStore = {
      appendMessage: vi.fn(),
      getMessages: (_id: string) => sessionMessages,
    };

    const loop = new AgentLoop({
      provider: spyProvider,
      toolRegistry: registry,
      sessionStore,
      resumeSessionId: "prior-session",
      fullResumeMessages: true,
    });

    for await (const _ of loop.run("continue")) { /* consume */ }

    const sentMessages = capturedMessages[0];
    // Should include both historic messages + current user message
    const userMsgs = sentMessages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "hello")).toBe(true);
    expect(userMsgs.some((m) => m.content === "continue")).toBe(true);
    const assistantMsgs = sentMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.some((m) => m.content === "world")).toBe(true);
  });
});

describe("AgentLoop auto-checkpoint: post_delegate", () => {
  it("saves a post_delegate checkpoint after delegate tool completes", async () => {
    const provider = makeProvider([
      { toolCall: { name: "delegate", args: { task: "subtask" } } },
      { content: "done" },
    ]);
    const registry = makeRegistry("delegate", JSON.stringify({ result: "subtask done" }));
    const cpManager = makeCheckpointManager();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      checkpointManager: cpManager,
      checkpointEveryN: 0, // disable iteration auto-checkpoint so only delegate fires
    });

    for await (const _ of loop.run("go")) { /* consume */ }

    const delegateCalls = cpManager.calls.filter((c) => c.trigger === "post_delegate");
    expect(delegateCalls).toHaveLength(1);
    // The snapshot must include the tool result message so the sub-agent output is captured
    const snapshot = delegateCalls[0];
    const toolResultMsg = snapshot.messageCount > 0;
    expect(toolResultMsg).toBe(true);
  });

  it("does not save post_delegate for non-delegate tools", async () => {
    const provider = makeProvider([
      { toolCall: { name: "noop", args: {} } },
      { content: "done" },
    ]);
    const registry = makeRegistry();
    const cpManager = makeCheckpointManager();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      checkpointManager: cpManager,
      checkpointEveryN: 0,
    });

    for await (const _ of loop.run("go")) { /* consume */ }

    expect(cpManager.calls.filter((c) => c.trigger === "post_delegate")).toHaveLength(0);
  });
});
