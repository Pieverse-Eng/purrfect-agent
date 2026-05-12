import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import { MessageHandler } from "../../src/gateway/handler.js";
import { PairingStore } from "../../src/gateway/acl.js";
import { GatewayRunner } from "../../src/gateway/runner.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import {
  createMockFetch,
  makeTextResponse,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";
import type { SessionResetPolicy } from "../../src/gateway/session-keys.js";

// ---------------------------------------------------------------------------
// Mock Adapter
// ---------------------------------------------------------------------------

class MockAdapter extends BaseAdapter {
  connected = false;
  disconnected = false;
  sent: Array<{ chatId: string; content: string }> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  async send(chatId: string, content: string): Promise<SendResult> {
    this.sent.push({ chatId, content });
    return { success: true, messageId: `mock-${this.sent.length}` };
  }
  async sendTyping(_chatId: string): Promise<void> {}

  /** Simulate an inbound message. */
  simulateInbound(event: MessageEvent): void {
    this.emitMessage(event);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

function makeSource(overrides?: Partial<SessionSource>): SessionSource {
  return {
    platform: "telegram",
    chatId: "chat-1",
    userId: "user-1",
    chatType: "dm",
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

const noResetPolicy: SessionResetPolicy = {
  mode: "none",
  idleMinutes: 1440,
  dailyResetHour: 4,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageHandler + GatewayRunner", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort */ }
    }
    cleanups.length = 0;
  });

  function setupStore(): { store: SessionStore; dbPath: string } {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const dbPath = join(tmp.path, "sessions.db");
    const store = new SessionStore(dbPath);
    cleanups.push(() => store.close());
    return { store, dbPath };
  }

  // ── 1. Inbound text → agent runs → response sent ─────────────────────

  it("1. inbound text message triggers agent and sends response via adapter", async () => {
    const { store } = setupStore();
    const mockFetch = createMockFetch([
      { body: makeTextResponse("Hello from the agent!") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });

    const adapter = new MockAdapter();
    const event = makeEvent("Hi there");

    await handler.handle(event, adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].chatId).toBe("chat-1");
    // ! is escaped for Telegram MarkdownV2
    expect(adapter.sent[0].content).toBe("Hello from the agent\\!");
  });

  // ── 2. Session created on first message and reused on second ──────────

  it("2. session created on first message and reused on second", async () => {
    const { store } = setupStore();

    // Two responses — one per handle() call
    const mockFetch = createMockFetch([
      { body: makeTextResponse("First reply") },
      { body: makeTextResponse("Second reply") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });

    const adapter = new MockAdapter();
    const event1 = makeEvent("Message one");
    const event2 = makeEvent("Message two");

    await handler.handle(event1, adapter);

    // Capture the session key and sessionId
    const key = "telegram:dm:chat-1:user-1";
    const session1 = handler.getSession(key);
    expect(session1).toBeDefined();
    const sessionId = session1!.sessionId;

    await handler.handle(event2, adapter);

    // Same session should be reused
    const session2 = handler.getSession(key);
    expect(session2).toBeDefined();
    expect(session2!.sessionId).toBe(sessionId);

    // Both messages were sent
    expect(adapter.sent).toHaveLength(2);

    // Session store should have messages from both interactions
    const messages = store.getMessages(sessionId);
    // At least 4 messages: user1, assistant1, user2, assistant2
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });

  // ── 3. Session context includes platform/chatType ─────────────────────

  it("3. session context includes platform and chatType", async () => {
    const { store } = setupStore();

    // Capture the messages sent to the provider
    const capturedBodies: string[] = [];
    const baseMockFetch = createMockFetch([
      { body: makeTextResponse("OK") },
    ]);
    const capturingFetch: typeof fetch = async (input, init) => {
      if (init?.body) {
        capturedBodies.push(init.body as string);
      }
      return baseMockFetch(input, init);
    };

    const handler = new MessageHandler({
      provider: makeProvider(capturingFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });

    const adapter = new MockAdapter();
    const event = makeEvent("Hello", { platform: "discord", chatType: "group" });

    await handler.handle(event, adapter);

    // Verify the system prompt contains platform and chatType
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const requestBody = JSON.parse(capturedBodies[0]);
    const systemMessage = requestBody.messages.find(
      (m: { role: string }) => m.role === "system",
    );
    expect(systemMessage).toBeDefined();
    expect(systemMessage.content).toContain("Connected via discord in group");
  });

  // ── 4. Session reset after idle ───────────────────────────────────────

  it("4. session resets after idle timeout", async () => {
    const { store } = setupStore();

    const mockFetch = createMockFetch([
      { body: makeTextResponse("First") },
      { body: makeTextResponse("After reset") },
    ]);

    const idlePolicy: SessionResetPolicy = {
      mode: "idle",
      idleMinutes: 30,
      dailyResetHour: 4,
    };

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: idlePolicy,
    });

    const adapter = new MockAdapter();
    const event = makeEvent("First message");

    await handler.handle(event, adapter);

    const key = "telegram:dm:chat-1:user-1";
    const firstSessionId = handler.getSession(key)!.sessionId;

    // Simulate idle by setting lastActivity to 31 minutes ago
    const liveSession = handler.getSession(key)!;
    liveSession.lastActivity = Date.now() - 31 * 60 * 1000;

    await handler.handle(makeEvent("After idle"), adapter);

    // A new session should have been created
    const secondSessionId = handler.getSession(key)!.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);

    expect(adapter.sent).toHaveLength(2);
  });

