import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import { MessageHandler, type AccessControl } from "../../src/gateway/handler.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import {
  createMockFetch,
  makeTextResponse,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";
import { formatForPlatform } from "../../src/gateway/format.js";
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

describe("Gateway access control", () => {
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

  it("allowed user message is processed", async () => {
    const { store } = setupStore();
    const mockFetch = createMockFetch([
      { body: makeTextResponse("Hello!") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      accessControl: {
        telegram: { allowedUsers: ["user-1"], allowedChats: [] },
      },
    });

    const adapter = new MockAdapter();
    await handler.handle(makeEvent("Hi"), adapter);

    expect(adapter.sent).toHaveLength(1);
    // Response is formatted for telegram (! is escaped in MarkdownV2)
    expect(adapter.sent[0].content).toBe("Hello\\!");
  });

  it("unknown user is rejected with access message", async () => {
    const { store } = setupStore();
    const mockFetch = createMockFetch([
      { body: makeTextResponse("Should not reach") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: noResetPolicy,
      accessControl: {
        telegram: { allowedUsers: ["admin-only"], allowedChats: [] },
      },
    });

    const adapter = new MockAdapter();
    await handler.handle(makeEvent("Hi", { userId: "stranger-99" }), adapter);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].content).toBe("You don't have access to this agent.");
  });

  it("formatForPlatform escapes Telegram MarkdownV2 characters", () => {
    const raw = "Hello _world_ *bold* [link](http://a.com) ~strike~";
    const escaped = formatForPlatform(raw, "telegram");

    // Every special character should be preceded by backslash
    expect(escaped).toContain("\\_world\\_");
    expect(escaped).toContain("\\*bold\\*");
    expect(escaped).toContain("\\[link\\]");
    expect(escaped).toContain("\\~strike\\~");
    expect(escaped).toContain("\\(http://a\\.com\\)");
  });

  it("formatForPlatform returns text unchanged for non-telegram platforms", () => {
    const raw = "Hello _world_ *bold*";
    expect(formatForPlatform(raw, "discord")).toBe(raw);
    expect(formatForPlatform(raw, "slack")).toBe(raw);
  });
});
