import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  parseFrames,
  serializeMessage,
  JsonRpcConnection,
  JsonRpcException,
  ErrorCode,
} from "../../src/acp/jsonrpc.js";

describe("parseFrames", () => {
  it("yields complete messages and skips blank lines", () => {
    const buffer = { value: "" };
    const out = [
      ...parseFrames(buffer, '{"jsonrpc":"2.0","method":"foo"}\n\n{"jsonrpc":"2.0","method":"bar"}\n'),
    ];
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ok: true });
    expect(out[1]).toMatchObject({ ok: true });
  });

  it("buffers partial messages across chunks", () => {
    const buffer = { value: "" };
    const a = [...parseFrames(buffer, '{"jsonrpc":"2.0",')];
    expect(a).toHaveLength(0);
    const b = [...parseFrames(buffer, '"method":"x"}\n')];
    expect(b).toHaveLength(1);
    expect((b[0] as any).message).toEqual({ jsonrpc: "2.0", method: "x" });
  });

  it("reports parse errors", () => {
    const buffer = { value: "" };
    const out = [...parseFrames(buffer, "not json\n")];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ok: false, raw: "not json" });
  });
});

describe("serializeMessage", () => {
  it("appends a single newline", () => {
    expect(serializeMessage({ jsonrpc: "2.0", id: 1, result: 42 })).toBe(
      `{"jsonrpc":"2.0","id":1,"result":42}\n`,
    );
  });
});

// ── Connection harness ──────────────────────────────────────────────────

class StreamPair {
  readonly clientToServer = new PassthroughStream();
  readonly serverToClient = new PassthroughStream();
}

class PassthroughStream {
  readonly readable: Readable;
  readonly writable: Writable;
  private buffer: string[] = [];
  private waiters: Array<(line: string) => void> = [];

  constructor() {
    const self = this;
    this.readable = new Readable({
      read() {
        // pushed externally
      },
    });
    this.writable = new Writable({
      write(chunk, _enc, cb) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        for (const line of text.split("\n")) {
          if (line) self.deliver(line);
        }
        cb();
      },
    });
  }

  /** Push a fully-formed message line to the readable side (for the peer to consume). */
  push(line: string): void {
    this.readable.push(line + "\n", "utf-8");
  }

  /** Wait for the next line written by the peer to the writable side. */
  next(): Promise<string> {
    return new Promise((resolve) => {
      if (this.buffer.length > 0) {
        resolve(this.buffer.shift()!);
      } else {
        this.waiters.push(resolve);
      }
    });
  }

  private deliver(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.buffer.push(line);
  }
}

describe("JsonRpcConnection", () => {
  it("dispatches incoming requests and writes the result", async () => {
    const stream = new PassthroughStream();
    const written = new PassthroughStream();
    const conn = new JsonRpcConnection({
      input: stream.readable,
      output: written.writable,
      onRequest: async (method, params) => {
        if (method === "ping") return { pong: params };
        throw new JsonRpcException(ErrorCode.MethodNotFound, "no");
      },
    });
    stream.push(`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":1}}`);
    const line = await written.next();
    expect(JSON.parse(line)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { pong: { x: 1 } },
    });
    conn.close();
  });

  it("converts thrown JsonRpcException to a typed error response", async () => {
    const stream = new PassthroughStream();
    const written = new PassthroughStream();
    new JsonRpcConnection({
      input: stream.readable,
      output: written.writable,
      onRequest: async () => {
        throw new JsonRpcException(ErrorCode.InvalidParams, "missing arg");
      },
    });
    stream.push(`{"jsonrpc":"2.0","id":2,"method":"x"}`);
    const line = await written.next();
    const parsed = JSON.parse(line);
    expect(parsed.error.code).toBe(ErrorCode.InvalidParams);
    expect(parsed.error.message).toBe("missing arg");
  });

  it("emits a parse error response for invalid JSON", async () => {
    const stream = new PassthroughStream();
    const written = new PassthroughStream();
    new JsonRpcConnection({
      input: stream.readable,
      output: written.writable,
      onRequest: vi.fn(),
    });
    stream.push("not json");
    const line = await written.next();
    const parsed = JSON.parse(line);
    expect(parsed.error.code).toBe(ErrorCode.ParseError);
    expect(parsed.id).toBeNull();
  });

  it("resolves outbound requests by id", async () => {
    const stream = new PassthroughStream();
    const written = new PassthroughStream();
    const conn = new JsonRpcConnection({
      input: stream.readable,
      output: written.writable,
      onRequest: vi.fn(),
    });
    const reqPromise = conn.request<{ ok: true }>("hello", { who: "world" });
    const line = await written.next();
    const sent = JSON.parse(line);
    expect(sent.method).toBe("hello");
    expect(sent.id).toBe(1);

    stream.push(`{"jsonrpc":"2.0","id":${sent.id},"result":{"ok":true}}`);
    await expect(reqPromise).resolves.toEqual({ ok: true });
  });

  it("rejects outbound requests on error response", async () => {
    const stream = new PassthroughStream();
    const written = new PassthroughStream();
    const conn = new JsonRpcConnection({
      input: stream.readable,
      output: written.writable,
      onRequest: vi.fn(),
    });
    const reqPromise = conn.request("x");
    const line = await written.next();
    const sent = JSON.parse(line);
    stream.push(
      `{"jsonrpc":"2.0","id":${sent.id},"error":{"code":-32000,"message":"boom"}}`,
    );
    await expect(reqPromise).rejects.toThrow(/boom/);
  });

  it("invokes the notification handler and never responds", async () => {
    const stream = new PassthroughStream();
    const written = new PassthroughStream();
    const onNotification = vi.fn();
    new JsonRpcConnection({
      input: stream.readable,
      output: written.writable,
      onRequest: vi.fn(),
      onNotification,
    });
    stream.push(`{"jsonrpc":"2.0","method":"hi","params":{"a":1}}`);
    // give the event loop a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(onNotification).toHaveBeenCalledWith("hi", { a: 1 });
  });
});

export { PassthroughStream };
