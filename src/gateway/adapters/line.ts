import { createServer, type Server } from "node:http";
import {
  messagingApi,
  validateSignature,
} from "@line/bot-sdk";
import {
  BaseAdapter,
  type MessageEvent,
  type SendResult,
} from "../adapter.js";

export interface LineAdapterOptions {
  channelAccessToken: string;
  channelSecret: string;
  webhookPort?: number;
}

export class LineAdapter extends BaseAdapter {
  private client: messagingApi.MessagingApiClient;
  private secret: string;
  private port: number;
  private server: Server | undefined;

  constructor(opts: LineAdapterOptions) {
    super();
    this.secret = opts.channelSecret;
    this.port = opts.webhookPort ?? 3000;
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: opts.channelAccessToken,
    });
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf-8");
        const signature = req.headers["x-line-signature"] as string;

        if (!validateSignature(rawBody, this.secret, signature)) {
          res.writeHead(401);
          res.end();
          return;
        }

        const body = JSON.parse(rawBody);

        for (const evt of body.events ?? []) {
          if (evt.type !== "message" || evt.message?.type !== "text") continue;

          const srcType = evt.source?.type;
          let chatType: "dm" | "group" | "channel";
          let chatId: string;

          if (srcType === "group") {
            chatType = "group";
            chatId = evt.source.groupId;
          } else if (srcType === "room") {
            chatType = "group";
            chatId = evt.source.roomId;
          } else {
            chatType = "dm";
            chatId = evt.source?.userId ?? "";
          }

          const event: MessageEvent = {
            text: evt.message.text,
            messageType: "text",
            source: {
              platform: "line",
              chatId,
              userId: evt.source?.userId ?? "",
              chatType,
            },
          };

          this.emitMessage(event);
        }

        res.writeHead(200);
        res.end("OK");
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, resolve);
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  async send(chatId: string, content: string): Promise<SendResult> {
    try {
      await this.client.pushMessage({
        to: chatId,
        messages: [{ type: "text", text: content }],
      });
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        retryable: true,
      };
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Line doesn't expose a typing indicator for bots
  }
}
