import { describe, it, expect, vi } from "vitest";
import { DeliveryRouter } from "../../src/gateway/delivery.js";
import { createSendMessageTool } from "../../src/core/tools/send-message.js";
import { BaseAdapter, type SendResult } from "../../src/gateway/adapter.js";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------
class MockAdapter extends BaseAdapter {
  readonly platform: string;
  sendMock = vi.fn<[string, string], Promise<SendResult>>();

  constructor(platform: string) {
    super();
    this.platform = platform;
    this.sendMock.mockResolvedValue({ success: true, messageId: "msg-1" });
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(chatId: string, content: string): Promise<SendResult> {
    return this.sendMock(chatId, content);
  }
  async sendTyping(_chatId: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("DeliveryRouter", () => {
  function setup() {
    const telegram = new MockAdapter("telegram");
    const discord = new MockAdapter("discord");
    const adapters = new Map<string, BaseAdapter>([
      ["telegram", telegram],
      ["discord", discord],
    ]);
    const getAdapter = (platform: string) => adapters.get(platform);
    const router = new DeliveryRouter(getAdapter);
    return { router, telegram, discord, getAdapter };
  }

  it("send to 'origin' resolves to source adapter", async () => {
    const { router, telegram } = setup();
    const result = await router.deliver("origin", "hello", telegram, "chat-42");

    expect(result.success).toBe(true);
    expect(telegram.sendMock).toHaveBeenCalledWith("chat-42", "hello");
  });

  it("send to 'telegram:123' resolves correctly", async () => {
    const { router, telegram } = setup();
    const result = await router.deliver("telegram:123", "hi there");

    expect(result.success).toBe(true);
    expect(telegram.sendMock).toHaveBeenCalledWith("123", "hi there");
  });

  it("cross-platform delivery works", async () => {
    const { router, telegram, discord } = setup();
    // Origin is telegram, but target is discord
    const result = await router.deliver("discord:guild-5", "cross-msg", telegram, "chat-1");

    expect(result.success).toBe(true);
    expect(discord.sendMock).toHaveBeenCalledWith("guild-5", "cross-msg");
    expect(telegram.sendMock).not.toHaveBeenCalled();
  });

  it("target platform not connected returns error", async () => {
    const { router } = setup();
    const result = await router.deliver("whatsapp:555", "nope");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/whatsapp/i);
  });

  it("send_message tool dispatches via router", async () => {
    const { router, telegram } = setup();
    const tool = createSendMessageTool(router);

    expect(tool.name).toBe("send_message");

    const raw = await tool.handler({ target: "telegram:99", content: "tool msg" });
    const parsed = JSON.parse(raw);

    expect(parsed.success).toBe(true);
    expect(telegram.sendMock).toHaveBeenCalledWith("99", "tool msg");
  });
});
