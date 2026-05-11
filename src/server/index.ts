/**
 * Server/API mode for purrfect.
 *
 * Exposes the agent loop over HTTP using Node.js built-in http module.
 * Routes:
 *   GET  /health         — health/status check (no auth)
 *   POST /chat           — one-shot JSON response
 *   POST /chat/stream    — SSE streaming response
 *   GET  /sessions       — list sessions
 *   POST /sessions/:id/resume — resume a session
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpProvider } from "../core/provider.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { authenticate } from "./auth.js";
import { handleChat, handleChatStream, handleListSessions, handleSessionResume, handleHealth } from "./routes.js";
import { SessionStore } from "../core/session-store.js";
import { buildAgentContext } from "../cli/runtime.js";
import { loadConfigV2, defaultConfigDir } from "../cli/config.js";
import { join } from "node:path";
import { MemoryStore } from "../core/memory/store.js";
import { SkillRegistry } from "../core/skills/registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Bearer token for authentication. */
  token: string;
  /** Factory that creates a fresh HttpProvider for each one-shot request. */
  providerFactory: (text?: string) => HttpProvider;
  /** Factory that creates a fresh HttpProvider wired for streaming. */
  streamingProviderFactory: () => HttpProvider;
  /** Shared tool registry. */
  toolRegistry: ToolRegistry;
  /** Path to the SQLite database for session persistence (optional). */
  sessionDbPath?: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum allowed request body size in bytes (1 MB). */
export const MAX_BODY_SIZE = 1_048_576;

