import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MessageEvent } from "../../../src/gateway/adapter.js";
import { WebhookSubscriptionStore } from "../../../src/gateway/webhook-subscriptions.js";

// ---------------------------------------------------------------------------
// Mock node:http
// ---------------------------------------------------------------------------
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

import { WebhookAdapter } from "../../../src/gateway/adapters/webhook.js";

/**
 * Simulate a POST request and return the res mock object.
 * The response may not be completed immediately (it waits for adapter.send()).
 */
function createPostSimulation(
  path: string,
  body: object | string,
  headers: Record<string, string> = {},
): { res: any; completed: Promise<{ statusCode: number; body: string }> } {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);

  const req = {
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    on(event: string, cb: (data?: any) => void) {
      if (event === "data") cb(Buffer.from(rawBody));
      if (event === "end") cb();
      return req;
    },
  };

  let resolveCompleted: (value: { statusCode: number; body: string }) => void;
  const completed = new Promise<{ statusCode: number; body: string }>((resolve) => {
    resolveCompleted = resolve;
  });

  const res = {
    statusCode: 200,
    body: "",
    writableEnded: false,
    headers: {} as Record<string, string>,
    writeHead(code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      if (hdrs) Object.assign(this.headers, hdrs);
      return this;
    },
    end(data?: string) {
      this.body = data ?? "";
      this.writableEnded = true;
      resolveCompleted!({ statusCode: this.statusCode, body: this.body });
    },
  };

  httpRequestHandler(req, res);

  return { res, completed };
}

/**
 * Simulates a POST that is expected to complete synchronously (e.g. error responses).
 */
function simulatePost(
  path: string,
  body: object | string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return createPostSimulation(path, body, headers).completed;
}

