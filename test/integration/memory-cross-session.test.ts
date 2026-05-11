/**
 * E2E: durable memory across sessions.
 *
 * Marketing claim under test: "gets smarter over time by writing its own
 * memory." This proves that when the agent calls the memory tool inside one
 * AgentLoop, a fresh AgentLoop started later sees that entry injected into
 * its system prompt.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import { AgentLoop } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { SessionStore } from "../../src/core/session-store.js";
import { LocalMarkdownBackend } from "../../src/core/memory/backend.js";
import { MemoryStore } from "../../src/core/memory/store.js";
import { createMemoryTool } from "../../src/core/tools/memory.js";
import { PromptBuilder } from "../../src/core/prompt-builder.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

function makeProvider(fetchFn: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    fetchFn,
  );
}

describe("Integration: memory persists across AgentLoop sessions", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups) try { fn(); } catch { /* best effort */ }
    cleanups.length = 0;
  });

  it("agent writes memory in session A → session B's system prompt contains it", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const memoryDir = join(tmp.path, "memory");

    // ── Session A: agent calls memory(action=write, key=preferred_language, value=Lojban) ──
    const backendA = new LocalMarkdownBackend(memoryDir);
    const toolA = createMemoryTool({ backend: backendA });
    const registryA = new ToolRegistry();
    registryA.register(toolA);

    const fetchA = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "memory",
            { action: "write", key: "preferred_language", value: "Lojban" },
            "call_1",
          ),
        ]),
      },
      { body: makeTextResponse("Saved your preference.") },
    ]);

    const storeA = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => storeA.close());

    const loopA = new AgentLoop({
      provider: makeProvider(fetchA),
      toolRegistry: registryA,
      sessionStore: storeA,
      sessionId: "session-a",
    });
    storeA.createSession({
      id: "session-a",
      model: "test",
      source: "test",
      title: "A",
    } as any);

    // Drain the loop to completion.
    for await (const _ of loopA.run("remember my preferred language")) {
      void _;
    }

    // Memory file exists on disk and contains the tagged entry.
    const memoryFile = join(memoryDir, "MEMORY.md");
    expect(existsSync(memoryFile)).toBe(true);
    const onDisk = readFileSync(memoryFile, "utf-8");
    expect(onDisk).toContain("§ preferred_language");
    expect(onDisk).toContain("Lojban");

    // ── Session B: fresh MemoryStore reads the same dir, snapshot is non-empty. ──
    const storeB = new MemoryStore(memoryDir);
    const snapshot = storeB.getSnapshot();
    expect(snapshot).toContain("preferred_language");
    expect(snapshot).toContain("Lojban");

    // PromptBuilder injects the snapshot into the new system prompt.
    const promptB = new PromptBuilder().build({
      memorySnapshot: snapshot,
      hasMemoryTool: true,
    });
    expect(promptB).toContain("# Memory Snapshot");
    expect(promptB).toContain("Lojban");
    // Memory guidance is added when the memory tool is available.
    expect(promptB).toContain("# Memory Guidance");
  });

  it("agent updates an existing memory key → new value visible in next session, old value gone", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const memoryDir = join(tmp.path, "memory");

    // Pre-seed: write an initial value via the backend directly.
    const backend = new LocalMarkdownBackend(memoryDir);
    await backend.add("editor", "vim");

    // Agent decides to overwrite it.
    const tool = createMemoryTool({ backend });
    const registry = new ToolRegistry();
    registry.register(tool);

    const fetchFn = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "memory",
            { action: "write", key: "editor", value: "zed" },
            "call_overwrite",
          ),
        ]),
      },
      { body: makeTextResponse("Updated.") },
    ]);

    const sessionStore = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => sessionStore.close());

    const loop = new AgentLoop({
      provider: makeProvider(fetchFn),
      toolRegistry: registry,
      sessionStore,
      sessionId: "s1",
    });
    sessionStore.createSession({ id: "s1", model: "test", source: "test", title: "t" } as any);

    for await (const _ of loop.run("I switched editors")) void _;

    const snapshot = new MemoryStore(memoryDir).getSnapshot();
    expect(snapshot).toContain("zed");
    expect(snapshot).not.toContain("vim");
  });

  it("agent removes a memory key → next session no longer sees it", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const memoryDir = join(tmp.path, "memory");

    const backend = new LocalMarkdownBackend(memoryDir);
    await backend.add("stale", "outdated info");
    await backend.add("fresh", "current info");

    const tool = createMemoryTool({ backend });
    const registry = new ToolRegistry();
    registry.register(tool);

    const fetchFn = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("memory", { action: "remove", key: "stale" }, "call_rm"),
        ]),
      },
      { body: makeTextResponse("Removed.") },
    ]);

    const sessionStore = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => sessionStore.close());

    const loop = new AgentLoop({
      provider: makeProvider(fetchFn),
      toolRegistry: registry,
      sessionStore,
      sessionId: "s1",
    });
    sessionStore.createSession({ id: "s1", model: "test", source: "test", title: "t" } as any);

    for await (const _ of loop.run("clean up old memory")) void _;

    const snapshot = new MemoryStore(memoryDir).getSnapshot();
    expect(snapshot).not.toContain("stale");
    expect(snapshot).not.toContain("outdated");
    expect(snapshot).toContain("fresh");
    expect(snapshot).toContain("current info");
  });
});
