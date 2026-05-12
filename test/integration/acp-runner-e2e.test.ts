/**
 * E2E: ACP server wired to the REAL purrfect runner with a mock provider.
 *
 * Marketing claim under test: "runs in your editor via ACP." Existing
 * test/acp/server.test.ts only wires a fake runner. This proves the wiring
 * from AcpServer → createPurrfectRunner → AgentLoop → SessionStore works end
 * to end, the way Zed will actually invoke us.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";

import { AcpServer } from "../../src/acp/server.js";
import { createSessionAdapter } from "../../src/acp/session-adapter.js";
import { createPurrfectRunner } from "../../src/cli/acp.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import { loadConfig, loadConfigV2 } from "../../src/cli/config.js";
import {
  createMockFetch,
  makeSSEStream,
  makeStreamChunk,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

// ── SSE helpers ────────────────────────────────────────────────────────────
// The real ACP runner forces stream: true on its AgentLoop, so test mocks
// must serve OpenAI-style SSE payloads, not plain JSON.

function sseText(text: string): { stream: true; body: string } {
  return {
    stream: true,
    body: makeSSEStream([makeStreamChunk(text, undefined, "stop")]),
  };
}

function sseToolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
): { stream: true; body: string } {
  return {
    stream: true,
    body: makeSSEStream([
      makeStreamChunk(undefined, [
        { index: 0, id, function: { name, arguments: JSON.stringify(args) } },
      ]),
      makeStreamChunk(undefined, undefined, "tool_calls"),
    ]),
  };
}

class StreamPair {
  readonly inbound: Readable;
  readonly outbound: Writable;
  private outBuffer: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  constructor() {
    this.inbound = new Readable({ read() {} });
    this.outbound = new Writable({
      write: (chunk, _enc, cb) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        for (const line of text.split("\n")) if (line) this.deliver(line);
        cb();
      },
    });
  }

  send(msg: object): void {
    this.inbound.push(JSON.stringify(msg) + "\n", "utf-8");
  }

  next(): Promise<string> {
    return new Promise((resolve) => {
      if (this.outBuffer.length > 0) resolve(this.outBuffer.shift()!);
      else this.waiters.push(resolve);
    });
  }

  private deliver(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.outBuffer.push(line);
  }
}

async function findResponse(pair: StreamPair, id: number | string): Promise<any> {
  while (true) {
    const line = await pair.next();
    const parsed = JSON.parse(line);
    if (parsed.id === id) return parsed;
  }
}

function makeProvider(fetchFn: typeof fetch, model = "test-model"): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model },
    fetchFn,
  );
}

describe("Integration: ACP + real purrfect runner", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups) try { fn(); } catch { /* best effort */ }
    cleanups.length = 0;
  });

  it("init → newSession → prompt → assistant_text streams back + session persists in store", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const sessionStore = new SessionStore(join(tmp.path, "acp-sessions.db"));
    cleanups.push(() => sessionStore.close());

    const fetchFn = createMockFetch([
      sseText("hello from purrfect"),
    ]);
    const provider = makeProvider(fetchFn);

    const runner = createPurrfectRunner({
      sessionStore,
      provider,
      config: loadConfigV2(tmp.path),
      cliConfig: loadConfig(tmp.path),
      newSessionId: () => "purrfect-fixed-session",
    });

    const pair = new StreamPair();
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({ runner }),
    });
    cleanups.push(() => server.shutdown());

    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);

    pair.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    const newResp = await findResponse(pair, 2);
    const acpSessionId = newResp.result.sessionId;
    expect(typeof acpSessionId).toBe("string");

    pair.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: acpSessionId, prompt: "hi" },
    });

    let promptResp: any;
    let assistantText: string | undefined;
    while (!promptResp || !assistantText) {
      const line = await pair.next();
      const parsed = JSON.parse(line);
      if (parsed.id === 3) {
        promptResp = parsed;
      } else if (
        parsed.method === "session/update" &&
        parsed.params?.update?.kind === "assistant_text"
      ) {
        assistantText = parsed.params.update.text;
      }
    }

    expect(promptResp.result.stopReason).toBe("end_turn");
    expect(assistantText).toContain("hello from purrfect");

    // The runner persisted the conversation under the fixed purrfect session id.
    const sessions = sessionStore.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("purrfect-fixed-session");

    const messages = sessionStore.getMessages("purrfect-fixed-session");
    expect(messages.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(1);
    expect(messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(1);
  });

  it("two prompts on the same ACP session reuse the same purrfect session id (history grows)", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    const sessionStore = new SessionStore(join(tmp.path, "acp-sessions.db"));
    cleanups.push(() => sessionStore.close());

    const fetchFn = createMockFetch([
      sseText("first reply"),
      sseText("second reply"),
    ]);

    const runner = createPurrfectRunner({
      sessionStore,
      provider: makeProvider(fetchFn),
      config: loadConfigV2(tmp.path),
      cliConfig: loadConfig(tmp.path),
      newSessionId: () => "purrfect-fixed-session",
    });

    const pair = new StreamPair();
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({ runner }),
    });
    cleanups.push(() => server.shutdown());

    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);

    pair.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    const newResp = await findResponse(pair, 2);
    const acpSessionId = newResp.result.sessionId;

    // Turn 1
    pair.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: acpSessionId, prompt: "first" },
    });
    await findResponse(pair, 3);

    // Turn 2
    pair.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId: acpSessionId, prompt: "second" },
    });
    await findResponse(pair, 4);

    // Both turns landed in the same purrfect session.
    expect(sessionStore.listSessions().length).toBe(1);
    const messages = sessionStore.getMessages("purrfect-fixed-session");
    expect(messages.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(2);
    expect(messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(2);
  });

  it("ACP-driven tool call executes against the real ToolRegistry (file_read works)", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);

    // Drop a target file the agent will be asked to read.
    const targetPath = join(tmp.path, "hello.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "world", "utf-8");

    const sessionStore = new SessionStore(join(tmp.path, "acp-sessions.db"));
    cleanups.push(() => sessionStore.close());

    // Sequence: 1) tool call for file_read 2) final text using the result.
    const fetchFn = createMockFetch([
      sseToolCall("file_read", { path: targetPath }, "call_read"),
      sseText("the file says world"),
    ]);

    const runner = createPurrfectRunner({
      sessionStore,
      provider: makeProvider(fetchFn),
      config: loadConfigV2(tmp.path),
      cliConfig: loadConfig(tmp.path),
      newSessionId: () => "purrfect-fixed-session",
    });

    const pair = new StreamPair();
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({ runner }),
    });
    cleanups.push(() => server.shutdown());

    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);
    pair.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    const newResp = await findResponse(pair, 2);
    const acpSessionId = newResp.result.sessionId;

    pair.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: acpSessionId, prompt: "read hello.txt" },
    });

    let promptResp: any;
    let sawToolStart = false;
    let sawToolResult = false;
    let assistantText: string | undefined;
    while (!promptResp || !assistantText) {
      const line = await pair.next();
      const parsed = JSON.parse(line);
      if (parsed.id === 3) {
        promptResp = parsed;
      } else if (parsed.method === "session/update") {
        const kind = parsed.params?.update?.kind;
        if (kind === "tool_call_start") sawToolStart = true;
        if (kind === "tool_call_result") sawToolResult = true;
        if (kind === "assistant_text") assistantText = parsed.params.update.text;
      }
    }

    expect(promptResp.result.stopReason).toBe("end_turn");
    expect(sawToolStart).toBe(true);
    expect(sawToolResult).toBe(true);
    expect(assistantText).toContain("world");
  });
});
