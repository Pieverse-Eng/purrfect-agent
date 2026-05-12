import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";
import { generateSessionRecap } from "../../src/core/session-resume.js";
import { AgentLoop } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";
import type { AgentEvent } from "../../src/core/agent-loop.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;

beforeEach(() => {
  tmpDir = createTempDir("session-resume-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("generateSessionRecap", () => {
  it("returns formatted recap with messages", () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "Hello there" });
    store.appendMessage("s1", { role: "assistant", content: "Hi! How can I help?" });
    store.appendMessage("s1", { role: "user", content: "Tell me about TypeScript" });

    const recap = generateSessionRecap(store, "s1");

    expect(recap).toContain("Previous conversation:");
    expect(recap).toContain("- User: Hello there");
    expect(recap).toContain("- Assistant: Hi! How can I help?");
    expect(recap).toContain("- User: Tell me about TypeScript");
    expect(recap).toContain("[3 messages total]");
  });

  it("returns empty string for session with no messages", () => {
    store.createSession({ id: "s-empty", model: "gpt-4", source: "cli" });

    const recap = generateSessionRecap(store, "s-empty");

    expect(recap).toBe("");
  });

  it("truncates long message content", () => {
    store.createSession({ id: "s-long", model: "gpt-4", source: "cli" });
    const longContent = "A".repeat(500);
    store.appendMessage("s-long", { role: "user", content: longContent });

    const recap = generateSessionRecap(store, "s-long");

    // Should contain truncated content, not the full 500 chars
    expect(recap).toContain("- User: " + "A".repeat(100) + "...");
    expect(recap).not.toContain("A".repeat(500));
  });

  it("original system prompt preserved when recap injected", async () => {
    // Set up a previous session with messages
    store.createSession({ id: "prev", model: "gpt-4", source: "cli" });
    store.appendMessage("prev", { role: "user", content: "Old question" });
    store.appendMessage("prev", { role: "assistant", content: "Old answer" });

    // Create a new session for the resumed conversation
    store.createSession({ id: "new", model: "gpt-4", source: "cli" });

    const mockFetch = createMockFetch([{ body: makeTextResponse("Resumed!") }]);
    const provider = new HttpProvider(
      { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
      mockFetch,
    );
    const registry = new ToolRegistry();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      sessionStore: store,
      sessionId: "new",
      resumeSessionId: "prev",
    });

    const events: AgentEvent[] = [];
    for await (const ev of loop.run("Continue working")) {
      events.push(ev);
    }

    // Verify recap was sent as a system message
    const calls = (mockFetch as any).calls;
    const sentBody = JSON.parse(calls[0].init.body as string);
    const systemMsg = sentBody.messages.find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain("Previous conversation:");
    expect(systemMsg.content).toContain("Old question");

    // User message is still present and separate
    const userMsg = sentBody.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Continue working");
  });

  it("recap injected before user input in message order", async () => {
    store.createSession({ id: "prev2", model: "gpt-4", source: "cli" });
    store.appendMessage("prev2", { role: "user", content: "First msg" });
    store.appendMessage("prev2", { role: "assistant", content: "First reply" });

    store.createSession({ id: "new2", model: "gpt-4", source: "cli" });

    const mockFetch = createMockFetch([{ body: makeTextResponse("OK") }]);
    const provider = new HttpProvider(
      { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
      mockFetch,
    );
    const registry = new ToolRegistry();

    const loop = new AgentLoop({
      provider,
      toolRegistry: registry,
      sessionStore: store,
      sessionId: "new2",
      resumeSessionId: "prev2",
    });

    const events: AgentEvent[] = [];
    for await (const ev of loop.run("New question")) {
      events.push(ev);
    }

    // Verify message ordering: system (recap) comes before user
    const calls = (mockFetch as any).calls;
    const sentBody = JSON.parse(calls[0].init.body as string);
    const msgs = sentBody.messages;

    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("Previous conversation:");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toBe("New question");

    // Completion should still work
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
  });
});
