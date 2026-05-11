import { describe, expect, it, afterEach } from "vitest";
import { join } from "node:path";
import {
  BaseAdapter,
  type MessageEvent,
  type SendResult,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import { MessageHandler } from "../../src/gateway/handler.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCall,
  makeToolCallResponse,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";
import type { SessionResetPolicy } from "../../src/gateway/session-keys.js";

class MockAdapter extends BaseAdapter {
  sent: Array<{ chatId: string; content: string }> = [];
  clarificationIds: string[] = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(chatId: string, content: string): Promise<SendResult> {
    this.sent.push({ chatId, content });
    return { success: true, messageId: `mock-${this.sent.length}` };
  }
  override async sendClarification(
    chatId: string,
    request: Parameters<BaseAdapter["sendClarification"]>[1],
  ): Promise<SendResult> {
    if (request.id) this.clarificationIds.push(request.id);
    return super.sendClarification(chatId, request);
  }
  async sendTyping(_chatId: string): Promise<void> {}
}

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

function makeSource(overrides?: Partial<SessionSource>): SessionSource {
  return {
    platform: "slack",
    chatId: "C123",
    userId: "U123",
    chatType: "channel",
    ...overrides,
  };
}

function makeEvent(text: string, overrides?: Partial<SessionSource>): MessageEvent {
  return {
    text,
    messageType: "text",
    source: makeSource(overrides),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

const noResetPolicy: SessionResetPolicy = {
  mode: "none",
  idleMinutes: 1440,
  dailyResetHour: 4,
};

describe("gateway clarify flow", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort */ }
    }
    cleanups.length = 0;
  });

  function setupStore(): SessionStore {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());
    return store;
  }

  it("sends a clarification prompt and resumes the same tool call with the user's answer", async () => {
    const store = setupStore();
    const capturedBodies: string[] = [];
    const clarifyCall = makeToolCall(
      "clarify",
      {
        question: "Which environment?",
        options: [
          {
            value: "dev",
            label: "Development",
            description: "Use dev.",
          },
          {
            value: "staging",
            label: "Staging",
            description: "Use staging.",
          },
        ],
        default: "dev",
        reason: "The deployment target is missing.",
      },
      "call_clarify",
    );
    const baseFetch = createMockFetch([
      { body: makeToolCallResponse([clarifyCall]) },
      { body: makeTextResponse("I will use staging.") },
    ]);
    const capturingFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") capturedBodies.push(init.body);
      return baseFetch(input, init);
    };

    const handler = new MessageHandler({
      provider: makeProvider(capturingFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });
    const adapter = new MockAdapter();

    const initialHandle = handler.handle(makeEvent("Deploy it"), adapter);
    await waitFor(() => adapter.sent.length === 1);

    expect(adapter.sent[0].content).toContain("Which environment?");
    expect(adapter.sent[0].content).toContain("1. Development");

    await handler.handle(makeEvent("2"), adapter);
    await initialHandle;

    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[1].content).toBe("I will use staging.");
    expect(capturedBodies).toHaveLength(2);

    const secondRequest = JSON.parse(capturedBodies[1]);
    const toolMessage = secondRequest.messages.find(
      (m: { role: string; tool_call_id?: string }) =>
        m.role === "tool" && m.tool_call_id === "call_clarify",
    );
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      success: true,
      answer: "staging",
      selectedOption: {
        value: "staging",
        label: "Staging",
      },
    });
  });

  it("times out abandoned clarifications and resumes with the default answer", async () => {
    const store = setupStore();
    const capturedBodies: string[] = [];
    const clarifyCall = makeToolCall(
      "clarify",
      {
        question: "Which environment?",
        options: [
          { value: "dev", label: "Development" },
          { value: "staging", label: "Staging" },
        ],
        default: "dev",
      },
      "call_clarify_timeout",
    );
    const baseFetch = createMockFetch([
      { body: makeToolCallResponse([clarifyCall]) },
      { body: makeTextResponse("I will use the default.") },
    ]);
    const capturingFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") capturedBodies.push(init.body);
      return baseFetch(input, init);
    };

    const handler = new MessageHandler({
      provider: makeProvider(capturingFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      clarifyTimeoutMs: 10,
    });
    const adapter = new MockAdapter();

    await handler.handle(makeEvent("Deploy it"), adapter);

    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[1].content).toBe("I will use the default.");
    const secondRequest = JSON.parse(capturedBodies[1]);
    const toolMessage = secondRequest.messages.find(
      (m: { role: string; tool_call_id?: string }) =>
        m.role === "tool" && m.tool_call_id === "call_clarify_timeout",
    );
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      success: true,
      answer: "dev",
      timedOut: true,
    });
  });

  it("ignores stale button clarification replies after the pending question is already answered", async () => {
    const store = setupStore();
    const clarifyCall = makeToolCall(
      "clarify",
      {
        question: "Which environment?",
        options: [
          { value: "dev", label: "Development" },
          { value: "staging", label: "Staging" },
        ],
      },
      "call_clarify_stale",
    );
    const mockFetch = createMockFetch([
      { body: makeToolCallResponse([clarifyCall]) },
      { body: makeTextResponse("I will use staging.") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });
    const adapter = new MockAdapter();

    const initialHandle = handler.handle(makeEvent("Deploy it"), adapter);
    await waitFor(() => adapter.sent.length === 1);

    const clarificationId = adapter.clarificationIds[0];
    expect(clarificationId).toBeTruthy();

    await handler.handle(makeEvent("2"), adapter);
    await initialHandle;
    expect(adapter.sent).toHaveLength(2);

    await handler.handle({
      text: "staging",
      messageType: "text",
      source: makeSource(),
      metadata: {
        clarificationId,
      },
    }, adapter);

    expect(adapter.sent).toHaveLength(2);
    expect((mockFetch as any).calls).toHaveLength(2);
  });
});
