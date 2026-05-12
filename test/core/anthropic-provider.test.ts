import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../../src/core/anthropic-provider.js";
import {
  AuthError,
  RateLimitError,
  ProviderError,
} from "../../src/core/errors.js";
import { createMockFetch } from "../helpers/mock-server.js";
import type { Message, ToolSchema, StreamDelta } from "../../src/core/types.js";

// ── Anthropic-specific mock helpers ──────────────────────────────────

function makeAnthropicTextResponse(text: string, model = "claude-sonnet-4-5") {
  return {
    id: "msg_01XFDUDYJgAACzvnptvVoYEL",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 25, output_tokens: 10 },
  };
}

function makeAnthropicToolUseResponse(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  model = "claude-sonnet-4-5",
) {
  return {
    id: "msg_01XFDUDYJgAACzvnptvVoYEL",
    type: "message",
    role: "assistant",
    model,
    content: toolUses.map((tu) => ({
      type: "tool_use",
      id: tu.id,
      name: tu.name,
      input: tu.input,
    })),
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 25, output_tokens: 10 },
  };
}

function makeAnthropicThinkingResponse(
  thinking: string,
  text: string,
  model = "claude-sonnet-4-5",
) {
  return {
    id: "msg_01XFDUDYJgAACzvnptvVoYEL",
    type: "message",
    role: "assistant",
    model,
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 25, output_tokens: 50 },
  };
}

