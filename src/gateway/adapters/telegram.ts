/**
 * Telegram adapter using Grammy (grammy.dev).
 */

import { Bot } from "grammy";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
  type SessionSource,
} from "../adapter.js";

export interface TelegramAdapterOptions {
  token: string;
}

export class TelegramAdapter extends BaseAdapter {
  private bot: Bot;

  constructor(opts: TelegramAdapterOptions) {
    super();
    this.bot = new Bot(opts.token);
    this.registerHandlers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.bot.start();
  }

  async disconnect(): Promise<void> {
    this.bot.stop();
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  async send(chatId: string, content: string): Promise<SendResult> {
    try {
      const msg = await this.bot.api.sendMessage(chatId, content);
      return { success: true, messageId: String(msg.message_id) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message, retryable: true };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, "typing...");
  }

  // -------------------------------------------------------------------------
  // Inbound handler registration
  // -------------------------------------------------------------------------

  private registerHandlers(): void {
    // Text messages
    this.bot.on("message:text", (ctx) => {
      this.emitMessage(this.normalizeText(ctx));
    });

    // Photo messages
    this.bot.on("message:photo", async (ctx) => {
      this.emitMessage(await this.normalizePhoto(ctx));
    });

    // Voice note messages
    this.bot.on("message:voice", async (ctx) => {
      this.emitMessage(await this.normalizeVoice(ctx));
    });

    // Audio file messages
    this.bot.on("message:audio", async (ctx) => {
      this.emitMessage(await this.normalizeAudio(ctx));
    });
  }

  // -------------------------------------------------------------------------
  // Normalizers
  // -------------------------------------------------------------------------

  private buildSource(msg: {
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string };
    message_thread_id?: number;
  }): SessionSource {
    const chatType =
      msg.chat.type === "private"
        ? "dm"
        : msg.chat.type === "channel"
          ? "channel"
          : "group";

    return {
      platform: "telegram",
      chatId: String(msg.chat.id),
      userId: String(msg.from?.id ?? "unknown"),
      userName: msg.from?.username ?? msg.from?.first_name,
      chatType,
      ...(msg.message_thread_id !== undefined && {
        threadId: String(msg.message_thread_id),
      }),
    };
  }

  private normalizeText(ctx: {
    message: {
      message_id: number;
      text: string;
      chat: { id: number; type: string };
      from?: { id: number; first_name?: string; username?: string };
      message_thread_id?: number;
    };
  }): MessageEvent {
    return {
      text: ctx.message.text,
      messageType: "text",
      source: this.buildSource(ctx.message),
      replyToMessageId: undefined,
    };
  }

  private async resolveFileUrl(fileId: string): Promise<string | undefined> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return undefined;
    return `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
  }

  private async normalizePhoto(ctx: {
    message: {
      message_id: number;
      photo?: Array<{ file_id: string }>;
      caption?: string;
      chat: { id: number; type: string };
      from?: { id: number; first_name?: string; username?: string };
      message_thread_id?: number;
    };
  }): Promise<MessageEvent> {
    // Resolve file_ids to fetchable URLs via Telegram Bot API
    const mediaUrls: string[] = [];
    if (ctx.message.photo && ctx.message.photo.length > 0) {
      // Use the largest photo (last in array)
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      try {
        const url = await this.resolveFileUrl(largest.file_id);
        if (url) mediaUrls.push(url);
      } catch {
        // Fall back to file_id if API call fails
        mediaUrls.push(largest.file_id);
      }
    }

    return {
      text: ctx.message.caption ?? "",
      messageType: "photo",
      source: this.buildSource(ctx.message),
      mediaUrls,
    };
  }

  private async normalizeVoice(ctx: {
    message: {
      message_id: number;
      voice: { file_id: string };
      caption?: string;
      chat: { id: number; type: string };
      from?: { id: number; first_name?: string; username?: string };
      message_thread_id?: number;
    };
  }): Promise<MessageEvent> {
    const mediaUrls: string[] = [];
    try {
      const url = await this.resolveFileUrl(ctx.message.voice.file_id);
      if (url) mediaUrls.push(url);
    } catch {
      mediaUrls.push(ctx.message.voice.file_id);
    }

    return {
      text: ctx.message.caption ?? "",
      messageType: "voice",
      source: this.buildSource(ctx.message),
      mediaUrls,
    };
  }

  private async normalizeAudio(ctx: {
    message: {
      message_id: number;
      audio: { file_id: string };
      caption?: string;
      chat: { id: number; type: string };
      from?: { id: number; first_name?: string; username?: string };
      message_thread_id?: number;
    };
  }): Promise<MessageEvent> {
    const mediaUrls: string[] = [];
    try {
      const url = await this.resolveFileUrl(ctx.message.audio.file_id);
      if (url) mediaUrls.push(url);
    } catch {
      mediaUrls.push(ctx.message.audio.file_id);
    }

    return {
      text: ctx.message.caption ?? "",
      messageType: "voice",
      source: this.buildSource(ctx.message),
      mediaUrls,
    };
  }
}
