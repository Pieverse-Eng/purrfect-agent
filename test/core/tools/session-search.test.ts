import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { SessionStore } from "../../../src/core/session-store.js";
import { createSessionSearchTool } from "../../../src/core/tools/session-search.js";
import { ToolRegistry } from "../../../src/core/tool-registry.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;

beforeEach(() => {
  tmpDir = createTempDir("session-search-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("session_search tool", () => {
  it("matching query returns results with session_id and timestamp", async () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "Deploy a Docker container to production" });
    store.appendMessage("s1", { role: "assistant", content: "Sure, here are the steps." });

    const tool = createSessionSearchTool(store);
    const result = JSON.parse(await tool.handler({ query: "Docker" }));

    expect(result.matches).toBeDefined();
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    const match = result.matches[0];
    expect(match.session_id).toBe("s1");
    expect(match.timestamp).toBeTypeOf("number");
    expect(match.content).toContain("Docker");
  });

  it("returns results from multiple sessions", async () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "Kubernetes cluster setup" });

    store.createSession({ id: "s2", model: "gpt-4", source: "telegram" });
    store.appendMessage("s2", { role: "user", content: "Kubernetes networking guide" });

    const tool = createSessionSearchTool(store);
    const result = JSON.parse(await tool.handler({ query: "Kubernetes" }));

    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    const sessionIds = result.matches.map((m: { session_id: string }) => m.session_id);
    expect(sessionIds).toContain("s1");
    expect(sessionIds).toContain("s2");
  });

  it("no matches returns empty array", async () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "Hello world" });

    const tool = createSessionSearchTool(store);
    const result = JSON.parse(await tool.handler({ query: "nonexistentxyz" }));

    expect(result.matches).toEqual([]);
  });

  it("empty query returns empty array", async () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "Some content here" });

    const tool = createSessionSearchTool(store);
    const result = JSON.parse(await tool.handler({ query: "" }));

    expect(result.matches).toEqual([]);
  });

  it("registers and dispatches via ToolRegistry", async () => {
    store.createSession({ id: "s1", model: "gpt-4", source: "cli" });
    store.appendMessage("s1", { role: "user", content: "Test registry dispatch" });

    const registry = new ToolRegistry();
    const tool = createSessionSearchTool(store);
    registry.register(tool);

    expect(registry.getAllToolNames()).toContain("session_search");

    const raw = await registry.dispatch("session_search", { query: "registry" });
    const result = JSON.parse(raw);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].content).toContain("registry");
  });
});