function makeAnthropicSSEStream(events: Array<{ event: string; data: Record<string, unknown> }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}`).join("\n\n") + "\n\n";
}

function makeAnthropicStreamingTextEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_stream_01",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 25, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────

describe("AnthropicProvider: chat()", () => {
  it("1. sends Anthropic Messages API format (system separate, content blocks)", async () => {
    const mockResponse = makeAnthropicTextResponse("Hello!");
    const mockFetch = createMockFetch([{ body: mockResponse as any }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];

    await provider.chat(messages, []);

    const call = (mockFetch as any).calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");

    const body = JSON.parse(call.init.body as string);
    // System extracted as top-level parameter
    expect(body.system).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
    ]);
    // Messages should NOT include system message
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("Hi");
    // Model and max_tokens mandatory
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBeGreaterThan(0);

    // Auth headers: x-api-key, not Bearer
    const headers = call.init.headers;
    expect(headers["x-api-key"]).toBe("sk-ant-api-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("applies prompt caching markers and normalizes cache usage", async () => {
    const mockResponse = {
      ...makeAnthropicTextResponse("Cached hello"),
      usage: {
        input_tokens: 25,
        output_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 250,
      },
    };
    const mockFetch = createMockFetch([{ body: mockResponse as any }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    const tools: ToolSchema[] = [
      {
        type: "function",
        function: {
          name: "file_read",
          description: "Read file",
          parameters: { type: "object" },
        },
      },
    ];

    const result = await provider.chat(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "First" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second" },
      ],
      tools,
    );

    expect(result.usage?.cache_creation_input_tokens).toBe(100);
    expect(result.usage?.cache_read_input_tokens).toBe(250);

    const call = (mockFetch as any).calls[0];
    const body = JSON.parse(call.init.body as string);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2].content).toBe("Second");
  });

  it("2. response with text content blocks → neutral Message with string content", async () => {
    const mockResponse = makeAnthropicTextResponse("Hello world!");
    const mockFetch = createMockFetch([{ body: mockResponse as any }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    const result = await provider.chat(
      [{ role: "user", content: "Hi" }],
      [],
    );

    // Response should be deserialized to neutral ChatResponse format
    expect(result.id).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].message.content).toBe("Hello world!");
    expect(result.choices[0].finish_reason).toBe("end_turn");
  });

  it("3. response with tool_use blocks → neutral Message with ToolCall[]", async () => {
    const mockResponse = makeAnthropicToolUseResponse([
      { id: "toolu_01A", name: "file_read", input: { path: "/tmp/test.txt" } },
    ]);
    const mockFetch = createMockFetch([{ body: mockResponse as any }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    const result = await provider.chat(
      [{ role: "user", content: "read file" }],
      [],
    );

    const toolCalls = result.choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls![0].id).toBe("toolu_01A");
    expect(toolCalls![0].type).toBe("function");
    expect(toolCalls![0].function.name).toBe("file_read");
    expect(JSON.parse(toolCalls![0].function.arguments)).toEqual({ path: "/tmp/test.txt" });
  });
});

describe("AnthropicProvider: chatStream()", () => {
  it("4. yields text deltas from content_block_delta events", async () => {
    const sseText = makeAnthropicSSEStream(makeAnthropicStreamingTextEvents("Hello streaming!"));
    const mockFetch = createMockFetch([{ body: sseText, stream: true }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chatStream(
      [{ role: "user", content: "Hi" }],
      [],
    )) {
      deltas.push(delta);
    }

    const textDeltas = deltas.filter((d) => d.type === "text");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].content).toBe("Hello streaming!");

    const doneDeltas = deltas.filter((d) => d.type === "done");
    expect(doneDeltas.length).toBeGreaterThanOrEqual(1);

    // Verify stream=true was sent
    const call = (mockFetch as any).calls[0];
    const body = JSON.parse(call.init.body as string);
    expect(body.stream).toBe(true);
  });

  it("5. thinking blocks in response → preserved as thinking events", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_think_01",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 25, output_tokens: 0 },
          },
        },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: 0 },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here's my answer" } },
      },
      {
        event: "content_block_stop",
        data: { type: "content_block_stop", index: 1 },
      },
      {
        event: "message_delta",
        data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
      },
      {
        event: "message_stop",
        data: { type: "message_stop" },
      },
    ];

    const sseText = makeAnthropicSSEStream(events);
    const mockFetch = createMockFetch([{ body: sseText, stream: true }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chatStream(
      [{ role: "user", content: "Think hard" }],
      [],
    )) {
      deltas.push(delta);
    }

    const thinkingDeltas = deltas.filter((d) => d.type === "thinking");
    expect(thinkingDeltas).toHaveLength(1);
    expect(thinkingDeltas[0].content).toBe("Let me think...");

    const textDeltas = deltas.filter((d) => d.type === "text");
    expect(textDeltas).toHaveLength(1);
    expect(textDeltas[0].content).toBe("Here's my answer");
  });
});

describe("AnthropicProvider: auto-detect", () => {
  it("6. auto-detect Anthropic from baseUrl containing 'anthropic'", () => {
    // The static method should detect anthropic from the URL
    expect(AnthropicProvider.isAnthropicUrl("https://api.anthropic.com/v1")).toBe(true);
    expect(AnthropicProvider.isAnthropicUrl("https://custom-anthropic-proxy.example.com/v1")).toBe(true);
    expect(AnthropicProvider.isAnthropicUrl("https://api.openai.com/v1")).toBe(false);
  });
});

describe("AnthropicProvider: error handling", () => {
  it("7. 401 → AuthError", async () => {
    const mockFetch = createMockFetch([{
      status: 401,
      body: JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
    }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "bad-key",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    await expect(
      provider.chat([{ role: "user", content: "Hi" }], []),
    ).rejects.toThrow(AuthError);
  });

  it("8. 429 → RateLimitError with retry-after header", async () => {
    const mockFetch = createMockFetch([{
      status: 429,
      body: JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited" } }),
      headers: { "retry-after": "30" },
    }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    try {
      await provider.chat([{ role: "user", content: "Hi" }], []);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(30);
    }
  });

  it("9. 529 overloaded → ProviderError", async () => {
    const mockFetch = createMockFetch([{
      status: 529,
      body: JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
    }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    try {
      await provider.chat([{ role: "user", content: "Hi" }], []);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(529);
    }
  });

  it("10. 400 prompt-too-long → ProviderError with contextLengthExceeded", async () => {
    const mockFetch = createMockFetch([{
      status: 400,
      body: JSON.stringify({
        error: { type: "invalid_request_error", message: "prompt is too long" },
      }),
    }]);

    const provider = new AnthropicProvider(
      {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api-test",
        model: "claude-sonnet-4-5",
      },
      mockFetch,
    );

    try {
      await provider.chat([{ role: "user", content: "Hi" }], []);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(400);
      expect((err as ProviderError).contextLengthExceeded).toBe(true);
    }
  });
});
