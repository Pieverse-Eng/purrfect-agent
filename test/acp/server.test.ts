import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  AcpServer,
  ACP_PROTOCOL_VERSION,
} from "../../src/acp/server.js";
import type {
  PurrfectAgentRunner,
  SessionUpdate,
} from "../../src/acp/session-adapter.js";
import { createSessionAdapter } from "../../src/acp/session-adapter.js";

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
        for (const line of text.split("\n")) {
          if (line) this.deliver(line);
        }
        cb();
      },
    });
  }

  send(msg: object): void {
    this.inbound.push(JSON.stringify(msg) + "\n", "utf-8");
  }

  next(): Promise<string> {
    return new Promise((resolve) => {
      if (this.outBuffer.length > 0) {
        resolve(this.outBuffer.shift()!);
      } else {
        this.waiters.push(resolve);
      }
    });
  }

  private deliver(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.outBuffer.push(line);
  }
}

function makeRunner(behavior: PurrfectAgentRunner["runTurn"]): PurrfectAgentRunner {
  return { runTurn: behavior };
}

async function findResponse(pair: StreamPair, id: number | string): Promise<any> {
  while (true) {
    const line = await pair.next();
    const parsed = JSON.parse(line);
    if (parsed.id === id) return parsed;
  }
}

describe("AcpServer", () => {
  it("rejects session/* before initialize", async () => {
    const pair = new StreamPair();
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({
        runner: makeRunner(async () => ({ stopReason: "end_turn" })),
      }),
    });
    pair.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    const resp = await findResponse(pair, 1);
    expect(resp.error.message).toMatch(/not initialized/);
    server.shutdown();
  });

  it("initialize returns protocol version + agent info + capabilities", async () => {
    const pair = new StreamPair();
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({
        runner: makeRunner(async () => ({ stopReason: "end_turn" })),
      }),
      agent: { name: "test", version: "1.0" },
    });
    pair.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: ACP_PROTOCOL_VERSION, capabilities: { permission: true } },
    });
    const resp = await findResponse(pair, 1);
    expect(resp.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(resp.result.agent).toEqual({ name: "test", version: "1.0" });
    expect(resp.result.capabilities.permission).toBe(true);
    server.shutdown();
  });

  it("session/new + session/prompt streams updates and returns stop_reason", async () => {
    const pair = new StreamPair();
    const updates: SessionUpdate[] = [];
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({
        runner: makeRunner(async ({ prompt, onUpdate }) => {
          updates.push({ kind: "assistant_text", text: `echo: ${String(prompt)}` });
          onUpdate({ kind: "assistant_text", text: `echo: ${String(prompt)}` });
          return { stopReason: "end_turn" };
        }),
      }),
    });

    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);

    pair.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { workingDirectory: "/tmp" },
    });
    const newResp = await findResponse(pair, 2);
    const sessionId = newResp.result.sessionId;
    expect(typeof sessionId).toBe("string");

    pair.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: "hi" },
    });

    let promptResp: any;
    let updateLine: any;
    while (!promptResp || !updateLine) {
      const line = await pair.next();
      const parsed = JSON.parse(line);
      if (parsed.id === 3) promptResp = parsed;
      else if (parsed.method === "session/update") updateLine = parsed;
    }

    expect(promptResp.result.stopReason).toBe("end_turn");
    expect(updateLine.params.sessionId).toBe(sessionId);
    expect(updateLine.params.update.text).toBe("echo: hi");

    server.shutdown();
  });

  it("session/cancel aborts an in-flight turn", async () => {
    const pair = new StreamPair();
    let abortSignal!: AbortSignal;
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({
        runner: makeRunner(({ signal }) => {
          abortSignal = signal;
          return new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ stopReason: "cancelled" }));
          });
        }),
      }),
    });

    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);

    pair.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    const newResp = await findResponse(pair, 2);
    const sessionId = newResp.result.sessionId;

    pair.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: "hang" },
    });
    // give the turn a chance to start
    await new Promise((r) => setTimeout(r, 5));

    pair.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/cancel",
      params: { sessionId },
    });

    const cancelResp = await findResponse(pair, 4);
    expect(cancelResp.result).toBeNull();
    expect(abortSignal.aborted).toBe(true);

    const promptResp = await findResponse(pair, 3);
    expect(promptResp.result.stopReason).toBe("cancelled");
    server.shutdown();
  });

  it("multiple prompts on the same session reuse the same sessionId in the runner", async () => {
    const pair = new StreamPair();
    const seenIds: string[] = [];
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({
        runner: makeRunner(async ({ sessionId }) => {
          seenIds.push(sessionId);
          return { stopReason: "end_turn" };
        }),
      }),
    });

    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);

    pair.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    const newResp = await findResponse(pair, 2);
    const sessionId = newResp.result.sessionId;

    pair.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: "first" },
    });
    await findResponse(pair, 3);

    pair.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId, prompt: "second" },
    });
    await findResponse(pair, 4);

    expect(seenIds).toEqual([sessionId, sessionId]);
    server.shutdown();
  });

  it("returns MethodNotFound for unknown methods", async () => {
    const pair = new StreamPair();
    const server = new AcpServer({
      input: pair.inbound,
      output: pair.outbound,
      sessionFactory: createSessionAdapter({
        runner: makeRunner(async () => ({ stopReason: "end_turn" })),
      }),
    });
    pair.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await findResponse(pair, 1);
    pair.send({ jsonrpc: "2.0", id: 2, method: "fs/exotic", params: {} });
    const resp = await findResponse(pair, 2);
    expect(resp.error.code).toBe(-32601);
    server.shutdown();
  });
});