  // ── 5. Agent error → error message sent ───────────────────────────────

  it("5. agent error results in error message sent to adapter", async () => {
    const { store } = setupStore();

    // Mock fetch that returns a server error
    const mockFetch = createMockFetch([
      {
        status: 500,
        body: JSON.stringify({ error: { message: "Internal server error" } }),
      },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });

    const adapter = new MockAdapter();
    const event = makeEvent("Trigger error");

    await handler.handle(event, adapter);

    // Should have sent an error message
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toContain("Error:");
  });

  // ── 6. Photo message → media downloaded → local path appended ────────

  it("6. photo message downloads media and appends local path to agent input", async () => {
    const { store } = setupStore();

    const capturedBodies: string[] = [];

    // Mock globalThis.fetch for both media downloads and agent API calls
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

      // Image download
      if (url === "https://example.com/photo.png") {
        const fakeBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        return new Response(fakeBody, { status: 200 });
      }

      // Agent API
      if (init?.body) {
        capturedBodies.push(init.body as string);
      }
      return new Response(
        JSON.stringify(makeTextResponse("Got your photo!")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    cleanups.push(() => fetchSpy.mockRestore());

    const handler = new MessageHandler({
      provider: makeProvider(globalThis.fetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      mediaCacheDir: join(tmp.path, "media"),
    });

    const adapter = new MockAdapter();
    const event: MessageEvent = {
      text: "Check this out",
      messageType: "photo",
      source: makeSource(),
      mediaUrls: ["https://example.com/photo.png"],
    };

    await handler.handle(event, adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Got your photo\\!");

    // Verify the agent received the photo path in the input
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const requestBody = JSON.parse(capturedBodies[0]);
    const userMessage = requestBody.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain("[Attached images:");
    expect(userMessage.content).toContain(".png");
    expect(userMessage.content).toContain("Check this out");
  });

  // ── 7. Voice message → transcription used as agent input ────────────

  it("7. voice message downloads audio and uses transcribed text as agent input", async () => {
    const { store } = setupStore();

    const capturedBodies: string[] = [];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

      // Audio download
      if (url === "https://example.com/voice.ogg") {
        return new Response(new Uint8Array([0x00, 0x01]), { status: 200 });
      }

      // Whisper transcription endpoint
      if (url === "https://api.openai.com/v1/audio/transcriptions") {
        return new Response(
          JSON.stringify({ text: "Hello from voice" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Agent API
      if (init?.body) {
        capturedBodies.push(init.body as string);
      }
      return new Response(
        JSON.stringify(makeTextResponse("Voice understood!")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    cleanups.push(() => fetchSpy.mockRestore());

    const handler = new MessageHandler({
      provider: makeProvider(globalThis.fetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      mediaCacheDir: join(tmp.path, "media"),
      whisperApiKey: "sk-test-whisper",
    });

    const adapter = new MockAdapter();
    const event: MessageEvent = {
      text: "",
      messageType: "voice",
      source: makeSource(),
      mediaUrls: ["https://example.com/voice.ogg"],
    };

    await handler.handle(event, adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("Voice understood\\!");

    // Verify the agent received transcribed text
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const requestBody = JSON.parse(capturedBodies[0]);
    const userMessage = requestBody.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toContain("Hello from voice");
  });

  // ── 8. Text message unchanged (regression) ──────────────────────────

  it("8. text message passes event.text unchanged to the agent", async () => {
    const { store } = setupStore();

    const capturedBodies: string[] = [];
    const baseMockFetch = createMockFetch([
      { body: makeTextResponse("OK") },
    ]);
    const capturingFetch: typeof fetch = async (input, init) => {
      if (init?.body) {
        capturedBodies.push(init.body as string);
      }
      return baseMockFetch(input, init);
    };

    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const handler = new MessageHandler({
      provider: makeProvider(capturingFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      mediaCacheDir: join(tmp.path, "media"),
    });

    const adapter = new MockAdapter();
    const event = makeEvent("Just plain text");

    await handler.handle(event, adapter);

    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const requestBody = JSON.parse(capturedBodies[0]);
    const userMessage = requestBody.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    expect(userMessage.content).toBe("Just plain text");
  });

  // ── 9. Session metadata (lastActivity) updated ────────────────────────

  it("9. session lastActivity is updated after handling a message", async () => {
    const { store } = setupStore();

    const mockFetch = createMockFetch([
      { body: makeTextResponse("Reply") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
    });

    const adapter = new MockAdapter();
    const before = Date.now();

    await handler.handle(makeEvent("Check metadata"), adapter);

    const key = "telegram:dm:chat-1:user-1";
    const session = handler.getSession(key);
    expect(session).toBeDefined();
    expect(session!.lastActivity).toBeGreaterThanOrEqual(before);
    expect(session!.lastActivity).toBeLessThanOrEqual(Date.now());
  });

  // ── Pairing/ACL integration ──────────────────────────────────────────

  it("pairing: unknown user gets a pairing code prompt and is NOT routed to the agent", async () => {
    const { store } = setupStore();
    // Provider should never be called — assert with a fetch that throws.
    const failingFetch: typeof fetch = async () => {
      throw new Error("provider must not be called when pairing is pending");
    };
    const dir = mkdtempSync(join(tmpdir(), "purrfect-handler-acl-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pairingStore = new PairingStore({
      path: join(dir, "pairing.json"),
      generateCode: () => "ABCDEF",
    });

    const handler = new MessageHandler({
      provider: makeProvider(failingFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      pairingStore,
    });
    const adapter = new MockAdapter();
    await handler.handle(makeEvent("hi"), adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toContain("ABCDEF");
    expect(adapter.sent[0].content).toContain("pairing approve");
  });

  it("pairing: approved user is routed to the agent normally", async () => {
    const { store } = setupStore();
    const dir = mkdtempSync(join(tmpdir(), "purrfect-handler-acl-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pairingStore = new PairingStore({
      path: join(dir, "pairing.json"),
      generateCode: () => "ABCDEF",
    });
    pairingStore.ensurePending("telegram", "user-1");
    pairingStore.approve("ABCDEF");

    const mockFetch = createMockFetch([
      { body: makeTextResponse("welcome back!") },
    ]);
    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      pairingStore,
    });
    const adapter = new MockAdapter();
    await handler.handle(makeEvent("hi"), adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toContain("welcome back");
  });

  it("pairing: revoked user gets a denial without provider invocation", async () => {
    const { store } = setupStore();
    const dir = mkdtempSync(join(tmpdir(), "purrfect-handler-acl-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pairingStore = new PairingStore({
      path: join(dir, "pairing.json"),
      generateCode: () => "ABCDEF",
    });
    pairingStore.ensurePending("telegram", "user-1");
    pairingStore.approve("ABCDEF");
    pairingStore.revoke("telegram", "user-1");

    const failingFetch: typeof fetch = async () => {
      throw new Error("provider must not be called for revoked users");
    };
    const handler = new MessageHandler({
      provider: makeProvider(failingFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      pairingStore,
    });
    const adapter = new MockAdapter();
    await handler.handle(makeEvent("hi"), adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toContain("revoked");
  });
});

// ---------------------------------------------------------------------------
// GatewayRunner tests
// ---------------------------------------------------------------------------

describe("GatewayRunner", () => {
  it("start() connects all adapters, stop() disconnects them", async () => {
    const runner = new GatewayRunner({
      platforms: {},
      sessionPolicy: { mode: "none", idleMinutes: 1440, dailyResetHour: 4 },
      groupSessionsPerUser: true,
    });

    const adapter1 = new MockAdapter();
    const adapter2 = new MockAdapter();
    runner.addAdapter("telegram", adapter1);
    runner.addAdapter("discord", adapter2);

    expect(runner.isRunning).toBe(false);

    await runner.start();
    expect(runner.isRunning).toBe(true);
    expect(adapter1.connected).toBe(true);
    expect(adapter2.connected).toBe(true);

    await runner.stop();
    expect(runner.isRunning).toBe(false);
    expect(adapter1.disconnected).toBe(true);
    expect(adapter2.disconnected).toBe(true);
  });

  it("getAdapter returns registered adapter", () => {
    const runner = new GatewayRunner({
      platforms: {},
      sessionPolicy: { mode: "none", idleMinutes: 1440, dailyResetHour: 4 },
      groupSessionsPerUser: true,
    });

    const adapter = new MockAdapter();
    runner.addAdapter("slack", adapter);
    expect(runner.getAdapter("slack")).toBe(adapter);
    expect(runner.getAdapter("missing")).toBeUndefined();
  });
});
