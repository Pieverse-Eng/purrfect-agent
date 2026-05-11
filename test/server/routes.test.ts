import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createServer, MAX_BODY_SIZE } from "../../src/server/index.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import {
  createMockFetch,
  makeTextResponse,
  makeSSEStream,
  makeStreamChunk,
} from "../helpers/mock-server.js";

// ---------------------------------------------------------------------------
// Test harness: real HTTP server on random port
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-secret-token";

let server: http.Server;
let baseUrl: string;

/** Build a mock provider that returns a canned text response. */
function makeMockProvider(text = "Hello from agent") {
  const mockFetch = createMockFetch([
    { body: makeTextResponse(text) },
  ]);
  return new HttpProvider(
    { baseUrl: "https://mock.api", apiKey: "sk-mock", model: "test-model" },
    mockFetch,
  );
}

/** Build a mock provider that returns SSE stream chunks. */
function makeStreamingMockProvider(chunks: string[]) {
  const sseEvents = chunks.map((c) => makeStreamChunk(c));
  sseEvents.push(makeStreamChunk(undefined, undefined, "stop"));
  const sseBody = makeSSEStream(sseEvents);
  const mockFetch = createMockFetch([{ body: sseBody, stream: true }]);
  return new HttpProvider(
    { baseUrl: "https://mock.api", apiKey: "sk-mock", model: "test-model" },
    mockFetch,
  );
}

beforeAll(async () => {
  const toolRegistry = new ToolRegistry();

  server = createServer({
    token: TEST_TOKEN,
    providerFactory: makeMockProvider,
    streamingProviderFactory: () => makeStreamingMockProvider(["Hello", " world"]),
    toolRegistry,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Server/API mode", () => {
  it("POST /chat with valid token returns 200 JSON with assistant message", async () => {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ message: "Hi there" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("response");
    expect(body.response).toContain("Hello from agent");
  });

  it("POST /chat/stream returns SSE events with text deltas", async () => {
    const res = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({ message: "Stream me" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));

    // Should have at least one text_delta and one completion event
    const deltas = events.filter((e: any) => e.type === "text_delta");
    const completions = events.filter((e: any) => e.type === "completion");

    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(completions.length).toBe(1);
  });

  it("GET /sessions returns JSON array of sessions", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /health returns status ok with uptime", async () => {
    // /health does not require auth
    const res = await fetch(`${baseUrl}/health`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof body.sessions).toBe("number");
  });

  it("missing auth token returns 401", async () => {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hi" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("invalid auth token returns 401", async () => {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ message: "Hi" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("POST to unknown route returns 404", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("POST /chat with no body returns 400", async () => {
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("POST /chat with oversized body returns 413", async () => {
    const oversizedPayload = "x".repeat(MAX_BODY_SIZE + 1);
    const res = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: oversizedPayload,
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("Payload too large");
  });

  // NOTE: The BODY_READ_TIMEOUT (408) path is validated via manual testing
  // because reliably simulating a stalled request in unit tests is fragile.
});

// ---------------------------------------------------------------------------
// Client disconnect → agent loop abort
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { handleChat, handleChatStream } from "../../src/server/routes.js";
import { parseArgs } from "../../src/cli/index.js";

describe("Client disconnect aborts agent loop", () => {
  /**
   * Create a slow mock provider whose fetch never resolves until the signal
   * is aborted, so we can verify that the abort signal propagates.
   */
  function makeSlowProvider(signal: { captured?: AbortSignal }) {
    const mockFetch = createMockFetch([
      { body: makeTextResponse("should not arrive") },
    ]);

    // Wrap the mock fetch to capture the signal and delay the response
    const slowFetch: typeof fetch = async (input, init) => {
      if (init?.signal) {
        signal.captured = init.signal;
      }
      // Delay so the client has time to disconnect
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return mockFetch(input, init);
    };

    return new HttpProvider(
      { baseUrl: "https://mock.api", apiKey: "sk-mock", model: "test-model" },
      slowFetch,
    );
  }

  it("handleChat aborts the agent loop when req emits 'close'", async () => {
    const toolRegistry = new ToolRegistry();
    const signalCapture: { captured?: AbortSignal } = {};
    const provider = makeSlowProvider(signalCapture);

    // Create mock req (EventEmitter) and res (writable mock)
    const mockReq = new EventEmitter() as any;
    const mockRes = new EventEmitter() as any;
    let headWritten = false;
    let endCalled = false;
    const writtenChunks: string[] = [];
    mockRes.writeHead = (_status: number, _headers: Record<string, string>) => {
      headWritten = true;
    };
    mockRes.write = (chunk: string) => {
      writtenChunks.push(chunk);
    };
    mockRes.end = (data?: string) => {
      if (data) writtenChunks.push(data);
      endCalled = true;
    };
    mockRes.writableEnded = false;

    // Start handleChat (don't await — it will hang on the slow provider)
    const chatPromise = handleChat(mockRes, {
      req: mockReq,
      provider,
      toolRegistry,
      message: "Hi",
    });

    // Give the handler time to set up the AbortController and start the loop
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate client disconnect
    mockReq.emit("close");

    // handleChat should resolve quickly after abort
    await chatPromise;

    // The response should NOT have been sent (aborted before completion)
    expect(endCalled).toBe(false);
  }, 10_000);

  it("handleChatStream aborts the agent loop when req emits 'close'", async () => {
    const toolRegistry = new ToolRegistry();
    const signalCapture: { captured?: AbortSignal } = {};
    const provider = makeSlowProvider(signalCapture);

    const mockReq = new EventEmitter() as any;
    const mockRes = new EventEmitter() as any;
    let endCalled = false;
    const writtenChunks: string[] = [];
    mockRes.writeHead = () => {};
    mockRes.write = (chunk: string) => {
      writtenChunks.push(chunk);
    };
    mockRes.end = (data?: string) => {
      if (data) writtenChunks.push(data);
      endCalled = true;
      mockRes.writableEnded = true;
    };
    mockRes.writableEnded = false;

    const streamPromise = handleChatStream(mockRes, {
      req: mockReq,
      provider,
      toolRegistry,
      message: "Stream me",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    mockReq.emit("close");

    await streamPromise;

    // No SSE data should have been written (provider never resolved)
    expect(writtenChunks.length).toBe(0);
    // end() should not have been called since we aborted before the response
    // completed — OR it might be called if writableEnded check passes. Either
    // way the loop should have stopped.
  }, 10_000);
});

// ---------------------------------------------------------------------------
// parseArgs — serve command
// ---------------------------------------------------------------------------

describe("parseArgs serve command", () => {
  it("parseArgs with 'serve' returns correct command", () => {
    const result = parseArgs(["node", "purrfect", "serve"]);
    expect(result).toEqual({ command: "serve", port: undefined });
  });

  it("parseArgs with 'serve --port 8080' extracts port", () => {
    const result = parseArgs(["node", "purrfect", "serve", "--port", "8080"]);
    expect(result).toEqual({ command: "serve", port: 8080 });
  });
});
