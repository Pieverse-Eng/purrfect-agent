/**
 * `purrfect acp` — start the Agent Client Protocol stdio server.
 *
 * Editors (Zed, Cursor, VSCode) speak ACP over stdio. This entrypoint
 * wires the ACP server into the purrfect agent runtime so a real LLM
 * loop runs inside the session.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AcpServer, ACP_PROTOCOL_VERSION } from "../acp/server.js";
import { VERSION } from "../version.js";
import {
  createSessionAdapter,
  type PurrfectAgentRunner,
  type SessionUpdate,
} from "../acp/session-adapter.js";
import { createAcpApprovalHandler } from "../acp/tool-bridge.js";
import { defaultConfigDir, loadConfig, loadConfigV2 } from "./config.js";
import { SessionStore } from "../core/session-store.js";
import { HttpProvider } from "../core/provider.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { registerBuiltins } from "../core/tools/index.js";
import { CredentialPool } from "../core/credential-pool.js";
import { resolveApiKey } from "../core/secrets.js";
import { AgentLoop, type AgentEvent } from "../core/agent-loop.js";

export interface AcpCommandOptions {
  configDir?: string;
}

export async function startAcpServer(opts: AcpCommandOptions = {}): Promise<AcpServer> {
  const configDir = opts.configDir ?? defaultConfigDir();
  const config = loadConfigV2(configDir);
  const cliConfig = loadConfig(configDir);
  const providerType = (config.providerType ?? "openai") as "openai" | "anthropic";

  const credentialPool = new CredentialPool({
    path: join(configDir, "credentials.json"),
  });
  const apiKey = resolveApiKey(cliConfig.apiKey, providerType) ?? "";

  const provider = new HttpProvider({
    baseUrl: cliConfig.baseUrl,
    apiKey,
    model: cliConfig.model,
    credentialPool,
    providerType,
  });

  const sessionStore = new SessionStore(join(configDir, "acp-sessions.db"));

  const runner = createPurrfectRunner({
    sessionStore,
    provider,
    config,
    cliConfig,
  });

  const server = new AcpServer({
    input: process.stdin,
    output: process.stdout,
    sessionFactory: createSessionAdapter({ runner }),
    agent: { name: "purrfect", version: VERSION },
    capabilities: {
      fs: { read: false, write: false },
      terminal: false,
      permission: true,
    },
    log: (msg) => process.stderr.write(`[acp] ${msg}\n`),
  });

  process.stderr.write(`[acp] purrfect ACP server started (protocol ${ACP_PROTOCOL_VERSION})\n`);
  return server;
}

// ── Runner factory (exported for tests) ────────────────────────────────

export interface CreatePurrfectRunnerOptions {
  sessionStore: SessionStore;
  provider: HttpProvider;
  config: ReturnType<typeof loadConfigV2>;
  cliConfig: ReturnType<typeof loadConfig>;
  /** Inject a session id factory so tests don't randomize. */
  newSessionId?: () => string;
}

/**
 * Build a PurrfectAgentRunner that maps each ACP session id to a single
 * underlying purrfect SessionStore session. The mapping is created lazily
 * on the first prompt for an ACP session and reused for every subsequent
 * prompt so conversation history persists across turns.
 */
export function createPurrfectRunner(opts: CreatePurrfectRunnerOptions): PurrfectAgentRunner {
  const { sessionStore, provider, config, cliConfig } = opts;
  const newSessionId = opts.newSessionId ?? randomUUID;
  const purrfectSessionIds = new Map<string, string>();

  return {
    async runTurn({ sessionId: acpSessionId, prompt, signal, onUpdate, requestPermission }) {
      const userText = extractText(prompt);

      let purrfectSessionId = purrfectSessionIds.get(acpSessionId);
      if (!purrfectSessionId) {
        purrfectSessionId = createPurrfectSession(sessionStore, userText, newSessionId);
        purrfectSessionIds.set(acpSessionId, purrfectSessionId);
      }

      const toolRegistry = new ToolRegistry();
      registerBuiltins(toolRegistry, {
        sessionStore,
        provider,
        platform: "purrfect-cli",
        modelName: cliConfig.model,
        sandboxMode: config.sandbox,
        getSessionId: () => purrfectSessionId!,
        onApprovalRequired: requestPermission
          ? createAcpApprovalHandler(requestPermission)
          : undefined,
      });

      const loop = new AgentLoop({
        provider,
        toolRegistry,
        sessionStore,
        sessionId: purrfectSessionId,
        stream: true,
        modelName: cliConfig.model,
        onApprovalRequired: requestPermission
          ? createAcpApprovalHandler(requestPermission)
          : undefined,
      });

      try {
        for await (const event of loop.run(userText, { signal })) {
          forwardEvent(event, onUpdate);
        }
        return { stopReason: "end_turn" };
      } catch (err) {
        if (signal.aborted) return { stopReason: "cancelled" };
        throw err;
      }
    },
    closeSession(acpSessionId) {
      purrfectSessionIds.delete(acpSessionId);
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  if (prompt && typeof prompt === "object" && "text" in prompt) {
    return String((prompt as { text: unknown }).text ?? "");
  }
  return "";
}

function createPurrfectSession(
  store: SessionStore,
  firstMessage: string,
  newId: () => string,
): string {
  const id = newId();
  store.createSession({
    id,
    model: "acp",
    source: "acp",
    title: firstMessage.slice(0, 80),
  } as any);
  return id;
}

function forwardEvent(event: AgentEvent, send: (u: SessionUpdate) => void): void {
  switch (event.type) {
    case "text_delta":
      send({ kind: "assistant_text", text: event.content });
      return;
    case "tool_call_start":
      send({
        kind: "tool_call_start",
        toolName: event.toolCall.function.name,
        toolInput: safeParseArgs(event.toolCall.function.arguments),
      });
      return;
    case "tool_result":
      send({ kind: "tool_call_result", toolName: event.name, toolOutput: event.result });
      return;
    case "error":
      send({ kind: "error", message: event.error.message });
      return;
    default:
      // usage / completion / budget_exceeded / warning — not surfaced
      return;
  }
}

function safeParseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
