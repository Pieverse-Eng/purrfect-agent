import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageEvent } from "../../../src/gateway/adapter.js";

// ---------------------------------------------------------------------------
// Mock @slack/bolt
// ---------------------------------------------------------------------------
const mockStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockStop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPostMessage = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, ts: "msg-ts-1" }));

let registeredMessageHandler: (args: any) => void;
let registeredActionHandler: (args: any) => void;

vi.mock("@slack/bolt", () => ({
  App: class MockApp {
    client = { chat: { postMessage: mockPostMessage } };
    constructor() {}
    start = mockStart;
    stop = mockStop;
    message(handler: any) {
      registeredMessageHandler = handler;
    }
    action(_pattern: any, handler: any) {
      registeredActionHandler = handler;
    }
  },
}));

import { SlackAdapter } from "../../../src/gateway/adapters/slack.js";

describe("SlackAdapter", () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SlackAdapter({
      appToken: "xapp-test-token",
      botToken: "xoxb-test-token",
    });
  });

  it("maps a channel message to MessageEvent", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    registeredMessageHandler({
      message: {
        text: "hello slack",
        user: "U123",
        channel: "C456",
        ts: "1234.5678",
        channel_type: "channel",
      },
      say: vi.fn(),
    });

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.text).toBe("hello slack");
    expect(event.source.platform).toBe("slack");
    expect(event.source.userId).toBe("U123");
    expect(event.source.chatId).toBe("C456");
    expect(event.source.chatType).toBe("channel");
  });

  it("maps thread_ts to threadId", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    registeredMessageHandler({
      message: {
        text: "threaded reply",
        user: "U123",
        channel: "C456",
        ts: "1234.9999",
        thread_ts: "1234.0000",
        channel_type: "channel",
      },
      say: vi.fn(),
    });

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.threadId).toBe("1234.0000");
  });

  it("send() calls chat.postMessage", async () => {
    const result = await adapter.send("C456", "hello world");

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "C456",
      text: "hello world",
    });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg-ts-1");
  });

  it("ignores bot messages", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    registeredMessageHandler({
      message: {
        text: "bot says hi",
        user: "U123",
        channel: "C456",
        ts: "1234.5678",
        bot_id: "B999",
        channel_type: "channel",
      },
      say: vi.fn(),
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("maps DM channel_type to dm chatType", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    registeredMessageHandler({
      message: {
        text: "private dm",
        user: "U123",
        channel: "D789",
        ts: "1234.5678",
        channel_type: "im",
      },
      say: vi.fn(),
    });

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.chatType).toBe("dm");
  });

  it("sendClarification() renders option buttons", async () => {
    const result = await adapter.sendClarification("C456", {
      question: "Which environment?",
      reason: "The target is missing.",
      default: "dev",
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
    });

    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C456",
        text: expect.stringContaining("Which environment?"),
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "actions" }),
        ]),
      }),
    );
    const payload = mockPostMessage.mock.calls[0][0];
    const actionsBlock = payload.blocks.find((block: any) => block.type === "actions");
    expect(actionsBlock.elements[1]).toMatchObject({
      type: "button",
      text: { type: "plain_text", text: "Staging" },
      value: "staging",
    });
    expect(actionsBlock.elements[1].action_id).toMatch(/^clarify:/);
  });

  it("falls back to a text prompt when Slack would exceed the button limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = Array.from({ length: 26 }, (_, i) => ({
      value: `option-${i}`,
      label: `Option ${i}`,
    }));

    const result = await adapter.sendClarification("C456", {
      question: "Pick one?",
      options,
    });

    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "C456",
      text: expect.stringContaining("26. Option 25"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("26 clarify options"),
    );
    warn.mockRestore();
  });

  it("button clicks emit the selected option as a MessageEvent", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    const ack = vi.fn().mockResolvedValue(undefined);

    await registeredActionHandler({
      ack,
      body: {
        user: { id: "U123", name: "Maohua" },
        channel: { id: "C456" },
        message: { ts: "1111.2222", thread_ts: "1111.0000" },
      },
      action: { action_id: "clarify:clarify-123:1", value: "staging" },
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.text).toBe("staging");
    expect(event.metadata?.clarificationId).toBe("clarify-123");
    expect(event.source).toMatchObject({
      platform: "slack",
      chatId: "C456",
      userId: "U123",
      chatType: "channel",
      threadId: "1111.0000",
    });
  });

  it("button clicks preserve the chatType learned from the original message", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);

    registeredMessageHandler({
      message: {
        text: "group context",
        user: "U123",
        channel: "G999",
        ts: "1234.5678",
        channel_type: "group",
      },
      say: vi.fn(),
    });
    handler.mockClear();

    await registeredActionHandler({
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        user: { id: "U123" },
        channel: { id: "G999" },
        message: { ts: "1111.2222" },
      },
      action: { action_id: "clarify:clarify-456:0", value: "staging" },
    });

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.chatType).toBe("group");
  });
});