function hmac(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("WebhookAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /message emits a MessageEvent and waits for send()", async () => {
    const adapter = new WebhookAdapter({ port: 8080 });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const { res, completed } = createPostSimulation("/message", {
      text: "hello webhook",
      userId: "user-1",
      chatId: "chat-1",
    });

    // The message handler should have been called
    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.text).toBe("hello webhook");
    expect(event.source.platform).toBe("webhook");
    expect(event.source.userId).toBe("user-1");
    expect(event.source.chatId).toBe("chat-1");

    // Response should NOT be completed yet (waiting for send())
    expect(res.writableEnded).toBe(false);

    // Now simulate the agent calling send()
    await adapter.send("chat-1", "Agent response content");

    // Now the HTTP response should be completed
    const result = await completed;
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe("Agent response content");
  });

  it("rejects requests with invalid auth token", async () => {
    const adapter = new WebhookAdapter({ port: 8080, authToken: "secret-123" });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const result = await simulatePost(
      "/message",
      { text: "hello", userId: "user-1" },
      { authorization: "Bearer wrong-token" },
    );

    expect(result.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 when text is missing", async () => {
    const adapter = new WebhookAdapter({ port: 8080 });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const result = await simulatePost("/message", {
      userId: "user-1",
    });

    expect(result.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("defaults chatId to userId when chatId is not provided", async () => {
    const adapter = new WebhookAdapter({ port: 8080 });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect();

    const { completed } = createPostSimulation("/message", {
      text: "no chat id",
      userId: "user-42",
    });

    expect(handler).toHaveBeenCalledOnce();
    const event: MessageEvent = handler.mock.calls[0][0];
    expect(event.source.chatId).toBe("user-42");
    expect(event.source.chatType).toBe("dm");

    // Complete the response
    await adapter.send("user-42", "ok");
    const result = await completed;
    expect(result.statusCode).toBe(200);
  });

  it("POST → wait for send() → HTTP response contains agent content (Issue #8)", async () => {
    const adapter = new WebhookAdapter({ port: 8080 });
    const receivedEvents: MessageEvent[] = [];
    adapter.onMessage((event) => receivedEvents.push(event));
    await adapter.connect();

    const { res, completed } = createPostSimulation("/message", {
      text: "What is 2+2?",
      userId: "user-1",
      chatId: "calc-chat",
    });

    // Message is emitted
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].text).toBe("What is 2+2?");

    // HTTP response is still pending
    expect(res.writableEnded).toBe(false);

    // Agent processes and calls send()
    const sendResult = await adapter.send("calc-chat", "The answer is 4.");

    expect(sendResult.success).toBe(true);

    // HTTP response should now contain the agent content
    const httpResult = await completed;
    expect(httpResult.statusCode).toBe(200);
    const body = JSON.parse(httpResult.body);
    expect(body.content).toBe("The answer is 4.");
    expect(body.ok).toBe(true);
  });

  describe("subscription event delivery", () => {
    let dir: string;
    let storePath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "webhook-adapter-"));
      storePath = join(dir, "webhooks.json");
    });

    function cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    }

    it("returns 404 when subscription store is not configured", async () => {
      const adapter = new WebhookAdapter({ port: 8080 });
      adapter.onMessage(vi.fn());
      await adapter.connect();

      const result = await simulatePost("/webhook/anything", { foo: "bar" });
      expect(result.statusCode).toBe(404);
      cleanup();
    });

    it("returns 404 when subscription id does not exist", async () => {
      const subscriptions = new WebhookSubscriptionStore(storePath);
      const adapter = new WebhookAdapter({ port: 8080, subscriptions });
      adapter.onMessage(vi.fn());
      await adapter.connect();

      const result = await simulatePost("/webhook/missing-id", { foo: "bar" });
      expect(result.statusCode).toBe(404);
      cleanup();
    });

    it("rejects request with missing or invalid HMAC", async () => {
      const subscriptions = new WebhookSubscriptionStore(storePath);
      const sub = subscriptions.add({ url: "u", event: "push", secret: "s3cret" });
      const adapter = new WebhookAdapter({ port: 8080, subscriptions });
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.connect();

      const noSig = await simulatePost(`/webhook/${sub.id}`, { ref: "main" });
      expect(noSig.statusCode).toBe(401);

      const bad = await simulatePost(
        `/webhook/${sub.id}`,
        { ref: "main" },
        { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      );
      expect(bad.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
      cleanup();
    });

    it("accepts valid HMAC and emits MessageEvent", async () => {
      const subscriptions = new WebhookSubscriptionStore(storePath);
      const sub = subscriptions.add({
        url: "https://github.com/foo/bar",
        event: "push",
        secret: "s3cret",
        chatId: "ops-room",
      });
      const adapter = new WebhookAdapter({ port: 8080, subscriptions });
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.connect();

      const body = JSON.stringify({ ref: "main", commits: 3 });
      const result = await simulatePost(`/webhook/${sub.id}`, body, {
        "x-hub-signature-256": hmac("s3cret", body),
        "x-event-name": "push",
      });

      expect(result.statusCode).toBe(202);
      expect(handler).toHaveBeenCalledOnce();
      const event: MessageEvent = handler.mock.calls[0][0];
      expect(event.source.platform).toBe("webhook");
      expect(event.source.chatId).toBe("ops-room");
      expect(event.text).toContain("[webhook:push]");
      expect(event.text).toContain('"commits":3');
      cleanup();
    });

    it("respects custom signatureHeader and eventHeader", async () => {
      const subscriptions = new WebhookSubscriptionStore(storePath);
      const sub = subscriptions.add({
        url: "u",
        event: "alert",
        secret: "s3cret",
        signatureHeader: "x-grafana-signature",
        eventHeader: "x-grafana-event",
      });
      const adapter = new WebhookAdapter({ port: 8080, subscriptions });
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.connect();

      const body = JSON.stringify({ severity: "critical" });
      const result = await simulatePost(`/webhook/${sub.id}`, body, {
        "x-grafana-signature": hmac("s3cret", body),
        "x-grafana-event": "fire",
      });

      expect(result.statusCode).toBe(202);
      const event: MessageEvent = handler.mock.calls[0][0];
      expect(event.text).toContain("[webhook:fire]");
      cleanup();
    });
  });
});
