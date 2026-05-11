import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BaseAdapter,
  type MessageEvent,
  type SendResult,
} from "../adapter.js";
import type { WebhookSubscriptionStore } from "../webhook-subscriptions.js";

export interface WebhookAdapterOptions {
  port: number;
  authToken?: string;
  /** Optional subscription store for outbound event subscriptions. */
  subscriptions?: WebhookSubscriptionStore;
}

/** Default header carrying the HMAC-SHA256 signature for inbound subscription events. */
const DEFAULT_SIGNATURE_HEADER = "x-hub-signature-256";
/** Default header carrying the event name for inbound subscription events. */
const DEFAULT_EVENT_HEADER = "x-event-name";

/** Default timeout (ms) to wait for agent response before returning 504. */
const RESPONSE_TIMEOUT_MS = 60_000;

/**
 * Tracks an in-flight HTTP request waiting for the agent response.
 */
interface PendingResponse {
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
}

export class WebhookAdapter extends BaseAdapter {
  private port: number;
  private authToken: string | undefined;
  private subscriptions: WebhookSubscriptionStore | undefined;
  private server: Server | undefined;

  /** chatId → pending HTTP response waiting for agent reply via send(). */
  private readonly pending = new Map<string, PendingResponse>();

  constructor(opts: WebhookAdapterOptions) {
    super();
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.subscriptions = opts.subscriptions;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => {
      // Subscription event delivery: POST /webhook/<id>
      if (req.method === "POST" && req.url?.startsWith("/webhook/")) {
        this.handleSubscriptionEvent(req, res);
        return;
      }

      // Only handle POST /message
      if (req.method !== "POST" || req.url !== "/message") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      // Auth check
      if (this.authToken) {
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${this.authToken}`) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
      }

      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf-8");
        let body: any;
        try {
          body = JSON.parse(rawBody);
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
          return;
        }

        const { text, userId, chatId } = body;

        if (!text || typeof text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }

        if (!userId || typeof userId !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "userId is required" }));
          return;
        }

        const resolvedChatId = chatId ?? userId;

        const event: MessageEvent = {
          text,
          messageType: "text",
          source: {
            platform: "webhook",
            chatId: resolvedChatId,
            userId,
            chatType: chatId ? "group" : "dm",
          },
        };

        // Store the HTTP response — the agent will call send() which resolves it
        const timer = setTimeout(() => {
          this.pending.delete(resolvedChatId);
          if (!res.writableEnded) {
            res.writeHead(504, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Agent response timeout" }));
          }
        }, RESPONSE_TIMEOUT_MS);

        this.pending.set(resolvedChatId, { res, timer });

        this.emitMessage(event);
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, resolve);
    });
  }

  async disconnect(): Promise<void> {
    // Clear all pending timeouts
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (!entry.res.writableEnded) {
        entry.res.writeHead(503, { "Content-Type": "application/json" });
        entry.res.end(JSON.stringify({ error: "Gateway shutting down" }));
      }
    }
    this.pending.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  async send(chatId: string, content: string): Promise<SendResult> {
    const entry = this.pending.get(chatId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(chatId);

      if (!entry.res.writableEnded) {
        entry.res.writeHead(200, { "Content-Type": "application/json" });
        entry.res.end(JSON.stringify({ ok: true, content }));
      }

      return {
        success: true,
        messageId: `webhook-${chatId}-${Date.now()}`,
      };
    }

    // No pending HTTP response (out-of-band send or already timed out)
    return {
      success: true,
      messageId: `webhook-${chatId}-${Date.now()}`,
    };
  }

  async sendTyping(_chatId: string): Promise<void> {
    // No typing indicator for webhook
  }

  private handleSubscriptionEvent(req: IncomingMessage, res: ServerResponse): void {
    if (!this.subscriptions) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const id = (req.url ?? "").slice("/webhook/".length).split("?")[0];
    if (!id) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const sub = this.subscriptions.get(id);
    if (!sub) {
      res.writeHead(404);
      res.end("Subscription not found");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);

      const sigHeaderName = (sub.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase();
      const sigHeaderValue = req.headers[sigHeaderName];
      const providedSig = Array.isArray(sigHeaderValue) ? sigHeaderValue[0] : sigHeaderValue;
      if (!providedSig || !verifyHmacSignature(providedSig, rawBody, sub.secret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      const eventHeaderName = (sub.eventHeader ?? DEFAULT_EVENT_HEADER).toLowerCase();
      const eventHeaderValue = req.headers[eventHeaderName];
      const eventName =
        (Array.isArray(eventHeaderValue) ? eventHeaderValue[0] : eventHeaderValue) ?? sub.event;

      const chatId = sub.chatId ?? sub.id;
      const text = `[webhook:${eventName}] ${rawBody.toString("utf-8")}`;

      this.emitMessage({
        text,
        messageType: "text",
        source: {
          platform: "webhook",
          chatId,
          userId: sub.id,
          chatType: "channel",
        },
        metadata: {},
      });

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, subscriptionId: sub.id }));
    });
  }
}

/**
 * Verify an HMAC-SHA256 signature.
 * Accepts both `sha256=<hex>` and bare `<hex>` formats.
 */
export function verifyHmacSignature(
  provided: string,
  body: Buffer,
  secret: string,
): boolean {
  const expectedHex = createHmac("sha256", secret).update(body).digest("hex");
  const providedHex = provided.startsWith("sha256=") ? provided.slice(7) : provided;
  if (providedHex.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(providedHex, "hex"), Buffer.from(expectedHex, "hex"));
  } catch {
    return false;
  }
}
