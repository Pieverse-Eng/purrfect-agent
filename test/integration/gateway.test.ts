/**
 * v5 Unit 12 — Gateway Integration Tests
 *
 * Wires REAL gateway subsystems (MessageHandler, SessionStore, DeliveryRouter,
 * MediaCache) with mocked platform adapters and mocked HTTP provider.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { BaseAdapter, type MessageEvent, type SendResult, type SessionSource } from "../../src/gateway/adapter.js";
import { MessageHandler } from "../../src/gateway/handler.js";
import { buildSessionKey, type SessionResetPolicy } from "../../src/gateway/session-keys.js";
import { DeliveryRouter } from "../../src/gateway/delivery.js";
import { MediaCache } from "../../src/gateway/media.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Mock Adapter — concrete implementation of BaseAdapter for testing
// ---------------------------------------------------------------------------

class MockAdapter extends BaseAdapter {
  readonly platform: string;
  readonly sent: Array<{ chatId: string; content: string }> = [];

  constructor(platform = "test") {
    super();
    this.platform = platform;
  }

  async connect(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async send(chatId: string, content: string): Promise<SendResult> {
    this.sent.push({ chatId, content });
    return { success: true, messageId: `msg-${this.sent.length}` };
  }

  async sendTyping(_chatId: string): Promise<void> {
    // no-op
  }

  /** Expose emitMessage so tests can inject inbound events. */
  emit(event: MessageEvent): void {
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

function makeSource(overrides: Partial<SessionSource> = {}): SessionSource {
  return {
    platform: "telegram",
    chatId: "chat-100",
    userId: "user-1",
    chatType: "dm",
    ...overrides,
  };
}

function makeEvent(text: string, sourceOverrides: Partial<SessionSource> = {}): MessageEvent {
  return {
    text,
    messageType: "text",
    source: makeSource(sourceOverrides),
  };
}

const idlePolicy: SessionResetPolicy = { mode: "idle", idleMinutes: 30, dailyResetHour: 4 };
const nonePolicy: SessionResetPolicy = { mode: "none", idleMinutes: 30, dailyResetHour: 4 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: gateway", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort */ }
    }
    cleanups.length = 0;
  });

  // 1. Inbound message -> session -> agent -> response
  it("inbound message flows through handler to adapter.send()", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    const mockFetch = createMockFetch([
      { body: makeTextResponse("Hello from the agent!") },
    ]);
    const provider = makeProvider(mockFetch);

    const handler = new MessageHandler({
      provider,
      sessionStore: store,
      sessionPolicy: nonePolicy,
    });

    const adapter = new MockAdapter("telegram");
    const event = makeEvent("Hi there");

    await handler.handle(event, adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].chatId).toBe("chat-100");
    expect(adapter.sent[0].content).toBe("Hello from the agent\\!");
  });

  // 2. Two messages same user -> same session (4+ messages in store)
  it("two messages from same user share one session with 4+ stored messages", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    const mockFetch = createMockFetch([
      { body: makeTextResponse("Reply 1") },
      { body: makeTextResponse("Reply 2") },
    ]);
    const provider = makeProvider(mockFetch);

    const handler = new MessageHandler({
      provider,
      sessionStore: store,
      sessionPolicy: nonePolicy,
    });

    const adapter = new MockAdapter("telegram");
    const event1 = makeEvent("First message");
    const event2 = makeEvent("Second message");

    await handler.handle(event1, adapter);
    await handler.handle(event2, adapter);

    // Should only have one session
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);

    // Should have at least 4 messages: 2 user + 2 assistant
    const messages = store.getMessages(sessions[0].id);
    expect(messages.length).toBeGreaterThanOrEqual(4);

    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    expect(userMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(2);
  });

  // 3. Different users in group -> separate sessions
  it("different users in same group chat get separate session keys", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    const mockFetch = createMockFetch([
      { body: makeTextResponse("Reply to user A") },
      { body: makeTextResponse("Reply to user B") },
    ]);
    const provider = makeProvider(mockFetch);

    const handler = new MessageHandler({
      provider,
      sessionStore: store,
      sessionPolicy: nonePolicy,
      groupSessionsPerUser: true,
    });

    const adapter = new MockAdapter("telegram");

    const eventA = makeEvent("Hello from A", {
      userId: "user-A",
      chatId: "group-1",
      chatType: "group",
    });
    const eventB = makeEvent("Hello from B", {
      userId: "user-B",
      chatId: "group-1",
      chatType: "group",
    });

    await handler.handle(eventA, adapter);
    await handler.handle(eventB, adapter);

    // Two different session keys expected
    const keyA = buildSessionKey(eventA.source, true);
    const keyB = buildSessionKey(eventB.source, true);
    expect(keyA).not.toBe(keyB);

    // Two sessions in the store
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);

    // Both got responses
    expect(adapter.sent).toHaveLength(2);
  });

  // 4. Session idle reset
  it("resets session after idle timeout", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    const mockFetch = createMockFetch([
      { body: makeTextResponse("First reply") },
      { body: makeTextResponse("After reset reply") },
    ]);
    const provider = makeProvider(mockFetch);

    const policy: SessionResetPolicy = { mode: "idle", idleMinutes: 30, dailyResetHour: 4 };

    const handler = new MessageHandler({
      provider,
      sessionStore: store,
      sessionPolicy: policy,
    });

    const adapter = new MockAdapter("telegram");
    const event = makeEvent("Hello");

    // First message creates a session
    await handler.handle(event, adapter);

    const key = buildSessionKey(event.source, true);
    const sessionBefore = handler.getSession(key);
    expect(sessionBefore).toBeDefined();
    const firstSessionId = sessionBefore!.sessionId;

    // Manually set lastActivity to 31 minutes ago to trigger idle reset
    sessionBefore!.lastActivity = Date.now() - 31 * 60 * 1000;

    // Second message should trigger a new session
    await handler.handle(event, adapter);

    const sessionAfter = handler.getSession(key);
    expect(sessionAfter).toBeDefined();
    expect(sessionAfter!.sessionId).not.toBe(firstSessionId);

    // Store should now have two sessions
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
  });

  // 5. Delivery router cross-platform
  it("DeliveryRouter delivers cross-platform via adapter lookup", async () => {
    const telegramAdapter = new MockAdapter("telegram");
    const discordAdapter = new MockAdapter("discord");

    const adapters = new Map<string, BaseAdapter>([
      ["telegram", telegramAdapter],
      ["discord", discordAdapter],
    ]);

    const router = new DeliveryRouter((platform) => adapters.get(platform));

    // Deliver from telegram context to discord:456
    const result = await router.deliver(
      "discord:456",
      "Cross-platform message",
      telegramAdapter,
      "chat-100",
    );

    expect(result.success).toBe(true);
    expect(discordAdapter.sent).toHaveLength(1);
    expect(discordAdapter.sent[0].chatId).toBe("456");
    expect(discordAdapter.sent[0].content).toBe("Cross-platform message");

    // Telegram adapter should NOT have received the message
    expect(telegramAdapter.sent).toHaveLength(0);
  });

  // 6. Media cache download
  it("MediaCache downloads and caches a file to disk", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const cacheDir = join(tmp.path, "media-cache");
    const cache = new MediaCache(cacheDir);

    // Mock global fetch to return image data
    const fakeImageData = Buffer.from("fake-png-image-data");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(fakeImageData, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    cleanups.push(() => {
      globalThis.fetch = originalFetch;
    });

    const filePath = await cache.download("https://example.com/photo.png");

    expect(filePath).not.toBeNull();
    expect(existsSync(filePath!)).toBe(true);

    // Second download of same URL should return cached path (no extra fetch)
    const filePath2 = await cache.download("https://example.com/photo.png");
    expect(filePath2).toBe(filePath);

    // fetch should have been called only once (second call was cached)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
