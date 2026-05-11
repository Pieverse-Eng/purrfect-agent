import { describe, it, expect, vi } from "vitest";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import {
  buildSessionKey,
  shouldResetSession,
  type SessionResetPolicy,
} from "../../src/gateway/session-keys.js";

// ---------------------------------------------------------------------------
// Concrete stub so we can test the abstract BaseAdapter's onMessage wiring
// ---------------------------------------------------------------------------
class StubAdapter extends BaseAdapter {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(_chatId: string, _content: string): Promise<SendResult> {
    return { success: true, messageId: "stub-1" };
  }
  async sendTyping(_chatId: string): Promise<void> {}

  /** Expose a way to simulate an inbound message. */
  simulateInbound(event: MessageEvent): void {
    this.emitMessage(event);
  }
}

// ---------------------------------------------------------------------------
// Session key tests
// ---------------------------------------------------------------------------
describe("buildSessionKey", () => {
  it("DM session key always includes userId", () => {
    const source: SessionSource = {
      platform: "telegram",
      chatId: "chat-42",
      userId: "user-7",
      chatType: "dm",
    };
    const key = buildSessionKey(source);
    expect(key).toBe("telegram:dm:chat-42:user-7");
  });

  it("group key includes userId when groupPerUser is true (default)", () => {
    const source: SessionSource = {
      platform: "discord",
      chatId: "guild-1",
      userId: "user-9",
      chatType: "group",
    };
    const key = buildSessionKey(source); // default groupPerUser = true
    expect(key).toBe("discord:group:guild-1:user-9");
  });

  it("group key omits userId when groupPerUser is false", () => {
    const source: SessionSource = {
      platform: "discord",
      chatId: "guild-1",
      userId: "user-9",
      chatType: "group",
    };
    const key = buildSessionKey(source, false);
    expect(key).toBe("discord:group:guild-1");
  });

  it("includes threadId when present", () => {
    const source: SessionSource = {
      platform: "slack",
      chatId: "C123",
      userId: "U456",
      chatType: "group",
      threadId: "T789",
    };
    const key = buildSessionKey(source, true);
    expect(key).toBe("slack:group:C123:T789:U456");
  });
});

// ---------------------------------------------------------------------------
// Session reset policy tests
// ---------------------------------------------------------------------------
describe("shouldResetSession", () => {
  it("returns true when idle timeout has elapsed", () => {
    const policy: SessionResetPolicy = {
      mode: "idle",
      idleMinutes: 30,
      dailyResetHour: 0,
    };
    const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;
    expect(shouldResetSession(thirtyOneMinutesAgo, policy)).toBe(true);
  });

  it("returns false when activity is within idle window", () => {
    const policy: SessionResetPolicy = {
      mode: "idle",
      idleMinutes: 30,
      dailyResetHour: 0,
    };
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    expect(shouldResetSession(tenMinutesAgo, policy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BaseAdapter.onMessage wiring
// ---------------------------------------------------------------------------
describe("BaseAdapter", () => {
  it("onMessage handler receives emitted events", () => {
    const adapter = new StubAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    const event: MessageEvent = {
      text: "hello",
      messageType: "text",
      source: {
        platform: "test",
        chatId: "c1",
        userId: "u1",
        chatType: "dm",
      },
    };
    adapter.simulateInbound(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });
});