/** Maximum time (ms) to wait for the full request body (30 s). */
export const BODY_READ_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    function fail(err: BodyReadError): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeAllListeners("data");
      req.resume(); // drain remaining data so the socket isn't stuck
      reject(err);
    }

    // Guard: abort if the body isn't fully received within the timeout.
    const timer = setTimeout(() => {
      fail(new BodyReadError(408, "Request timeout: body not received in time"));
    }, BODY_READ_TIMEOUT);

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_SIZE) {
        fail(new BodyReadError(413, "Payload too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Sentinel error carrying an HTTP status code for body-read failures. */
export class BodyReadError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "BodyReadError";
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options: ServerOptions): http.Server {
  const { token, providerFactory, streamingProviderFactory, toolRegistry } = options;

  // Session persistence — use real SessionStore when a DB path is provided,
  // otherwise fall back to in-memory tracking for backward compatibility / tests.
  let sessionStore: SessionStore | null = null;
  if (options.sessionDbPath) {
    sessionStore = new SessionStore(options.sessionDbPath);
  }

  // Pre-compute system prompt with memory + skills at startup
  let cachedSystemPrompt: string | undefined;
  let cachedModelName: string | undefined;
  try {
    const configDir = defaultConfigDir();
    const config = loadConfigV2(configDir);
    cachedModelName = config.model;
    let memorySnapshot: string | undefined;
    try {
      const memoriesDir = config.memoriesDir ?? join(configDir, "memories");
      const snapshot = new MemoryStore(memoriesDir).getSnapshot();
      if (snapshot) memorySnapshot = snapshot;
    } catch { /* memory unavailable */ }

    let skillIndex: string | undefined;
    try {
      if (config.skillsDir) {
        const reg = new SkillRegistry();
        reg.discover(config.skillsDir);
        const allSkills = reg.getAllSkills();
        if (allSkills.length > 0) {
          const names = allSkills.map((s) => {
            const triggers = s.triggers.join(", ");
            return `${s.name} (${triggers})`;
          });
          skillIndex = `Available skills: ${names.join(", ")}`;
        }
      }
    } catch { /* skills unavailable */ }

    cachedSystemPrompt = buildAgentContext({ config, memorySnapshot, skillIndex });
  } catch { /* config unavailable */ }

  // In-memory fallback for when no sessionDbPath is configured.
  const inMemorySessions: Array<{ id: string; createdAt: string }> = [];

  /** Helper: record a new session. */
  function trackSession(sessionId: string, model?: string): void {
    if (sessionStore) {
      // Only create if it doesn't already exist.
      if (!sessionStore.getSession(sessionId)) {
        sessionStore.createSession({
          id: sessionId,
          model: model ?? "unknown",
          source: "api",
        });
      }
    } else {
      inMemorySessions.push({ id: sessionId, createdAt: new Date().toISOString() });
    }
  }

  /** Helper: get session count for /health. */
  function sessionCount(): number {
    if (sessionStore) {
      return sessionStore.listSessions().length;
    }
    return inMemorySessions.length;
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // ── Health endpoint (no auth required) ────────────────────────────
    if (method === "GET" && pathname === "/health") {
      handleHealth(res, { sessions: sessionCount() });
      return;
    }

    // ── Auth gate ──────────────────────────────────────────────────────
    if (!authenticate(req, token)) {
      jsonError(res, 401, "Unauthorized: missing or invalid bearer token");
      return;
    }

    try {
      // ── POST /chat ─────────────────────────────────────────────────
      if (method === "POST" && pathname === "/chat") {
        const raw = await readBody(req);
        if (!raw || !raw.trim()) {
          jsonError(res, 400, "Request body is required");
          return;
        }

        let body: { message?: string; sessionId?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          jsonError(res, 400, "Invalid JSON body");
          return;
        }

        if (!body.message || typeof body.message !== "string") {
          jsonError(res, 400, "\"message\" field is required and must be a string");
          return;
        }

        const sessionId = body.sessionId ?? `ses_${Date.now()}`;
        trackSession(sessionId);

        if (sessionStore) {
          sessionStore.appendMessage(sessionId, { role: "user", content: body.message });
        }

        await handleChat(res, {
          req,
          provider: providerFactory(),
          toolRegistry,
          message: body.message,
          sessionId,
          systemPrompt: cachedSystemPrompt,
          modelName: cachedModelName,
        });
        return;
      }

      // ── POST /chat/stream ──────────────────────────────────────────
      if (method === "POST" && pathname === "/chat/stream") {
        const raw = await readBody(req);
        if (!raw || !raw.trim()) {
          jsonError(res, 400, "Request body is required");
          return;
        }

        let body: { message?: string; sessionId?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          jsonError(res, 400, "Invalid JSON body");
          return;
        }

        if (!body.message || typeof body.message !== "string") {
          jsonError(res, 400, "\"message\" field is required and must be a string");
          return;
        }

        const sessionId = body.sessionId ?? `ses_${Date.now()}`;
        trackSession(sessionId);

        if (sessionStore) {
          sessionStore.appendMessage(sessionId, { role: "user", content: body.message });
        }

        await handleChatStream(res, {
          req,
          provider: streamingProviderFactory(),
          toolRegistry,
          message: body.message,
          sessionId,
          systemPrompt: cachedSystemPrompt,
          modelName: cachedModelName,
        });
        return;
      }

      // ── GET /sessions ──────────────────────────────────────────────
      if (method === "GET" && pathname === "/sessions") {
        if (sessionStore) {
          const records = sessionStore.listSessions().map((s) => ({
            id: s.id,
            model: s.model,
            source: s.source,
            title: s.title,
            createdAt: new Date(s.created_at * 1000).toISOString(),
            updatedAt: new Date(s.updated_at * 1000).toISOString(),
          }));
          handleListSessions(res, { sessions: records });
        } else {
          handleListSessions(res, { sessions: inMemorySessions });
        }
        return;
      }

      // ── POST /sessions/:id/resume ──────────────────────────────────
      const resumeMatch = pathname.match(/^\/sessions\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch) {
        const resumeSessionId = resumeMatch[1];
        const raw = await readBody(req);
        if (!raw || !raw.trim()) {
          jsonError(res, 400, "Request body is required");
          return;
        }

        let body: { message?: string };
        try {
          body = JSON.parse(raw);
        } catch {
          jsonError(res, 400, "Invalid JSON body");
          return;
        }

        if (!body.message || typeof body.message !== "string") {
          jsonError(res, 400, "\"message\" field is required and must be a string");
          return;
        }

        const store = sessionStore
          ? sessionStore
          : { getMessages: () => [], appendMessage: () => {} };

        await handleSessionResume(res, {
          req,
          provider: providerFactory(),
          toolRegistry,
          sessionId: resumeSessionId,
          message: body.message,
          sessionStore: store,
          systemPrompt: cachedSystemPrompt,
          modelName: cachedModelName,
        });
        return;
      }

      // ── 404 ────────────────────────────────────────────────────────
      jsonError(res, 404, `Not found: ${method} ${pathname}`);
    } catch (err) {
      if (err instanceof BodyReadError) {
        jsonError(res, err.statusCode, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      jsonError(res, 500, `Internal server error: ${message}`);
    }
  });

  return server;
}
