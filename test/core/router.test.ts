import { describe, it, expect, vi } from "vitest";
import { ModelRouter, type ModelRouterConfig } from "../../src/core/router.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";
import { RateLimitError, NetworkError } from "../../src/core/errors.js";

function makeRouterConfig(
  overrides?: Partial<ModelRouterConfig>,
): ModelRouterConfig {
  return {
    models: [
      {
        name: "claude-opus-4-20250514",
        provider: "anthropic",
        config: {
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "sk-ant-test",
          model: "claude-opus-4-20250514",
        },
      },
      {
        name: "gpt-4o",
        provider: "openai",
        config: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          model: "gpt-4o",
        },
      },
    ],
    ...overrides,
  };
}

/** Build an Anthropic-style JSON response body for mock fetch. */
function makeAnthropicResponse(content: string, model = "claude-opus-4-20250514") {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("ModelRouter", () => {
  const messages = [{ role: "user" as const, content: "Hello", tool_calls: undefined, tool_call_id: undefined, name: undefined }];
  const tools: [] = [];

  it("returns response from the primary model on success", async () => {
    const mockFetch = createMockFetch([
      { status: 200, body: JSON.stringify(makeAnthropicResponse("Hi from Claude")) },
    ]);

    const router = new ModelRouter(makeRouterConfig(), mockFetch);
    const result = await router.chat(messages, tools);

    expect(result.choices[0].message.content).toBe("Hi from Claude");
    expect(result.model).toContain("claude");
  });

  it("falls back to next model when primary fails with RateLimitError", async () => {
    const mockFetch = createMockFetch([
      // First call: Anthropic returns 429
      { status: 429, body: JSON.stringify({ error: { message: "Rate limited" } }) },
      // Second call: OpenAI fallback succeeds
      { status: 200, body: makeTextResponse("Hi from GPT", "gpt-4o") },
    ]);

    const onModelSwitch = vi.fn();
    const router = new ModelRouter(
      makeRouterConfig({ onModelSwitch }),
      mockFetch,
    );
    const result = await router.chat(messages, tools);

    expect(result.choices[0].message.content).toBe("Hi from GPT");
    expect(result.model).toBe("gpt-4o");
    expect(onModelSwitch).toHaveBeenCalledWith("claude-opus-4-20250514", "gpt-4o");
  });

  it("surfaces the last error when all models fail", async () => {
    const mockFetch = createMockFetch([
      { status: 429, body: JSON.stringify({ error: { message: "Rate limited 1" } }) },
      { status: 429, body: JSON.stringify({ error: { message: "Rate limited 2" } }) },
    ]);

    const router = new ModelRouter(makeRouterConfig(), mockFetch);

    await expect(router.chat(messages, tools)).rejects.toThrow(RateLimitError);
    await expect(
      // Re-create router because mock is consumed
      new ModelRouter(makeRouterConfig(), createMockFetch([
        { status: 429, body: JSON.stringify({ error: { message: "Rate limited 1" } }) },
        { status: 429, body: JSON.stringify({ error: { message: "Rate limited 2" } }) },
      ])).chat(messages, tools),
    ).rejects.toThrow("Rate limited 2");
  });

  it("behaves like a direct provider with a single model", async () => {
    const singleConfig: ModelRouterConfig = {
      models: [
        {
          name: "gpt-4o",
          provider: "openai",
          config: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            model: "gpt-4o",
          },
        },
      ],
    };

    const mockFetch = createMockFetch([
      { status: 200, body: makeTextResponse("Only model", "gpt-4o") },
    ]);

    const router = new ModelRouter(singleConfig, mockFetch);
    const result = await router.chat(messages, tools);

    expect(result.choices[0].message.content).toBe("Only model");
    expect(router.currentModel()).toBe("gpt-4o");
  });

  it("switchModel() changes the primary model for subsequent calls", async () => {
    const mockFetch = createMockFetch([
      { status: 200, body: makeTextResponse("From GPT", "gpt-4o") },
    ]);

    const router = new ModelRouter(makeRouterConfig(), mockFetch);
    expect(router.currentModel()).toBe("claude-opus-4-20250514");

    router.switchModel("gpt-4o");
    expect(router.currentModel()).toBe("gpt-4o");

    const result = await router.chat(messages, tools);
    expect(result.choices[0].message.content).toBe("From GPT");
    // Verify the request went to the OpenAI endpoint
    const calls = (mockFetch as any).calls as Array<{ url: string }>;
    expect(calls[0].url).toContain("openai.com");
  });

  it("currentModel() returns the active model name", () => {
    const router = new ModelRouter(makeRouterConfig());
    expect(router.currentModel()).toBe("claude-opus-4-20250514");

    router.switchModel("gpt-4o");
    expect(router.currentModel()).toBe("gpt-4o");
  });
});
