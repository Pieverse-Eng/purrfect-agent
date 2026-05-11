/**
 * SessionAdapter — bridges a single ACP session to the purrfect agent runtime.
 *
 * Responsibilities:
 *   - Maintain message history in a SessionStore-backed conversation
 *   - Run the agent loop on each editor `session/prompt`
 *   - Stream incremental progress as `session/update` notifications
 *   - Surface tool-call approval through `session/request_permission`
 *   - Honor `session/cancel` via AbortController
 *
 * This module deliberately keeps the dependencies on the agent runtime
 * narrow — concrete construction lives in cli/acp.ts so the server can
 * be exercised with an in-memory mock from tests.
 */

import { randomUUID } from "node:crypto";

export type AcpStopReason =
  | "end_turn"
  | "max_turns"
  | "max_tokens"
  | "cancelled"
  | "error";

export interface SessionUpdate {
  /** Discriminator: assistant message, tool call event, tool result, error… */
  kind: "assistant_text" | "tool_call_start" | "tool_call_result" | "thinking" | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  message?: string;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: {
    name: string;
    input: unknown;
    description?: string;
  };
  /**
   * Options the editor presents to the user. Standard set: allow_once,
   * allow_always, reject. Extra options are advisory.
   */
  options: Array<"allow_once" | "allow_always" | "reject">;
}

export interface PermissionResponse {
  decision: "allow_once" | "allow_always" | "reject";
}

export interface SessionAdapter {
  readonly sessionId: string;
  prompt(input: unknown): Promise<{ stopReason: AcpStopReason }>;
  cancel(): void;
}

export interface SessionAdapterContext {
  workingDirectory: string;
  requestPermission?: (req: PermissionRequest) => Promise<PermissionResponse>;
  sendUpdate: (sessionId: string, update: SessionUpdate) => void;
  log: (msg: string) => void;
}

export type SessionAdapterFactory = (
  ctx: SessionAdapterContext,
) => Promise<SessionAdapter> | SessionAdapter;

// ── Default in-process adapter ─────────────────────────────────────────

export interface PurrfectAgentRunner {
  /**
   * Run a single conversation turn. Implementations call `onUpdate` for each
   * incremental delta (assistant text, tool call lifecycle) and resolve when
   * the turn ends.
   *
   * `sessionId` is the stable ACP session id; runners use it to look up or
   * create the underlying purrfect session so multiple prompts on the same
   * ACP session share history and per-session state.
   */
  runTurn(args: {
    sessionId: string;
    prompt: unknown;
    workingDirectory: string;
    signal: AbortSignal;
    onUpdate: (update: SessionUpdate) => void;
    requestPermission?: (req: Omit<PermissionRequest, "sessionId">) => Promise<PermissionResponse>;
  }): Promise<{ stopReason: AcpStopReason }>;
  /** Optional: release per-session state when the ACP session ends. */
  closeSession?(sessionId: string): void;
}

export interface CreateSessionAdapterOptions {
  /** Stable session id (defaults to a fresh UUID). */
  sessionId?: string;
  runner: PurrfectAgentRunner;
}

export function createSessionAdapter(
  opts: CreateSessionAdapterOptions,
): SessionAdapterFactory {
  return (ctx) => {
    const sessionId = opts.sessionId ?? randomUUID();
    let abort: AbortController | undefined;

    return {
      sessionId,
      async prompt(input) {
        if (abort) abort.abort(); // pre-empt any in-flight turn
        abort = new AbortController();
        try {
          return await opts.runner.runTurn({
            sessionId,
            prompt: input,
            workingDirectory: ctx.workingDirectory,
            signal: abort.signal,
            onUpdate: (update) => ctx.sendUpdate(sessionId, update),
            requestPermission: ctx.requestPermission
              ? (req) => ctx.requestPermission!({ ...req, sessionId })
              : undefined,
          });
        } catch (err) {
          if (abort?.signal.aborted) {
            return { stopReason: "cancelled" };
          }
          ctx.log(`session ${sessionId} error: ${err instanceof Error ? err.message : err}`);
          ctx.sendUpdate(sessionId, {
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          return { stopReason: "error" };
        }
      },
      cancel() {
        abort?.abort();
      },
    };
  };
}
