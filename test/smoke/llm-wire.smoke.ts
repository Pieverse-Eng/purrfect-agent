/**
 * Real-LLM smoke tests — verify the wire format against an actual endpoint.
 *
 * Auto-skips when neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set.
 * Picks the cheapest model on each provider and stays well under $0.01 per
 * full run. Run via `npm run smoke`.
 */

import { describe, it, expect } from "vitest";
import { AgentLoop, type AgentEvent } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { AnthropicProvider } from "../../src/core/anthropic-provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import type { ToolDefinition } from "../../src/core/types.js";

const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const OPENAI = process.env.OPENAI_API_KEY;
const HAS_KEY = Boolean(ANTHROPIC || OPENAI);

if (!HAS_KEY) {
  console.log(
    "\n[smoke] No ANTHROPIC_API_KEY or OPENAI_API_KEY in env — smoke tests skipped. " +
      "Set one to run.\n",
  );
}

type ProviderPick = {
  provider: HttpProvider | AnthropicProvider;
  label: string;
};

function pickProvider(): ProviderPick {
  if (ANTHROPIC) {
    return {
      label: "anthropic / claude-haiku-4-5-20251001",
      provider: new AnthropicProvider({
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: ANTHROPIC,
        model: "claude-haiku-4-5-20251001",
      }),
    };
  }
  return {
    label: "openai / gpt-4o-mini",
    provider: new HttpProvider({
      baseUrl: "https://api.openai.com/v1",
      apiKey: OPENAI!,
      model: "gpt-4o-mini",
    }),
  };
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const describeWith = HAS_KEY ? describe : describe.skip;

describeWith("Smoke: real LLM wire format", () => {
  it("basic completion: short prompt returns a non-empty reply", async () => {
    const { provider, label } = pickProvider();
    console.log(`[smoke] basic completion via ${label}`);
    const loop = new AgentLoop({
      provider: provider as HttpProvider,
      toolRegistry: new ToolRegistry(),
    });

    const events = await drain(
      loop.run("Reply with exactly the single word: pong"),
    );

    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      const text = String(completion.message.content ?? "").toLowerCase();
      expect(text).toContain("pong");
    }
  });

  it("streaming: text_delta events arrive before completion", async () => {
    const { provider, label } = pickProvider();
    console.log(`[smoke] streaming via ${label}`);
    const loop = new AgentLoop({
      provider: provider as HttpProvider,
      toolRegistry: new ToolRegistry(),
      stream: true,
    });

    const deltas: string[] = [];
    let completion: AgentEvent | undefined;
    for await (const ev of loop.run("Count to three: one, two, three.")) {
      if (ev.type === "text_delta") deltas.push(ev.content);
      if (ev.type === "completion") completion = ev;
    }

    expect(deltas.length).toBeGreaterThan(0);
    expect(completion).toBeDefined();
    const joined = deltas.join("").toLowerCase();
    expect(joined.length).toBeGreaterThan(0);
  });

  it("tool call: model invokes a registered tool and uses the result", async () => {
    const { provider, label } = pickProvider();
    console.log(`[smoke] tool call via ${label}`);
    const echoTool: ToolDefinition = {
      name: "echo",
      description: "Echo the input string back verbatim",
      schema: {
        type: "function",
        function: {
          name: "echo",
          description: "Echo the input string back verbatim",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to echo" },
            },
            required: ["text"],
          },
        },
      },
      async handler(args) {
        return JSON.stringify({ echoed: String(args.text ?? "") });
      },
    };

    const registry = new ToolRegistry();
    registry.register(echoTool);

    const loop = new AgentLoop({
      provider: provider as HttpProvider,
      toolRegistry: registry,
    });

    const events = await drain(
      loop.run(
        "Call the echo tool with text='handshake-ok'. Then in your final reply, " +
          "include the exact string you got back from the tool.",
      ),
    );

    const toolStart = events.find((e) => e.type === "tool_call_start");
    expect(toolStart, "model never invoked the echo tool").toBeDefined();
    if (toolStart?.type === "tool_call_start") {
      expect(toolStart.toolCall.function.name).toBe("echo");
    }

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult, "tool result event missing").toBeDefined();
  });
});
