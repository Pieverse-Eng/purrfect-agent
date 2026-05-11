import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { MessageEvent } from "../../../src/gateway/adapter.js";

// ---------------------------------------------------------------------------
// Mock discord.js Client
// ---------------------------------------------------------------------------

class MockClient extends EventEmitter {
  readonly options: unknown;
  constructor(opts: unknown) {
    super();
    this.options = opts;
  }
  login = vi.fn<(token: string) => Promise<string>>().mockResolvedValue("token");
  destroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  channels = {
    fetch: vi.fn(),
  };
}

let latestClient: MockClient;

vi.mock("discord.js", () => {
  return {
    Client: class extends MockClient {
      constructor(opts: unknown) {
        super(opts);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestClient = this;
      }
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
  };
});

// Import after mocking
const { DiscordAdapter } = await import(
  "../../../src/gateway/adapters/discord.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    content: "hello world",
    id: "msg-1",
    author: { id: "user-1", username: "alice", bot: false },
    channelId: "ch-100",
    guild: { id: "guild-1" },
    channel: { isThread: () => false },
    attachments: [],
    reference: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordAdapter", () => {
  let adapter: InstanceType<typeof DiscordAdapter>;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    adapter = new DiscordAdapter({ token: "test-token" });
    handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();
  });

  // 1. Guild message → chatType "group"
  it("maps a guild message to chatType group", () => {
    const msg = makeMessage();
    latestClient.emit("messageCreate", msg);

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.text).toBe("hello world");
    expect(event.source.platform).toBe("discord");
    expect(event.source.chatType).toBe("group");
    expect(event.source.chatId).toBe("ch-100");
    expect(event.source.userId).toBe("user-1");
    expect(event.source.userName).toBe("alice");
  });

  // 2. DM → chatType "dm"
  it("maps a DM (no guild) to chatType dm", () => {
    const msg = makeMessage({ guild: null });
    latestClient.emit("messageCreate", msg);

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.chatType).toBe("dm");
  });

  // 3. Thread → threadId set
  it("sets threadId when the channel is a thread", () => {
    const msg = makeMessage({
      channel: { isThread: () => true, id: "thread-42" },
    });
    latestClient.emit("messageCreate", msg);

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.threadId).toBe("thread-42");
  });

  // 4. Bot messages are ignored
  it("ignores messages from bots", () => {
    const msg = makeMessage({
      author: { id: "bot-1", username: "botty", bot: true },
    });
    latestClient.emit("messageCreate", msg);

    expect(handler).not.toHaveBeenCalled();
  });

  // 5. send() fetches channel and calls channel.send()
  it("send fetches the channel and calls channel.send", async () => {
    const mockSend = vi.fn().mockResolvedValue({ id: "sent-1" });
    latestClient.channels.fetch.mockResolvedValue({ send: mockSend });

    const result = await adapter.send("ch-200", "hi there");

    expect(latestClient.channels.fetch).toHaveBeenCalledWith("ch-200");
    expect(mockSend).toHaveBeenCalledWith("hi there");
    expect(result.success).toBe(true);
    expect(result.messageId).toBe("sent-1");
  });

  it("maps audio attachments to messageType voice with mediaUrls", () => {
    const msg = makeMessage({
      content: "",
      attachments: [
        {
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
          contentType: "audio/ogg",
        },
      ],
    });
    latestClient.emit("messageCreate", msg);

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.messageType).toBe("voice");
    expect(event.mediaUrls).toEqual([
      "https://cdn.discordapp.com/attachments/voice.ogg",
    ]);
  });
});
