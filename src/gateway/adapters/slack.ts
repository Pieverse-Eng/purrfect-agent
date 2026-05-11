import { App } from "@slack/bolt";
import { randomUUID } from "node:crypto";
import {
  BaseAdapter,
  type MessageEvent,
  type SendResult,
} from "../adapter.js";
import type { ClarifyRequest } from "../../core/tools/clarify.js";
import { renderClarifyRequest } from "../../core/tools/clarify.js";

export interface SlackAdapterOptions {
  appToken: string;
  botToken: string;
  maxKnownChatTypes?: number;
}

export class SlackAdapter extends BaseAdapter {
  private app: App;
  private readonly chatTypes = new Map<string, "dm" | "group" | "channel">();
  private readonly maxKnownChatTypes: number;

  constructor(opts: SlackAdapterOptions) {
    super();
    this.maxKnownChatTypes = opts.maxKnownChatTypes ?? 500;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
    });

    this.app.message(async (args) => {
      const msg = (args as any).message;

      // Ignore bot messages
      if (msg.bot_id || msg.subtype === "bot_message") return;

      const channelType = msg.channel_type;
      let chatType: "dm" | "group" | "channel";
      if (channelType === "im") {
        chatType = "dm";
      } else if (channelType === "mpim" || channelType === "group") {
        chatType = "group";
      } else {
        chatType = "channel";
      }
      this.rememberChatType(msg.channel, chatType);

      const event: MessageEvent = {
        text: msg.text ?? "",
        messageType: "text",
        source: {
          platform: "slack",
          chatId: msg.channel,
          userId: msg.user,
          chatType,
          ...(msg.thread_ts ? { threadId: msg.thread_ts } : {}),
        },
      };

      this.emitMessage(event);
    });

    const action = (this.app as { action?: unknown }).action;
    if (typeof action === "function") {
      action.call(this.app, /^clarify:/, async (args: any) => {
        await args.ack?.();
        const value = args.action?.value;
        const clarificationId = parseClarifyActionId(args.action?.action_id);
        const channelId =
          args.body?.channel?.id ?? args.body?.container?.channel_id;
        const userId = args.body?.user?.id;
        if (
          typeof value !== "string" ||
          typeof channelId !== "string" ||
          typeof userId !== "string"
        ) {
          return;
        }

        const event: MessageEvent = {
          text: value,
          messageType: "text",
          source: {
            platform: "slack",
            chatId: channelId,
            userId,
            userName: args.body?.user?.name ?? args.body?.user?.username,
            chatType: this.chatTypes.get(channelId) ?? inferChatType(channelId),
            ...(args.body?.message?.thread_ts
              ? { threadId: args.body.message.thread_ts }
              : {}),
          },
          ...(clarificationId
            ? { metadata: { clarificationId } }
            : {}),
        };

        this.emitMessage(event);
      });
    } else {
      console.warn("[gateway:slack] Slack action handler unavailable; clarify buttons disabled.");
    }
  }

  async connect(): Promise<void> {
    await this.app.start();
  }

  async disconnect(): Promise<void> {
    await this.app.stop();
  }

  async send(chatId: string, content: string): Promise<SendResult> {
    try {
      const result = await this.app.client.chat.postMessage({
        channel: chatId,
        text: content,
      });
      return {
        success: true,
        messageId: result.ts as string,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        retryable: true,
      };
    }
  }

  async sendClarification(
    chatId: string,
    request: ClarifyRequest,
  ): Promise<SendResult> {
    const text = renderClarifyRequest(request);
    const options = request.options ?? [];
    if (options.length === 0) {
      return this.send(chatId, text);
    }
    if (options.length > MAX_SLACK_ACTION_BUTTONS) {
      console.warn(
        `[gateway:slack] ${options.length} clarify options exceed Slack button limit; falling back to text prompt.`,
      );
      return this.send(chatId, text);
    }

    try {
      const clarificationId = request.id ?? randomUUID();
      const result = await this.app.client.chat.postMessage({
        channel: chatId,
        text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text,
            },
          },
          {
            type: "actions",
            elements: options.map((option, index) => ({
              type: "button",
              action_id: `clarify:${clarificationId}:${index}`,
              text: {
                type: "plain_text",
                text: truncateButtonText(option.label),
              },
              value: option.value,
              ...(request.default === option.value
                ? { style: "primary" }
                : {}),
            })),
          },
        ],
      } as any);
      return {
        success: true,
        messageId: result.ts as string,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        retryable: true,
      };
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't have a direct typing indicator API for bots
  }

  private rememberChatType(
    channelId: string,
    chatType: "dm" | "group" | "channel",
  ): void {
    if (this.chatTypes.has(channelId)) {
      this.chatTypes.delete(channelId);
    }
    this.chatTypes.set(channelId, chatType);
    while (this.chatTypes.size > this.maxKnownChatTypes) {
      const oldest = this.chatTypes.keys().next().value;
      if (!oldest) break;
      this.chatTypes.delete(oldest);
    }
  }
}

const MAX_SLACK_ACTION_BUTTONS = 25;

function truncateButtonText(text: string): string {
  return text.length > 75 ? `${text.slice(0, 72)}...` : text;
}

function parseClarifyActionId(actionId: unknown): string | undefined {
  if (typeof actionId !== "string") return undefined;
  const match = /^clarify:([^:]+):\d+$/.exec(actionId);
  return match?.[1];
}

function inferChatType(channelId: string): "dm" | "group" | "channel" {
  if (channelId.startsWith("D")) return "dm";
  if (channelId.startsWith("G")) return "group";
  return "channel";
}
