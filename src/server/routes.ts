/**
 * HTTP route handlers for the API server.
 * Each handler receives parsed request data and writes to the response.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpProvider } from "../core/provider.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { AgentLoop } from "../core/agent-loop.js";
import type { AgentEvent } from "../core/agent-loop.js";
import { buildAgentContext } from "../cli/runtime.js";
import { loadConfigV2, defaultConfigDir } from "../cli/config.js";
/** Minimal session store interface needed for resume route. */
interface ResumeSessionStore {
  getMessages(sessionId: string): Array<{ id: number; session_id: string; role: string; content: string | null; timestamp: number }>;
  appendMessage(sessionId: string, message: { role: string; content: string | null }): void;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Route: POST /chat  (one-shot)
// ---------------------------------------------------------------------------

export interface ChatRouteOptions {
  req: IncomingMessage;
  provider: HttpProvider;
  toolRegistry: ToolRegistry;
  message: string;
  sessionId?: string;
  /** Pre-computed system prompt (avoids re-loading config per request). */
  systemPrompt?: string;
  /** Model name for escalation tier lookup. */
  modelName?: string;
}

export async function handleChat(
  res: ServerResponse,
  options: ChatRouteOptions,
): Promise<void> {
  const ac = new AbortController();
  const onClose = () => ac.abort();

  options.req.on("close", onClose);
  res.on("close", onClose);

  try {
    let systemPrompt: string | undefined = options.systemPrompt;
    if (!systemPrompt) {
      try {
        const config = loadConfigV2(defaultConfigDir());
        systemPrompt = buildAgentContext({ config });
      } catch {
        // Config unavailable — proceed without system prompt
      }
    }

    const loop = new AgentLoop({
      provider: options.provider,
      toolRegistry: options.toolRegistry,
      sessionId: options.sessionId,
      systemPrompt,
      modelName: options.modelName,
    });

    let responseText = "";

    for await (const event of loop.run(options.message, { signal: ac.signal })) {
      if (ac.signal.aborted) break;

      if (event.type === "completion" && event.message.content) {
        responseText = event.message.content;
      } else if (event.type === "error") {
        jsonResponse(res, 500, { error: event.error.message });
        return;
      }
    }

    if (!ac.signal.aborted) {
      jsonResponse(res, 200, { response: responseText, sessionId: options.sessionId });
    }
  } finally {
    options.req.removeListener("close", onClose);
    res.removeListener("close", onClose);
  }
}

// ---------------------------------------------------------------------------
// Route: POST /chat/stream  (SSE)
// ---------------------------------------------------------------------------

export interface StreamRouteOptions {
  req: IncomingMessage;
  provider: HttpProvider;
  toolRegistry: ToolRegistry;
  message: string;
  sessionId?: string;
  /** Pre-computed system prompt (avoids re-loading config per request). */
  systemPrompt?: string;
  /** Model name for escalation tier lookup. */
  modelName?: string;
}

export async function handleChatStream(
  res: ServerResponse,
  options: StreamRouteOptions,
): Promise<void> {
  const ac = new AbortController();
  const onClose = () => ac.abort();

  options.req.on("close", onClose);
  res.on("close", onClose);

  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let systemPrompt: string | undefined = options.systemPrompt;
    if (!systemPrompt) {
      try {
        const config = loadConfigV2(defaultConfigDir());
        systemPrompt = buildAgentContext({ config });
      } catch {
        // Config unavailable — proceed without system prompt
      }
    }

    const loop = new AgentLoop({
      provider: options.provider,
      toolRegistry: options.toolRegistry,
      sessionId: options.sessionId,
      stream: true,
      systemPrompt,
      modelName: options.modelName,
    });

    for await (const event of loop.run(options.message, { signal: ac.signal })) {
      if (res.writableEnded || ac.signal.aborted) break;

      const payload: Record<string, unknown> = { type: event.type };

      if (event.type === "text_delta") {
        payload.content = event.content;
      } else if (event.type === "tool_call_start") {
        payload.toolCall = event.toolCall;
      } else if (event.type === "tool_result") {
        payload.name = event.name;
        payload.result = event.result;
      } else if (event.type === "usage") {
        payload.usage = event.usage;
      } else if (event.type === "completion") {
        payload.message = event.message;
      } else if (event.type === "error") {
        payload.error = event.error.message;
      } else if (event.type === "warning") {
        payload.message = event.message;
      }

      if (!res.writableEnded && !ac.signal.aborted) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    options.req.removeListener("close", onClose);
    res.removeListener("close", onClose);
  }
}

// ---------------------------------------------------------------------------
// Route: GET /health
// ---------------------------------------------------------------------------

export interface HealthRouteOptions {
  sessions: number;
}

export function handleHealth(
  res: ServerResponse,
  options: HealthRouteOptions,
): void {
  jsonResponse(res, 200, {
    status: "ok",
    uptime: process.uptime(),
    sessions: options.sessions,
  });
}

// ---------------------------------------------------------------------------
// Route: GET /sessions
// ---------------------------------------------------------------------------

export interface SessionsRouteOptions {
  sessions: Array<{ id: string; [key: string]: unknown }>;
}

export function handleListSessions(
  res: ServerResponse,
  options: SessionsRouteOptions,
): void {
  jsonResponse(res, 200, options.sessions);
}

// ---------------------------------------------------------------------------
// Route: POST /sessions/:id/resume
// ---------------------------------------------------------------------------

export interface ResumeRouteOptions {
  req: IncomingMessage;
  provider: HttpProvider;
  toolRegistry: ToolRegistry;
  sessionId: string;
  message: string;
  sessionStore: ResumeSessionStore;
  systemPrompt?: string;
  /** Model name for escalation tier lookup. */
  modelName?: string;
}

export async function handleSessionResume(
  res: ServerResponse,
  options: ResumeRouteOptions,
): Promise<void> {
  const ac = new AbortController();
  const onClose = () => ac.abort();

  options.req.on("close", onClose);
  res.on("close", onClose);

  try {
    const loop = new AgentLoop({
      provider: options.provider,
      toolRegistry: options.toolRegistry,
      sessionId: options.sessionId,
      sessionStore: options.sessionStore,
      resumeSessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      modelName: options.modelName,
    });

    let responseText = "";

    for await (const event of loop.run(options.message, { signal: ac.signal })) {
      if (ac.signal.aborted) break;

      if (event.type === "completion" && event.message.content) {
        responseText = event.message.content;
      } else if (event.type === "error") {
        jsonResponse(res, 500, { error: event.error.message });
        return;
      }
    }

    if (!ac.signal.aborted) {
      jsonResponse(res, 200, { response: responseText, sessionId: options.sessionId });
    }
  } finally {
    options.req.removeListener("close", onClose);
    res.removeListener("close", onClose);
  }
}
