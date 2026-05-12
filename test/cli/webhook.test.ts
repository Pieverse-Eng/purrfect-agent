import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWebhookArgs, runWebhookCommand } from "../../src/cli/webhook.js";

describe("webhook CLI args parser", () => {
  it("defaults to list", () => {
    expect(parseWebhookArgs([])).toEqual({ kind: "list" });
    expect(parseWebhookArgs(["list"])).toEqual({ kind: "list" });
  });

  it("parses subscribe with required event", () => {
    const action = parseWebhookArgs([
      "subscribe",
      "https://github.com/foo",
      "--event",
      "push",
    ]);
    expect(action).toEqual({
      kind: "subscribe",
      url: "https://github.com/foo",
      event: "push",
      secret: undefined,
      chatId: undefined,
      sessionId: undefined,
      profile: undefined,
      signatureHeader: undefined,
      eventHeader: undefined,
    });
  });

  it("parses subscribe with all options", () => {
    const action = parseWebhookArgs([
      "subscribe",
      "https://x",
      "--event",
      "alert",
      "--secret",
      "shh",
      "--chat-id",
      "ops",
      "--session",
      "s1",
      "--profile",
      "dev",
      "--signature-header",
      "x-grafana-sig",
      "--event-header",
      "x-grafana-event",
    ]);
    expect(action).toMatchObject({
      kind: "subscribe",
      url: "https://x",
      event: "alert",
      secret: "shh",
      chatId: "ops",
      sessionId: "s1",
      profile: "dev",
      signatureHeader: "x-grafana-sig",
      eventHeader: "x-grafana-event",
    });
  });

  it("rejects subscribe without url or event", () => {
    expect(() => parseWebhookArgs(["subscribe"])).toThrow();
    expect(() => parseWebhookArgs(["subscribe", "url-only"])).toThrow(/--event/);
  });

  it("parses remove", () => {
    expect(parseWebhookArgs(["remove", "abc-123"])).toEqual({
      kind: "remove",
      id: "abc-123",
    });
    expect(() => parseWebhookArgs(["remove"])).toThrow();
  });

  it("rejects unknown subcommands", () => {
    expect(() => parseWebhookArgs(["nonsense"])).toThrow(/Unknown webhook subcommand/);
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseWebhookArgs(["subscribe", "u", "--event", "e", "--what"]),
    ).toThrow(/Unknown flag/);
  });
});

describe("runWebhookCommand", () => {
  let dir: string;
  let lines: string[];
  const out = (t: string) => lines.push(t);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webhook-cli-"));
    lines = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("subscribe writes a record and prints id + secret", async () => {
    await runWebhookCommand(
      { kind: "subscribe", url: "u", event: "e" },
      { configDir: dir, output: out },
    );
    const stored = JSON.parse(readFileSync(join(dir, "webhooks.json"), "utf-8"));
    expect(stored).toHaveLength(1);
    expect(lines.some((l) => l.includes("Subscribed to e from u"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  id:"))).toBe(true);
  });

  it("list shows configured subscriptions", async () => {
    await runWebhookCommand(
      { kind: "subscribe", url: "u1", event: "push" },
      { configDir: dir, output: out },
    );
    lines = [];
    await runWebhookCommand({ kind: "list" }, { configDir: dir, output: out });
    expect(lines.join("\n")).toContain("push");
    expect(lines.join("\n")).toContain("u1");
  });

  it("list reports empty when nothing configured", async () => {
    await runWebhookCommand({ kind: "list" }, { configDir: dir, output: out });
    expect(lines.join("\n")).toContain("No webhook subscriptions");
  });

  it("remove by full id", async () => {
    await runWebhookCommand(
      { kind: "subscribe", url: "u", event: "e" },
      { configDir: dir, output: out },
    );
    const stored = JSON.parse(readFileSync(join(dir, "webhooks.json"), "utf-8"));
    const id = stored[0].id;

    lines = [];
    await runWebhookCommand({ kind: "remove", id }, { configDir: dir, output: out });
    expect(lines.join("\n")).toContain("Removed");
    const after = JSON.parse(readFileSync(join(dir, "webhooks.json"), "utf-8"));
    expect(after).toHaveLength(0);
  });

  it("remove by id prefix", async () => {
    await runWebhookCommand(
      { kind: "subscribe", url: "u", event: "e" },
      { configDir: dir, output: out },
    );
    const stored = JSON.parse(readFileSync(join(dir, "webhooks.json"), "utf-8"));
    const prefix = stored[0].id.slice(0, 8);

    await runWebhookCommand(
      { kind: "remove", id: prefix },
      { configDir: dir, output: out },
    );
    const after = JSON.parse(readFileSync(join(dir, "webhooks.json"), "utf-8"));
    expect(after).toHaveLength(0);
  });

  it("remove unknown id throws", async () => {
    await expect(
      runWebhookCommand({ kind: "remove", id: "nope" }, { configDir: dir, output: out }),
    ).rejects.toThrow(/not found/);
  });
});
