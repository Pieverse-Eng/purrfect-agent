/**
 * E2E: gateway serving two adapters concurrently.
 *
 * Marketing claim under test: "Purr-Fect runs in your chat apps (Slack,
 * Discord, Telegram, LINE, webhooks)." This proves the same MessageHandler
 * instance can serve two adapters at once without state bleed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";

import {
  BaseAdapter,
  type MessageEvent,
  type SendResult,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import { MessageHandler } from "../../src/gateway/handler.js";
import type { SessionResetPolicy } from "../../src/gateway/session-keys.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

class MockAdapter extends BaseAdapter {
  readonly platform: string;
  readonly sent: Array<{ chatId: string; content: string }> = [];

  constructor(platform: string) {
    super();
    this.platform = platform;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async send(chatId: string, content: string): Promise<SendResult> {
    this.sent.push({ chatId, content });
    return { success: true, messageId: `msg-${this.sent.length}` };
  }

  async sendTyping(): Promise<void> {}
}

function makeProvider(fetchFn: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    fetchFn,
  );
}

function makeEvent(text: string, source: SessionSource): MessageEvent {
  return { text, messageType: "text", source };
}

const policy: SessionResetPolicy = { mode: "none", idleMinutes: 30, dailyResetHour: 4 };

describe("Integration: multi-adapter gateway", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups) try { fn(); } catch { /* best effort */ }
    cleanups.length = 0;
  });

  it("Telegram + LINE inbound events concurrently → both adapters get their replies, sessions stay isolated", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    // Two mock responses queued — first served wins regardless of order, so
    // we use the same text for both to keep the assertion order-agnostic.
    const mockFetch = createMockFetch([
      { body: makeTextResponse("agent reply") },
      { body: makeTextResponse("agent reply") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: policy,
    });

    const telegram = new MockAdapter("telegram");
    const line = new MockAdapter("line");

    const teleEvent = makeEvent("hi from telegram", {
      platform: "telegram",
      chatId: "tg-chat-1",
      userId: "tg-user-1",
      chatType: "dm",
    });
    const lineEvent = makeEvent("hi from line", {
      platform: "line",
      chatId: "line-chat-1",
      userId: "line-user-1",
      chatType: "dm",
    });

    await Promise.all([
      handler.handle(teleEvent, telegram),
      handler.handle(lineEvent, line),
    ]);

    // Each adapter got exactly one reply, routed back to its own chatId.
    expect(telegram.sent).toHaveLength(1);
    expect(line.sent).toHaveLength(1);
    expect(telegram.sent[0].chatId).toBe("tg-chat-1");
    expect(line.sent[0].chatId).toBe("line-chat-1");
    expect(telegram.sent[0].content).toContain("agent reply");
    expect(line.sent[0].content).toContain("agent reply");

    // Two distinct sessions exist, one per platform/chat tuple.
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("reply to platform A never lands on platform B (no cross-talk)", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    // Plain alphanumeric payloads so Telegram MarkdownV2 escaping is a no-op
    // (Telegram escapes _ * - . etc.; alpha-only strings round-trip cleanly).
    const mockFetch = createMockFetch([
      { body: makeTextResponse("alphaReplyPayload") },
      { body: makeTextResponse("bravoReplyPayload") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: policy,
    });

    const telegram = new MockAdapter("telegram");
    const line = new MockAdapter("line");

    await handler.handle(
      makeEvent("tg msg", {
        platform: "telegram",
        chatId: "tg-1",
        userId: "u",
        chatType: "dm",
      }),
      telegram,
    );
    await handler.handle(
      makeEvent("line msg", {
        platform: "line",
        chatId: "line-1",
        userId: "u",
        chatType: "dm",
      }),
      line,
    );

    expect(telegram.sent.some((m) => m.content.includes("bravoReplyPayload"))).toBe(false);
    expect(line.sent.some((m) => m.content.includes("alphaReplyPayload"))).toBe(false);
    expect(telegram.sent[0].content).toContain("alphaReplyPayload");
    expect(line.sent[0].content).toContain("bravoReplyPayload");
  });

  it("same userId on different platforms = independent sessions (no identity leak)", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const store = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => store.close());

    const mockFetch = createMockFetch([
      { body: makeTextResponse("reply A") },
      { body: makeTextResponse("reply B") },
    ]);

    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      sessionPolicy: policy,
    });

    const tele = new MockAdapter("telegram");
    const slack = new MockAdapter("slack");

    // Same external userId across platforms — should still split sessions.
    const sameUser = "alice";
    await handler.handle(
      makeEvent("hi tg", {
        platform: "telegram",
        chatId: "tg-x",
        userId: sameUser,
        chatType: "dm",
      }),
      tele,
    );
    await handler.handle(
      makeEvent("hi slack", {
        platform: "slack",
        chatId: "slack-x",
        userId: sameUser,
        chatType: "dm",
      }),
      slack,
    );

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
  });
});
