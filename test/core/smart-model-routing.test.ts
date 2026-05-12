import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentEvent } from "../../src/core/agent-loop.js";
import {
  HeuristicModelRoutingPolicy,
  SmartModelRoutingController,
} from "../../src/core/model-routing.js";
import { ModelRouter } from "../../src/core/router.js";
import { SessionStore } from "../../src/core/session-store.js";
import { formatSessionStats } from "../../src/cli/sessions.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import type { ToolDefinition } from "../../src/core/types.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCall,
  makeToolCallResponse,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) events.push(event);
  return events;
}

function makeRouter(mockFetch: typeof fetch): ModelRouter {
  return new ModelRouter(
    {
      models: ["fast-model", "balanced-model", "deep-model"].map((model) => ({
        name: model,
        provider: "openai" as const,
        config: {
          baseUrl: "https://api.test/v1",
          apiKey: "sk-test",
          model,
        },
      })),
    },
    mockFetch,
  );
}

function makeRoutingController(): SmartModelRoutingController {
  return new SmartModelRoutingController({
    tierModels: {
      fast: "fast-model",
      balanced: "balanced-model",
      deep: "deep-model",
    },
  });
}

describe("HeuristicModelRoutingPolicy", () => {
  it("routes simple tool-result follow-up turns to fast", () => {
    const policy = new HeuristicModelRoutingPolicy();
    expect(
      policy.selectTier({
        lastMessage: { role: "tool", content: "small output", tool_call_id: "call-1" },
        contextSizeTokens: 200,
      }),
    ).toBe("fast");
  });

  it("routes architecture/debug prompts to deep", () => {
    const policy = new HeuristicModelRoutingPolicy();
    expect(
      policy.selectTier({
        lastMessage: { role: "user", content: "Find the root cause and design the architecture fix" },
        contextSizeTokens: 500,
      }),
    ).toBe("deep");
  });

  it("uses balanced as the default tier", () => {
    const policy = new HeuristicModelRoutingPolicy();
    expect(
      policy.selectTier({
        lastMessage: { role: "user", content: "Summarize this file" },
        contextSizeTokens: 500,
      }),
    ).toBe("balanced");
  });
});

describe("AgentLoop smart model routing", () => {
  it("switches model tier per iteration before provider calls", async () => {
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([makeToolCall("lookup", {}, "call-lookup")], "balanced-model") },
      { body: makeTextResponse("done", "fast-model") },
    ]);
    const modelRouter = makeRouter(mockFetch);
    const routing = makeRoutingController();
    const registry = new ToolRegistry();
    const lookupTool: ToolDefinition = {
      name: "lookup",
      description: "Lookup data",
      schema: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup data",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "lookup result",
    };
    registry.register(lookupTool);

    const loop = new AgentLoop({
      provider: modelRouter as any,
      toolRegistry: registry,
      smartModelRouting: routing,
    });
    await collectEvents(loop.run("Summarize this data"));

    const calls = (mockFetch as any).calls as Array<{ init: RequestInit }>;
    expect(JSON.parse(calls[0].init.body as string).model).toBe("balanced-model");
    expect(JSON.parse(calls[1].init.body as string).model).toBe("fast-model");
    expect(routing.stats().balanced.requests).toBe(1);
    expect(routing.stats().fast.requests).toBe(1);
  });
});

describe("SessionStore model tier usage", () => {
  it("records tier request counts and token distribution for sessions stats", () => {
    const tmp = createTempDir();
    const store = new SessionStore(`${tmp.path}/sessions.db`);

    try {
      store.createSession({ id: "s1", model: "balanced-model", source: "test" });
      store.recordTokenUsage("s1", {
        input_tokens: 100,
        output_tokens: 10,
        model_tier: "fast",
      });
      store.recordTokenUsage("s1", {
        input_tokens: 300,
        output_tokens: 40,
        model_tier: "deep",
      });

      const usage = store.getTokenUsage("s1");
      expect(usage?.model_tiers.fast.requests).toBe(1);
      expect(usage?.model_tiers.deep.input_tokens).toBe(300);
      expect(formatSessionStats("s1", usage)).toContain("fast: requests=1 input=100 output=10");
      expect(formatSessionStats("s1", usage)).toContain("deep: requests=1 input=300 output=40");
    } finally {
      store.close();
      tmp.cleanup();
    }
  });
});
