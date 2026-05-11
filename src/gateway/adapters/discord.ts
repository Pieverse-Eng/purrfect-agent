/**
 * Discord adapter – bridges discord.js to the BaseAdapter interface.
 */

import { Client, GatewayIntentBits } from "discord.js";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
} from "../adapter.js";

interface DiscordAttachmentLike {
  url?: string;
  contentType?: string | null;
}

function listAttachments(raw: unknown): DiscordAttachmentLike[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    if (
      "values" in raw &&
      typeof (raw as { values?: () => Iterable<DiscordAttachmentLike> }).values ===
        "function"
    ) {
      return Array.from((raw as { values: () => Iterable<DiscordAttachmentLike> }).values());
    }
    if (Symbol.iterator in raw) {
      return Array.from(raw as Iterable<DiscordAttachmentLike>);
    }
  }
  return [];
}

export interface DiscordAdapterOptions {
  token: string;
}

export class DiscordAdapter extends BaseAdapter {
  private readonly token: string;
  private client: Client | undefined;

  constructor(opts: DiscordAdapterOptions) {
    super();
    this.token = opts.token;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("messageCreate", (message) => {
      if (message.author.bot) return;

      const isThread = message.channel.isThread();
      const attachments = listAttachments(
        (message as { attachments?: unknown }).attachments,
      );
      const audioUrls = attachments
        .filter((attachment) => attachment.contentType?.startsWith("audio/"))
        .map((attachment) => attachment.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
      const imageUrls = attachments
        .filter((attachment) => attachment.contentType?.startsWith("image/"))
        .map((attachment) => attachment.url)
        .filter((url): url is string => typeof url === "string" && url.length > 0);
      const documentUrls = attachments
        .filter(
          (attachment) =>
            typeof attachment.url === "string" &&
            attachment.url.length > 0 &&
            !attachment.contentType?.startsWith("audio/") &&
            !attachment.contentType?.startsWith("image/"),
        )
        .map((attachment) => attachment.url as string);

      let messageType: MessageEvent["messageType"] = "text";
      let mediaUrls: string[] | undefined;
      if (audioUrls.length > 0) {
        messageType = "voice";
        mediaUrls = audioUrls;
      } else if (imageUrls.length > 0) {
        messageType = "photo";
        mediaUrls = imageUrls;
      } else if (documentUrls.length > 0) {
        messageType = "document";
        mediaUrls = documentUrls;
      }

      const event: MessageEvent = {
        text: message.content,
        messageType,
        source: {
          platform: "discord",
          chatId: message.channelId,
          userId: message.author.id,
          userName: message.author.username,
          chatType: message.guild ? "group" : "dm",
          ...(isThread ? { threadId: message.channel.id } : {}),
        },
        ...(mediaUrls ? { mediaUrls } : {}),
        ...(message.reference?.messageId
          ? { replyToMessageId: message.reference.messageId }
          : {}),
      };

      this.emitMessage(event);
    });

    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    await this.client?.destroy();
    this.client = undefined;
  }

  async send(chatId: string, content: string): Promise<SendResult> {
    try {
      const channel = await this.client!.channels.fetch(chatId);
      if (!channel || !("send" in channel)) {
        return { success: false, error: "Channel not found or not text-based" };
      }
      const sent = await (channel as { send: (c: string) => Promise<{ id: string }> }).send(content);
      return { success: true, messageId: sent.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, retryable: true };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client!.channels.fetch(chatId);
      if (channel && "sendTyping" in channel) {
        await (channel as { sendTyping: () => Promise<void> }).sendTyping();
      }
    } catch {
      // best-effort
    }
  }
}
