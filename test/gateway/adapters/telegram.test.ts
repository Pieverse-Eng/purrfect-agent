import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageEvent } from "../../../src/gateway/adapter.js";

// ---------------------------------------------------------------------------
// Grammy mock — minimal Bot that captures event handlers and exposes api stub
// ---------------------------------------------------------------------------

type HandlerFn = (ctx: any) => void | Promise<void>;

const mockSendMessage = vi.fn();
const mockGetFile = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();

let registeredHandlers: Map<string, HandlerFn>;

class MockBot {
  readonly token: string;
  api = { sendMessage: mockSendMessage, getFile: mockGetFile };

  constructor(token: string) {
    this.token = token;
    registeredHandlers = new Map();
  }

  on(event: string, handler: HandlerFn): void {
    registeredHandlers.set(event, handler);
  }

  start(): void {
    mockStart();
  }

  stop(): void {
    mockStop();
  }
}

vi.mock("grammy", () => ({ Bot: MockBot }));

// Import adapter *after* mock is registered
const { TelegramAdapter } = await import(
  "../../../src/gateway/adapters/telegram.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTextCtx(overrides: Record<string, any> = {}) {
  return {
    message: {
      message_id: 100,
      text: "hello world",
      chat: { id: 42, type: "private" },
      from: { id: 7, first_name: "Alice", username: "alice" },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TelegramAdapter", () => {
  let adapter: InstanceType<typeof TelegramAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFile.mockResolvedValue({ file_path: "media/default.dat" });
    adapter = new TelegramAdapter({ token: "test-token" });
  });

  // 1. Text message normalised to MessageEvent
  it("normalises a text message into a MessageEvent", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const textHandler = registeredHandlers.get("message:text");
    expect(textHandler).toBeDefined();

    await textHandler!(buildTextCtx());

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.text).toBe("hello world");
    expect(event.messageType).toBe("text");
    expect(event.source.platform).toBe("telegram");
    expect(event.source.chatId).toBe("42");
    expect(event.source.userId).toBe("7");
    expect(event.source.chatType).toBe("dm");
  });

  // 2. send() calls bot.api.sendMessage and returns SendResult
  it("send() calls bot.api.sendMessage and returns SendResult", async () => {
    mockSendMessage.mockResolvedValueOnce({ message_id: 200 });
    await adapter.connect();

    const result = await adapter.send("42", "hi there");

    expect(mockSendMessage).toHaveBeenCalledWith("42", "hi there");
    expect(result).toEqual({
      success: true,
      messageId: "200",
    });
  });

  // 3. Forum topic message_thread_id maps to threadId
  it("maps forum topic message_thread_id to threadId", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const textHandler = registeredHandlers.get("message:text");
    await textHandler!(
      buildTextCtx({
        message_thread_id: 999,
        chat: { id: 42, type: "supergroup" },
      }),
    );

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.threadId).toBe("999");
    expect(event.source.chatType).toBe("group");
  });

  // 4. Photo message maps to messageType 'photo'
  it("maps photo message to messageType photo", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    // Photo handler is registered under "message:photo"
    const photoHandler = registeredHandlers.get("message:photo");
    expect(photoHandler).toBeDefined();

    const ctx = {
      message: {
        message_id: 101,
        photo: [{ file_id: "abc", width: 100, height: 100 }],
        caption: "nice pic",
        chat: { id: 42, type: "private" },
        from: { id: 7, first_name: "Alice" },
      },
    };

    await photoHandler!(ctx);

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.messageType).toBe("photo");
    expect(event.text).toBe("nice pic");
    expect(event.mediaUrls).toEqual([
      "https://api.telegram.org/file/bottest-token/media/default.dat",
    ]);
  });

  // 5. send() failure returns retryable SendResult
  it("returns retryable SendResult on send failure", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("network timeout"));
    await adapter.connect();

    const result = await adapter.send("42", "fail");

    expect(result).toEqual({
      success: false,
      error: "network timeout",
      retryable: true,
    });
  });

  it("maps a voice message to messageType voice with a fetchable media URL", async () => {
    mockGetFile.mockResolvedValueOnce({ file_path: "voice/clip.ogg" });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const voiceHandler = registeredHandlers.get("message:voice");
    expect(voiceHandler).toBeDefined();

    await voiceHandler!({
      message: {
        message_id: 102,
        voice: { file_id: "voice-1" },
        chat: { id: 42, type: "private" },
        from: { id: 7, first_name: "Alice" },
      },
    });

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.messageType).toBe("voice");
    expect(event.mediaUrls).toEqual([
      "https://api.telegram.org/file/bottest-token/voice/clip.ogg",
    ]);
  });

  it("maps an audio file message to messageType voice with a fetchable media URL", async () => {
    mockGetFile.mockResolvedValueOnce({ file_path: "audio/song.mp3" });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const audioHandler = registeredHandlers.get("message:audio");
    expect(audioHandler).toBeDefined();

    await audioHandler!({
      message: {
        message_id: 103,
        audio: { file_id: "audio-1" },
        caption: "listen",
        chat: { id: 42, type: "private" },
        from: { id: 7, first_name: "Alice" },
      },
    });

    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.messageType).toBe("voice");
    expect(event.text).toBe("listen");
    expect(event.mediaUrls).toEqual([
      "https://api.telegram.org/file/bottest-token/audio/song.mp3",
    ]);
  });
});
