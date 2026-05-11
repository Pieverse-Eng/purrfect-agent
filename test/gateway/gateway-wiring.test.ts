/**
 * Tests for gateway wiring fixes: #6 startGateway, #7 send_message origin context.
 * Issue #8 (WebhookAdapter sync response) is tested in adapters/webhook.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import { GatewayRunner } from "../../src/gateway/runner.js";
import { MessageHandler } from "../../src/gateway/handler.js";
import { DeliveryRouter } from "../../src/gateway/delivery.js";
import { createSendMessageTool } from "../../src/core/tools/send-message.js";
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
// Test #6: startGateway creates runner with config (mock adapters)
// ---------------------------------------------------------------------------

describe("Issue #6: Gateway startGateway wiring", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort */ }
    }
    cleanups.length = 0;
  });

  it("creates runner, wires adapters, handler, and delivery — full integration", async () => {
    const config = {
      platforms: {},
      sessionPolicy: noResetPolicy,
      groupSessionsPerUser: true,
    };

    // 1. Create runner with adapters (like startGateway does)
    const runner = new GatewayRunner(config);
    const telegramAdapter = new MockAdapter();
    const webhookAdapter = new MockAdapter();
    runner.addAdapter("telegram", telegramAdapter);
    runner.addAdapter("webhook", webhookAdapter);

    // 2. Create shared tool registry + delivery router
    const toolRegistry = new ToolRegistry();
    const deliveryRouter = new DeliveryRouter((p) => runner.getAdapter(p));
    const sendTool = createSendMessageTool(deliveryRouter);
    toolRegistry.register(sendTool);

    // 3. Create session store and provider
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const dbPath = join(tmp.path, "sessions.db");
    const store = new SessionStore(dbPath);
    cleanups.push(() => store.close());

    const mockFetch = createMockFetch([
      { body: makeTextResponse("Agent reply from gateway") },
    ]);

    // 4. Create handler with delivery router
    const handler = new MessageHandler({
      provider: makeProvider(mockFetch),
      sessionStore: store,
      toolRegistry,
      deliveryRouter,
      sessionPolicy: noResetPolicy,
    });

    // 5. Wire adapter.onMessage → handler.handle (like startGateway does)
    telegramAdapter.onMessage((event) => {
      handler.handle(event, telegramAdapter).catch(() => {});
    });

    // 6. Start runner
    await runner.start();
    expect(runner.isRunning).toBe(true);
    expect(telegramAdapter.connected).toBe(true);
    expect(webhookAdapter.connected).toBe(true);

    // 7. Simulate inbound message and verify response
    const event = makeEvent("Hello gateway");
    await handler.handle(event, telegramAdapter);

    expect(telegramAdapter.sent).toHaveLength(1);
    expect(telegramAdapter.sent[0].content).toBe("Agent reply from gateway");

    // 8. Shutdown
    await runner.stop();
    expect(runner.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test #7: send_message with origin target uses correct adapter
// ---------------------------------------------------------------------------

describe("Issue #7: send_message with origin context", () => {
  it("send_message tool with origin target routes to origin adapter", async () => {
    const telegram = new MockAdapter();
    const discord = new MockAdapter();
    const adapters = new Map<string, BaseAdapter>([
      ["telegram", telegram],
      ["discord", discord],
    ]);
    const router = new DeliveryRouter((p) => adapters.get(p));

    // Create send_message tool with origin context (telegram, chat-42)
    const tool = createSendMessageTool({
      router,
      originAdapter: telegram,
      originChatId: "chat-42",
    });

    expect(tool.name).toBe("send_message");

    // "origin" target should resolve to telegram:chat-42
    const raw = await tool.handler({ target: "origin", content: "reply to origin" });
    const parsed = JSON.parse(raw);

    expect(parsed.success).toBe(true);
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].chatId).toBe("chat-42");
    expect(telegram.sent[0].content).toBe("reply to origin");
    expect(discord.sent).toHaveLength(0);
  });

  it("send_message without origin context returns error for 'origin' target", async () => {
    const telegram = new MockAdapter();
    const router = new DeliveryRouter((p) =>
      p === "telegram" ? telegram : undefined,
    );

    // Create without origin context (backward-compatible)
    const tool = createSendMessageTool(router);

    const raw = await tool.handler({ target: "origin", content: "hello" });
    const parsed = JSON.parse(raw);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/origin/i);
  });

  it("send_message with origin still allows explicit platform:chatId targets", async () => {
    const telegram = new MockAdapter();
    const discord = new MockAdapter();
    const adapters = new Map<string, BaseAdapter>([
      ["telegram", telegram],
      ["discord", discord],
    ]);
    const router = new DeliveryRouter((p) => adapters.get(p));

    const tool = createSendMessageTool({
      router,
      originAdapter: telegram,
      originChatId: "chat-42",
    });

    // Explicit target should bypass origin
    const raw = await tool.handler({ target: "discord:guild-5", content: "cross-plat" });
    const parsed = JSON.parse(raw);

    expect(parsed.success).toBe(true);
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0].chatId).toBe("guild-5");
    expect(telegram.sent).toHaveLength(0);
  });
});
