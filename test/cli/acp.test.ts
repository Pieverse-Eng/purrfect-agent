import { describe, it, expect, vi } from "vitest";
import { createPurrfectRunner } from "../../src/cli/acp.js";

/**
 * Minimal SessionStore stub that just counts createSession calls.
 *
 * The runner constructs an AgentLoop and calls .run() — which would talk to
 * a real provider. We pre-abort the signal so .run() exits before any real
 * work happens; that's enough for this regression test, which only cares
 * about whether the runner creates one or two purrfect sessions for two
 * prompts on the same ACP session.
 */
function makeFakeSessionStore() {
  const created: Array<{ id: string; title?: string }> = [];
  const messages = new Map<string, any[]>();

  return {
    created,
    store: {
      createSession(opts: any) {
        created.push({ id: opts.id, title: opts.title });
        messages.set(opts.id, []);
        return opts.id;
      },
      getMessages(id: string) {
        return messages.get(id) ?? [];
      },
      appendMessage(id: string, msg: any) {
        const arr = messages.get(id) ?? [];
        arr.push(msg);
        messages.set(id, arr);
      },
    } as any,
  };
}

function makeFakeProvider() {
  return {
    chat: vi.fn().mockRejectedValue(new Error("test-only provider")),
    chatStream: vi.fn(async function* () {
      throw new Error("test-only provider");
    }),
  } as any;
}

describe("createPurrfectRunner — session reuse", () => {
  it("reuses the same purrfect session id across multiple prompts on the same ACP session", async () => {
    const { store, created } = makeFakeSessionStore();
    const provider = makeFakeProvider();

    let counter = 0;
    const runner = createPurrfectRunner({
      sessionStore: store,
      provider,
      config: { sandbox: "none" } as any,
      cliConfig: { model: "test", baseUrl: "http://x", apiKey: "k", skillsDir: "" } as any,
      newSessionId: () => `purrfect-${++counter}`,
    });

    const acpSessionId = "acp-session-1";

    // Pre-aborted signal so AgentLoop.run() exits without doing any work.
    const aborted = new AbortController();
    aborted.abort();

    await runner.runTurn({
      sessionId: acpSessionId,
      prompt: "first",
      workingDirectory: "/tmp",
      signal: aborted.signal,
      onUpdate: () => {},
    });
    await runner.runTurn({
      sessionId: acpSessionId,
      prompt: "second",
      workingDirectory: "/tmp",
      signal: aborted.signal,
      onUpdate: () => {},
    });

    expect(created).toHaveLength(1);
    expect(created[0].id).toBe("purrfect-1");
  });

  it("creates a fresh purrfect session for each distinct ACP session", async () => {
    const { store, created } = makeFakeSessionStore();
    const provider = makeFakeProvider();

    let counter = 0;
    const runner = createPurrfectRunner({
      sessionStore: store,
      provider,
      config: { sandbox: "none" } as any,
      cliConfig: { model: "test", baseUrl: "http://x", apiKey: "k", skillsDir: "" } as any,
      newSessionId: () => `purrfect-${++counter}`,
    });

    const aborted = new AbortController();
    aborted.abort();

    await runner.runTurn({
      sessionId: "acp-A",
      prompt: "x",
      workingDirectory: "/tmp",
      signal: aborted.signal,
      onUpdate: () => {},
    });
    await runner.runTurn({
      sessionId: "acp-B",
      prompt: "y",
      workingDirectory: "/tmp",
      signal: aborted.signal,
      onUpdate: () => {},
    });

    expect(created.map((c) => c.id)).toEqual(["purrfect-1", "purrfect-2"]);
  });

  it("closeSession drops the mapping so the next prompt starts fresh", async () => {
    const { store, created } = makeFakeSessionStore();
    const provider = makeFakeProvider();

    let counter = 0;
    const runner = createPurrfectRunner({
      sessionStore: store,
      provider,
      config: { sandbox: "none" } as any,
      cliConfig: { model: "test", baseUrl: "http://x", apiKey: "k", skillsDir: "" } as any,
      newSessionId: () => `purrfect-${++counter}`,
    });

    const aborted = new AbortController();
    aborted.abort();

    await runner.runTurn({
      sessionId: "acp-A",
      prompt: "x",
      workingDirectory: "/tmp",
      signal: aborted.signal,
      onUpdate: () => {},
    });
    runner.closeSession?.("acp-A");
    await runner.runTurn({
      sessionId: "acp-A",
      prompt: "y",
      workingDirectory: "/tmp",
      signal: aborted.signal,
      onUpdate: () => {},
    });

    expect(created.map((c) => c.id)).toEqual(["purrfect-1", "purrfect-2"]);
  });
});
