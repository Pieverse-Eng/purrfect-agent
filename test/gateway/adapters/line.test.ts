import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageEvent } from "../../../src/gateway/adapter.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock @line/bot-sdk
// ---------------------------------------------------------------------------
const mockPushMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("@line/bot-sdk", () => {
  const { createHmac } = require("node:crypto");
  return {
    messagingApi: {
      MessagingApiClient: class {
        pushMessage = mockPushMessage;
        constructor() {}
      },
    },
    validateSignature: (body: string, secret: string, signature: string): boolean => {
      const expected = createHmac("sha256", secret)
        .update(body)
        .digest("base64");
      return expected === signature;
    },
  };
});

// Mock node:http to capture the request handler
let httpRequestHandler: (req: any, res: any) => void;
const mockListen = vi.fn().mockImplementation((_port: number, cb?: () => void) => {
  cb?.();
});
const mockClose = vi.fn().mockImplementation((cb?: () => void) => {
  cb?.();
});

vi.mock("node:http", () => ({
  createServer: vi.fn().mockImplementation((handler: any) => {
    httpRequestHandler = handler;
    return { listen: mockListen, close: mockClose };
  }),
}));

import { LineAdapter } from "../../../src/gateway/adapters/line.js";

function makeSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function simulateWebhook(
  body: object,
  secret: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    const rawBody = JSON.stringify(body);
    const signature = makeSignature(rawBody, secret);

    const chunks: Buffer[] = [Buffer.from(rawBody)];
    const req = {
      method: "POST",
      headers: {
        "x-line-signature": signature,
        "content-type": "application/json",
        ...extraHeaders,
      },
      on(event: string, cb: (data?: any) => void) {
        if (event === "data") {
          for (const c of chunks) cb(c);
        }
        if (event === "end") cb();
        return req;
      },
    };

    const res = {
      statusCode: 200,
      body: "",
      writeHead(code: number) {
        this.statusCode = code;
        return this;
      },
      end(data?: string) {
        this.body = data ?? "";
        resolve({ statusCode: this.statusCode, body: this.body });
      },
    };

    httpRequestHandler(req, res);
  });
}

describe("LineAdapter", () => {
  const secret = "test-channel-secret";
  let adapter: LineAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new LineAdapter({
      channelAccessToken: "test-access-token",
      channelSecret: secret,
      webhookPort: 9000,
    });
  });

  it("maps a text message event to MessageEvent", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    await simulateWebhook(
      {
        events: [
          {
            type: "message",
            message: { type: "text", id: "msg1", text: "hello line" },
            source: { type: "user", userId: "U111" },
            replyToken: "rtoken1",
            timestamp: 1234567890,
          },
        ],
      },
      secret,
    );

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.text).toBe("hello line");
    expect(event.source.platform).toBe("line");
    expect(event.source.userId).toBe("U111");
    expect(event.source.chatType).toBe("dm");
  });

  it("maps group source type to group chatType", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    await simulateWebhook(
      {
        events: [
          {
            type: "message",
            message: { type: "text", id: "msg2", text: "group msg" },
            source: { type: "group", groupId: "G222", userId: "U111" },
            replyToken: "rtoken2",
            timestamp: 1234567891,
          },
        ],
      },
      secret,
    );

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.chatType).toBe("group");
    expect(event.source.chatId).toBe("G222");
  });

  it("send() calls pushMessage", async () => {
    const result = await adapter.send("U111", "hi there");

    expect(mockPushMessage).toHaveBeenCalledWith({
      to: "U111",
      messages: [{ type: "text", text: "hi there" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects requests with invalid webhook signature", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const rawBody = JSON.stringify({ events: [] });

    const result = await new Promise<{ statusCode: number }>((resolve) => {
      const req = {
        method: "POST",
        headers: {
          "x-line-signature": "invalid-signature",
          "content-type": "application/json",
        },
        on(event: string, cb: (data?: any) => void) {
          if (event === "data") cb(Buffer.from(rawBody));
          if (event === "end") cb();
          return req;
        },
      };

      const res = {
        statusCode: 200,
        writeHead(code: number) {
          this.statusCode = code;
          return this;
        },
        end() {
          resolve({ statusCode: this.statusCode });
        },
      };

      httpRequestHandler(req, res);
    });

    expect(result.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps room source type to group chatType", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    await simulateWebhook(
      {
        events: [
          {
            type: "message",
            message: { type: "text", id: "msg3", text: "room msg" },
            source: { type: "room", roomId: "R333", userId: "U111" },
            replyToken: "rtoken3",
            timestamp: 1234567892,
          },
        ],
      },
      secret,
    );

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.chatType).toBe("group");
    expect(event.source.chatId).toBe("R333");
  });
});
