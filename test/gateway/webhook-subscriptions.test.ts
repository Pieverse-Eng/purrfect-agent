import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebhookSubscriptionStore } from "../../src/gateway/webhook-subscriptions.js";

describe("WebhookSubscriptionStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webhook-subs-"));
    path = join(dir, "webhooks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when no file exists", () => {
    const store = new WebhookSubscriptionStore(path);
    expect(store.list()).toEqual([]);
  });

  it("adds a subscription with auto-generated id and secret", () => {
    const store = new WebhookSubscriptionStore(path);
    const sub = store.add({
      url: "https://github.com/foo/bar",
      event: "push",
    });

    expect(sub.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sub.url).toBe("https://github.com/foo/bar");
    expect(sub.event).toBe("push");
    expect(sub.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(sub.createdAt).toBeGreaterThan(0);

    expect(store.list()).toHaveLength(1);
  });

  it("uses caller-provided secret when supplied", () => {
    const store = new WebhookSubscriptionStore(path);
    const sub = store.add({ url: "u", event: "e", secret: "my-secret" });
    expect(sub.secret).toBe("my-secret");
  });

  it("persists to disk and reloads on next instance", () => {
    const a = new WebhookSubscriptionStore(path);
    const sub = a.add({ url: "u", event: "e" });
    expect(existsSync(path)).toBe(true);

    const b = new WebhookSubscriptionStore(path);
    expect(b.list()).toHaveLength(1);
    expect(b.get(sub.id)?.url).toBe("u");
  });

  it("removes by id", () => {
    const store = new WebhookSubscriptionStore(path);
    const sub = store.add({ url: "u", event: "e" });
    expect(store.remove(sub.id)).toBe(true);
    expect(store.remove(sub.id)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("rejects invalid JSON file gracefully", () => {
    const a = new WebhookSubscriptionStore(path);
    a.add({ url: "u", event: "e" });
    writeFileSync(path, "not json", "utf-8");
    const b = new WebhookSubscriptionStore(path);
    expect(b.list()).toEqual([]);
  });

  it("requires url and event", () => {
    const store = new WebhookSubscriptionStore(path);
    expect(() => store.add({ url: "", event: "e" })).toThrow(/url is required/);
    expect(() => store.add({ url: "u", event: "" })).toThrow(/event is required/);
  });

  it("findByIdPrefix matches partial ids", () => {
    const store = new WebhookSubscriptionStore(path);
    const sub = store.add({ url: "u", event: "e" });
    const matches = store.findByIdPrefix(sub.id.slice(0, 8));
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(sub.id);
  });

  it("written file is valid JSON array", () => {
    const store = new WebhookSubscriptionStore(path);
    store.add({ url: "u", event: "e" });
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });
});
