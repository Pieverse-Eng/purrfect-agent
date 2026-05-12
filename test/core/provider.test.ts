import { describe, it, expect, vi } from "vitest";
import { HttpProvider } from "../../src/core/provider.js";
import { RetryPolicy } from "../../src/core/retry.js";
import {
  AuthError,
  RateLimitError,
  NetworkError,
  ProviderError,
} from "../../src/core/errors.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
  makeSSEStream,
  makeStreamChunk,
} from "../helpers/mock-server.js";

describe("HttpProvider: chat()", () => {
  it("sends correct request shape and returns parsed response", async () => {
    const mockResponse = makeTextResponse("Hello!");
    const mockFetch = createMockFetch([{ body: mockResponse }]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4" },
      mockFetch,
    );

    const result = await provider.chat(
      [{ role: "user", content: "Hi" }],
      [],
    );

    expect(result.choices[0].message.content).toBe("Hello!");
    const call = (mockFetch as any).calls[0];
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("gpt-4");
    expect(body.messages[0].role).toBe("user");
  });

  it("returns tool calls in response", async () => {
    const tc = makeToolCall("file_read", { path: "/tmp" });
    const mockResponse = makeToolCallResponse([tc]);
    const mockFetch = createMockFetch([{ body: mockResponse }]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4" },
      mockFetch,
    );

    const result = await provider.chat(
      [{ role: "user", content: "read file" }],
      [],
    );

    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].function.name).toBe("file_read");
  });

  it("normalizes OpenAI cached prompt tokens into cache usage", async () => {
    const mockResponse = {
      ...makeTextResponse("Hello cached!", "gpt-4o"),
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 20,
        total_tokens: 1220,
        prompt_tokens_details: {
          cached_tokens: 1024,
        },
      },
    };
    const mockFetch = createMockFetch([{ body: mockResponse as any }]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4o" },
      mockFetch,
    );

    const result = await provider.chat(
      [{ role: "user", content: "Hi" }],
      [],
    );

    expect(result.usage?.cache_read_input_tokens).toBe(1024);
    expect(result.usage?.cache_creation_input_tokens).toBe(0);
  });

  it("throws AuthError on 401", async () => {
    const mockFetch = createMockFetch([
      { status: 401, body: '{"error":{"message":"invalid key"}}' },
    ]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "bad-key", model: "gpt-4" },
      mockFetch,
    );

    await expect(
      provider.chat([{ role: "user", content: "Hi" }], []),
    ).rejects.toThrow(AuthError);
  });

  it("throws RateLimitError on 429 with retry-after", async () => {
    const mockFetch = createMockFetch([
      {
        status: 429,
        body: '{"error":{"message":"rate limited"}}',
        headers: { "retry-after": "30" },
      },
    ]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4" },
      mockFetch,
    );

    try {
      await provider.chat([{ role: "user", content: "Hi" }], []);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(30);
    }
  });

  it("throws ProviderError with contextLengthExceeded on 413", async () => {
    const mockFetch = createMockFetch([
      {
        status: 413,
        body: '{"error":{"message":"context length exceeded","code":"context_length_exceeded"}}',
      },
    ]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4" },
      mockFetch,
    );

    try {
      await provider.chat([{ role: "user", content: "Hi" }], []);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).contextLengthExceeded).toBe(true);
    }
  });

  it("throws NetworkError on fetch failure", async () => {
    const mockFetch = async () => {
      throw new TypeError("Failed to fetch");
    };

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4" },
      mockFetch as typeof fetch,
    );

    await expect(
      provider.chat([{ role: "user", content: "Hi" }], []),
    ).rejects.toThrow(NetworkError);
  });
});

describe("HttpProvider: chatStream()", () => {
  it("yields text deltas from SSE stream", async () => {
    const sse = makeSSEStream([
      makeStreamChunk("Hello"),
      makeStreamChunk(" world"),
      makeStreamChunk(undefined, undefined, "stop"),
    ]);
    const mockFetch = createMockFetch([{ body: sse, stream: true }]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4" },
      mockFetch,
    );

    const deltas = [];
    for await (const delta of provider.chatStream(
      [{ role: "user", content: "Hi" }],
      [],
    )) {
      deltas.push(delta);
    }

    const textDeltas = deltas.filter((d) => d.type === "text");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0].content).toBe("Hello");
    expect(textDeltas[1].content).toBe(" world");
  });

  it("retries once without stream_options when a compatible endpoint rejects it", async () => {
    const sse = makeSSEStream([
      makeStreamChunk("fallback ok"),
      makeStreamChunk(undefined, undefined, "stop"),
    ]);
    const mockFetch = createMockFetch([
      {
        status: 400,
        body: '{"error":{"message":"Unknown parameter: stream_options"}}',
      },
      { body: sse, stream: true },
    ]);

    const provider = new HttpProvider(
      { baseUrl: "https://api.compat.example/v1", apiKey: "sk-test", model: "gpt-4o-compatible" },
      mockFetch,
    );

    const deltas = [];
    for await (const delta of provider.chatStream(
      [{ role: "user", content: "Hi" }],
      [],
    )) {
      deltas.push(delta);
    }

    expect(deltas.find((d) => d.type === "text")?.content).toBe("fallback ok");
    const firstBody = JSON.parse((mockFetch as any).calls[0].init.body as string);
    const secondBody = JSON.parse((mockFetch as any).calls[1].init.body as string);
    expect(firstBody.stream_options).toEqual({ include_usage: true });
    expect(secondBody.stream_options).toBeUndefined();
  });
});

describe("RetryPolicy", () => {
  it("retries on 429 with exponential backoff", async () => {
    let attempts = 0;
    const policy = new RetryPolicy({ maxRetries: 3, baseDelay: 1 });

    const result = await policy.execute(async () => {
      attempts++;
      if (attempts < 3) {
        throw new RateLimitError("rate limited");
      }
      return "success";
    });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("throws after max retries exceeded", async () => {
    const policy = new RetryPolicy({ maxRetries: 2, baseDelay: 1 });

    await expect(
      policy.execute(async () => {
        throw new RateLimitError("rate limited");
      }),
    ).rejects.toThrow(RateLimitError);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    const policy = new RetryPolicy({ maxRetries: 3, baseDelay: 1 });

    await expect(
      policy.execute(async () => {
        attempts++;
        throw new AuthError("bad key");
      }),
    ).rejects.toThrow(AuthError);

    expect(attempts).toBe(1);
  });
});
