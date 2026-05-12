/**
 * Mock server infrastructure for testing Provider and AgentLoop.
 * Ported from hermes-agent/tests/test_agent_loop.py MockServer pattern.
 * Uses fetch mocking instead of real HTTP server for speed and reliability.
 */

import type { Message, ToolCall } from "../../src/core/types.js";

export interface MockChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "tool_calls" | "length";
}

export interface MockChatCompletion {
  id: string;
  object: "chat.completion";
  model: string;
  choices: MockChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function makeTextResponse(
  content: string,
  model = "test-model",
): MockChatCompletion {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, tool_calls: undefined },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function makeToolCallResponse(
  toolCalls: ToolCall[],
  model = "test-model",
): MockChatCompletion {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCalls },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function makeToolCall(
  name: string,
  args: Record<string, unknown>,
  id?: string,
): ToolCall {
  return {
    id: id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Create SSE-formatted text from a series of data events.
 * Mirrors OpenAI's streaming response format.
 */
export function makeSSEStream(events: Array<Record<string, unknown>>): string {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}`);
  lines.push("data: [DONE]");
  return lines.join("\n\n") + "\n\n";
}

export function makeStreamChunk(
  content?: string,
  toolCalls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
  finishReason?: string,
  model = "test-model",
): Record<string, unknown> {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(content !== undefined ? { content } : {}),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason ?? null,
      },
    ],
  };
}

/**
 * Create a mock fetch function that returns predefined responses.
 * Responses are consumed in order (FIFO queue).
 */
export function createMockFetch(
  responses: Array<{
    status?: number;
    body?: string | MockChatCompletion;
    headers?: Record<string, string>;
    stream?: boolean;
  }>,
): typeof fetch {
  let callIndex = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });

    const responseConfig = responses[callIndex++];
    if (!responseConfig) {
      throw new Error(`Mock fetch: no response configured for call ${callIndex}`);
    }

    const status = responseConfig.status ?? 200;
    const headers = new Headers(responseConfig.headers ?? {});

    if (responseConfig.stream) {
      headers.set("content-type", "text/event-stream");
      const body = typeof responseConfig.body === "string"
        ? responseConfig.body
        : JSON.stringify(responseConfig.body);
      return new Response(body, { status, headers });
    }

    headers.set("content-type", "application/json");
    const body = typeof responseConfig.body === "string"
      ? responseConfig.body
      : JSON.stringify(responseConfig.body);
    return new Response(body, { status, headers });
  };

  (mockFetch as any).calls = calls;
  return mockFetch as typeof fetch;
}
