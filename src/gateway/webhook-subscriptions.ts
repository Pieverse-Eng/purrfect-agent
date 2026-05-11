/**
 * Webhook subscription store.
 *
 * Persists outbound webhook subscriptions so the agent can declare
 * which external event sources it cares about (GitHub, Linear, Grafana, etc).
 *
 * Inbound deliveries POST to `/webhook/<id>` on the WebhookAdapter, which
 * verifies the HMAC signature against the subscription's secret and routes
 * the event to the configured chat / session / profile.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface WebhookSubscription {
  id: string;
  url: string;
  event: string;
  secret: string;
  /** Optional chatId to route inbound events into the message handler. */
  chatId?: string;
  /** Optional session to route into. */
  sessionId?: string;
  /** Optional profile to route into. */
  profile?: string;
  /** Header containing the event name on inbound (default X-Event-Name). */
  eventHeader?: string;
  /** Header containing the HMAC signature (default X-Hub-Signature-256). */
  signatureHeader?: string;
  createdAt: number;
}

export interface CreateSubscriptionInput {
  url: string;
  event: string;
  secret?: string;
  chatId?: string;
  sessionId?: string;
  profile?: string;
  eventHeader?: string;
  signatureHeader?: string;
}

export class WebhookSubscriptionStore {
  private readonly path: string;
  private subscriptions: WebhookSubscription[] = [];

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  list(): WebhookSubscription[] {
    return this.subscriptions.map((s) => ({ ...s }));
  }

  get(id: string): WebhookSubscription | undefined {
    const found = this.subscriptions.find((s) => s.id === id);
    return found ? { ...found } : undefined;
  }

  add(input: CreateSubscriptionInput): WebhookSubscription {
    if (!input.url) throw new Error("url is required");
    if (!input.event) throw new Error("event is required");

    const sub: WebhookSubscription = {
      id: randomUUID(),
      url: input.url,
      event: input.event,
      secret: input.secret ?? randomBytes(32).toString("hex"),
      chatId: input.chatId,
      sessionId: input.sessionId,
      profile: input.profile,
      eventHeader: input.eventHeader,
      signatureHeader: input.signatureHeader,
      createdAt: Date.now(),
    };

    this.subscriptions = [...this.subscriptions, sub];
    this.save();
    return { ...sub };
  }

  remove(id: string): boolean {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
    if (this.subscriptions.length === before) return false;
    this.save();
    return true;
  }

  /** Find by id prefix — convenience for CLI usage. */
  findByIdPrefix(prefix: string): WebhookSubscription[] {
    return this.subscriptions
      .filter((s) => s.id.startsWith(prefix))
      .map((s) => ({ ...s }));
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.subscriptions = [];
      return;
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.subscriptions = parsed.filter(isSubscription);
      } else {
        this.subscriptions = [];
      }
    } catch {
      this.subscriptions = [];
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.subscriptions, null, 2), "utf-8");
  }
}

function isSubscription(value: unknown): value is WebhookSubscription {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.url === "string" &&
    typeof v.event === "string" &&
    typeof v.secret === "string" &&
    typeof v.createdAt === "number"
  );
}
