/**
 * Agent Client Protocol server — handles editor (Zed / Cursor / VSCode) clients
 * over stdio. Implements the minimum surface required for prompting and tool
 * approval; advanced surfaces (terminal/, complex fs/) negotiate via
 * capabilities and gracefully decline when missing.
 */

import type { Readable, Writable } from "node:stream";
import {
  JsonRpcConnection,
  JsonRpcException,
  ErrorCode,
} from "./jsonrpc.js";
import {
  createSessionAdapter,
  type SessionAdapter,
  type SessionAdapterFactory,
} from "./session-adapter.js";
import { VERSION } from "../version.js";

/** Protocol version this implementation speaks. */
export const ACP_PROTOCOL_VERSION = "1";

export interface AgentCapabilities {
  /** Whether the agent can request fs/* operations from the editor. */
  fs?: { read?: boolean; write?: boolean };
  /** Whether the agent can request terminal/* operations from the editor. */
  terminal?: boolean;
  /** Whether the agent can request session/request_permission. */
  permission?: boolean;
}

export interface ClientCapabilities {
  fs?: { read?: boolean; write?: boolean };
  terminal?: boolean;
  permission?: boolean;
}

export interface InitializeResult {
  protocolVersion: string;
  agent: { name: string; version: string };
  capabilities: AgentCapabilities;
}

export interface AcpServerOptions {
  input: Readable;
  output: Writable;
  /** Factory to create a per-session adapter. Required for session/* methods. */
  sessionFactory: SessionAdapterFactory;
  /** Agent identity advertised in initialize. */
  agent?: { name?: string; version?: string };
  /** Capabilities advertised to the editor. */
  capabilities?: AgentCapabilities;
  /** Logger for diagnostic output (writes to stderr by default). */
  log?: (msg: string) => void;
}

export class AcpServer {
  private readonly connection: JsonRpcConnection;
  private readonly sessions = new Map<string, SessionAdapter>();
  private readonly sessionFactory: SessionAdapterFactory;
  private readonly agent: { name: string; version: string };
  private readonly capabilities: AgentCapabilities;
  private clientCapabilities: ClientCapabilities = {};
  private initialized = false;
  private readonly log: (msg: string) => void;

  constructor(options: AcpServerOptions) {
    this.sessionFactory = options.sessionFactory;
    this.agent = {
      name: options.agent?.name ?? "purrfect",
      version: options.agent?.version ?? VERSION,
    };
    this.capabilities = options.capabilities ?? {
      fs: { read: false, write: false },
      terminal: false,
      permission: true,
    };
    this.log = options.log ?? ((msg) => process.stderr.write(`[acp] ${msg}\n`));

    this.connection = new JsonRpcConnection({
      input: options.input,
      output: options.output,
      onRequest: (method, params) => this.dispatch(method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
    });
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize(params);
      case "session/new":
        this.requireInitialized();
        return this.handleNewSession(params);
      case "session/prompt":
        this.requireInitialized();
        return this.handlePrompt(params);
      case "session/cancel":
        this.requireInitialized();
        return this.handleCancel(params);
      case "shutdown":
        this.connection.close();
        return null;
      default:
        throw new JsonRpcException(
          ErrorCode.MethodNotFound,
          `Method not found: ${method}`,
        );
    }
  }

  private handleNotification(method: string, _params: unknown): void {
    // Editor-driven notifications (e.g. "$/cancelRequest"). Currently no-op.
    this.log(`ignored notification: ${method}`);
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new JsonRpcException(
        ErrorCode.InvalidRequest,
        "Server not initialized — send `initialize` first",
      );
    }
  }

  private handleInitialize(params: unknown): InitializeResult {
    const p = (params ?? {}) as {
      protocolVersion?: string;
      capabilities?: ClientCapabilities;
    };
    if (p.protocolVersion && p.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.log(
        `protocol version mismatch — client wants ${p.protocolVersion}, agent speaks ${ACP_PROTOCOL_VERSION}`,
      );
    }
    this.clientCapabilities = p.capabilities ?? {};
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agent: this.agent,
      capabilities: this.capabilities,
    };
  }

  private async handleNewSession(params: unknown): Promise<{ sessionId: string }> {
    const p = (params ?? {}) as { workingDirectory?: string };
    const adapter = await this.sessionFactory({
      workingDirectory: p.workingDirectory ?? process.cwd(),
      requestPermission: this.clientCapabilities.permission
        ? (req) => this.connection.request("session/request_permission", req)
        : undefined,
      sendUpdate: (sessionId, update) =>
        this.connection.notify("session/update", { sessionId, update }),
      log: this.log,
    });
    this.sessions.set(adapter.sessionId, adapter);
    return { sessionId: adapter.sessionId };
  }

  private async handlePrompt(params: unknown): Promise<{ stopReason: string }> {
    const p = (params ?? {}) as { sessionId?: string; prompt?: unknown };
    if (!p.sessionId) {
      throw new JsonRpcException(ErrorCode.InvalidParams, "sessionId is required");
    }
    const adapter = this.sessions.get(p.sessionId);
    if (!adapter) {
      throw new JsonRpcException(
        ErrorCode.InvalidParams,
        `Unknown sessionId: ${p.sessionId}`,
      );
    }
    return await adapter.prompt(p.prompt);
  }

  private async handleCancel(params: unknown): Promise<null> {
    const p = (params ?? {}) as { sessionId?: string };
    if (!p.sessionId) {
      throw new JsonRpcException(ErrorCode.InvalidParams, "sessionId is required");
    }
    const adapter = this.sessions.get(p.sessionId);
    adapter?.cancel();
    return null;
  }

  /** For tests / lifecycle management. */
  shutdown(): void {
    for (const adapter of this.sessions.values()) {
      adapter.cancel();
    }
    this.sessions.clear();
    this.connection.close();
  }
}

export { createSessionAdapter };
export type { SessionAdapter, SessionAdapterFactory } from "./session-adapter.js";
