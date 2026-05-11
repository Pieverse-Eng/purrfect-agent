import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MessageHandler } from "../../src/gateway/handler.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { validateConfig } from "../../src/core/config-schema.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = join(tmpdir(), `handler-stop-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("MessageHandler.fireStopHooks", () => {
  it("runs configured stop hooks", async () => {
    const dir = makeTempDir();
    const flagPath = join(dir, "stop-fired.txt");

    const config = validateConfig({
      hooks: {
        preToolUse: [],
        postToolUse: [],
        stop: [
          { matcher: "*", command: `echo fired > ${flagPath}`, onFailure: "log" },
        ],
      },
    });

    const provider = new HttpProvider(
      { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      (async () => new Response("{}")) as unknown as typeof fetch,
    );
    const store = new SessionStore(join(dir, "sessions.db"));

    const handler = new MessageHandler({
      provider,
      sessionStore: store,
      toolRegistry: new ToolRegistry(),
      sessionPolicy: "never",
      config,
    });

    await handler.fireStopHooks();
    store.close();

    expect(existsSync(flagPath)).toBe(true);
    expect(readFileSync(flagPath, "utf-8").trim()).toBe("fired");
  });

  it("no-ops when no hooks configured", async () => {
    const dir = makeTempDir();
    const config = validateConfig({});
    const provider = new HttpProvider(
      { baseUrl: "https://api.test/v1", apiKey: "sk", model: "m" },
      (async () => new Response("{}")) as unknown as typeof fetch,
    );
    const store = new SessionStore(join(dir, "sessions.db"));
    const handler = new MessageHandler({
      provider,
      sessionStore: store,
      toolRegistry: new ToolRegistry(),
      sessionPolicy: "never",
      config,
    });

    await expect(handler.fireStopHooks()).resolves.toBeUndefined();
    store.close();
  });
});
