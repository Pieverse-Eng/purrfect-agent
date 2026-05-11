import { describe, it, expect } from "vitest";
import { AgentLoop } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";

describe("AgentLoop system prompt", () => {
  it("prepends the configured system prompt to provider requests", async () => {
    const calls: string[] = [];
    const baseFetch = createMockFetch([{ body: makeTextResponse("done") }]);
    const capturingFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") {
        calls.push(init.body);
      }
      return baseFetch(input, init);
    };

    const provider = new HttpProvider(
      { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
      capturingFetch,
    );
    const loop = new AgentLoop({
      provider,
      toolRegistry: new ToolRegistry(),
      systemPrompt: "You are ProjectBot.",
    });

    for await (const _event of loop.run("hello")) {
      // drain
    }

    const requestBody = JSON.parse(calls[0]);
    expect(requestBody.messages).toEqual([
      { role: "system", content: "You are ProjectBot." },
      { role: "user", content: "hello" },
    ]);
  });
});
