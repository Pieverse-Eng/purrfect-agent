/**
 * Minimal JSON-RPC 2.0 transport for the Agent Client Protocol.
 *
 * ACP uses newline-delimited JSON over stdio (no LSP-style Content-Length
 * headers). This module owns:
 *   - Framing: split an inbound byte stream into JSON-RPC messages
 *   - Outbound serialization: write a message + "\n"
 *   - Connection helper: dispatch incoming requests / notifications and
 *     resolve outbound request promises by id
 */

import type { Readable, Writable } from "node:stream";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Custom: client cancelled an in-flight request. */
  RequestCancelled: -32800,
} as const;

export class JsonRpcException extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

// ── Framing ────────────────────────────────────────────────────────────

/**
 * Split a raw chunk stream into individual JSON messages by newline.
 * Lines that are empty after trimming are skipped (some senders write
 * blank padding). Invalid JSON yields a parse error result so the caller
 * can surface it to the client.
 */
export function* parseFrames(buffer: { value: string }, chunk: string): Generator<
  { ok: true; message: JsonRpcMessage } | { ok: false; raw: string; error: SyntaxError }
> {
  buffer.value += chunk;
  let nl = buffer.value.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.value.slice(0, nl);
    buffer.value = buffer.value.slice(nl + 1);
    nl = buffer.value.indexOf("\n");
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield { ok: true, message: JSON.parse(trimmed) as JsonRpcMessage };
    } catch (err) {
      yield { ok: false, raw: trimmed, error: err as SyntaxError };
    }
  }
}

export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}

// ── Connection ─────────────────────────────────────────────────────────

export type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type NotificationHandler = (method: string, params: unknown) => void;

export interface ConnectionOptions {
  input: Readable;
  output: Writable;
  /** Invoked for incoming requests. Throw JsonRpcException for typed errors. */
  onRequest: RequestHandler;
  /** Invoked for incoming notifications. */
  onNotification?: NotificationHandler;
  /** Called when the input stream is closed. */
  onClose?: () => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly buffer = { value: "" };
  private readonly options: ConnectionOptions;
  private closed = false;

  constructor(options: ConnectionOptions) {
    this.options = options;
    options.input.setEncoding?.("utf-8");
    options.input.on("data", (chunk) => this.handleChunk(String(chunk)));
    options.input.on("end", () => this.close());
    options.input.on("close", () => this.close());
  }

  /** Send a request and resolve with the peer's response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Connection is closed"));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.write(msg);
    });
  }

  /** Fire-and-forget notification (no response). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.write(msg);
  }

  /** Reject all pending peer requests. Called on stream close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error("Connection closed"));
    }
    this.pending.clear();
    this.options.onClose?.();
  }

  private write(msg: JsonRpcMessage): void {
    this.options.output.write(serializeMessage(msg));
  }

  private handleChunk(chunk: string): void {
    for (const result of parseFrames(this.buffer, chunk)) {
      if (!result.ok) {
        this.write({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: ErrorCode.ParseError,
            message: `Parse error: ${result.error.message}`,
            data: result.raw,
          },
        });
        continue;
      }
      this.handleMessage(result.message);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if ("method" in msg) {
      if ("id" in msg) {
        this.handleRequest(msg);
      } else {
        this.handleNotification(msg);
      }
    } else {
      this.handleResponse(msg);
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.options.onRequest(req.method, req.params);
      this.write({ jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      const code = err instanceof JsonRpcException ? err.code : ErrorCode.InternalError;
      const message = err instanceof Error ? err.message : String(err);
      const data = err instanceof JsonRpcException ? err.data : undefined;
      this.write({
        jsonrpc: "2.0",
        id: req.id,
        error: { code, message, data },
      });
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
    try {
      this.options.onNotification?.(notif.method, notif.params);
    } catch {
      // Notifications cannot return errors per JSON-RPC spec.
    }
  }

  private handleResponse(resp: JsonRpcSuccess | JsonRpcError): void {
    if (resp.id === null || resp.id === undefined) return;
    const entry = this.pending.get(resp.id);
    if (!entry) return;
    this.pending.delete(resp.id);
    if ("result" in resp) {
      entry.resolve(resp.result);
    } else {
      entry.reject(new JsonRpcException(resp.error.code, resp.error.message, resp.error.data));
    }
  }
}
