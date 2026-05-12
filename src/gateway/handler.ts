/**
 * MessageHandler — bridges inbound platform messages to the AgentLoop.
 *
 * Builds a session key, gets or creates a session in SessionStore,
 * checks the reset policy, constructs a context-rich system prompt,
 * runs the AgentLoop, and sends the response back via the adapter.
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BaseAdapter, MessageEvent } from "./adapter.js";
import { buildSessionKey, shouldResetSession, type SessionResetPolicy } from "./session-keys.js";
import { SessionStore } from "../core/session-store.js";
import { AgentLoop, type AgentEvent } from "../core/agent-loop.js";
import { HttpProvider } from "../core/provider.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { createSendMessageTool } from "../core/tools/send-message.js";
import {
  createClarifyTool,
  resolveClarifyAnswer,
  type ClarifyRequest,
  type ClarifyResponse,
} from "../core/tools/clarify.js";
import { DeliveryRouter } from "./delivery.js";
import { MediaCache } from "./media.js";
import { buildAgentContext } from "../cli/runtime.js";
import { MemoryStore } from "../core/memory/store.js";
import { SkillRegistry } from "../core/skills/registry.js";
import { formatForPlatform } from "./format.js";
import type { GatewayConfig } from "./config.js";
import type { PermissionModel } from "../core/permissions.js";
import {
  PairingStore,
  evaluatePairing,
  formatPairingPrompt,
} from "./acl.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-platform access control lists. */
export interface AccessControl {
  allowedUsers: string[];
  allowedChats: string[];
}

export interface MessageHandlerOptions {
  provider: HttpProvider;
  sessionStore: SessionStore;
  toolRegistry?: ToolRegistry;
  deliveryRouter?: DeliveryRouter;
  sessionPolicy: SessionResetPolicy;
  groupSessionsPerUser?: boolean;
  systemPrompt?: string;
  config?: import("../core/config-schema.js").Config;
  memoriesDir?: string;
  skillsDir?: string;
  mediaCacheDir?: string;
  whisperApiKey?: string;
  /** Per-platform access control. Keys are platform names (e.g. "telegram"). */
  accessControl?: Record<string, AccessControl>;
  /** Gateway config for pulling per-platform access control settings. */
  gatewayConfig?: GatewayConfig;
  /** Permission model for gateway mode (deny-by-default). */
  permissions?: PermissionModel;
  /** How long a gateway clarification may wait before resolving with its default. */
  clarifyTimeoutMs?: number;
  /**
   * Optional pairing-based ACL. When provided, the handler treats the
   * gateway as multi-user with explicit admin approval — see
   * `src/gateway/acl.ts`.
   */
  pairingStore?: PairingStore;
}

/** In-memory session metadata (tracks lastActivity separately from the DB). */
interface LiveSession {
  sessionId: string;
  lastActivity: number;
  messageCount: number;
}

interface PendingClarification {
  id: string;
  request: ClarifyRequest;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (response: ClarifyResponse) => void;
}

const DEFAULT_CLARIFY_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// MessageHandler
// ---------------------------------------------------------------------------

export class MessageHandler {
  private readonly provider: HttpProvider;
  private readonly sessionStore: SessionStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly deliveryRouter?: DeliveryRouter;
  private readonly sessionPolicy: SessionResetPolicy;
  private readonly groupPerUser: boolean;
  private readonly systemPrompt?: string;
  private readonly config?: import("../core/config-schema.js").Config;
  private readonly cachedMemorySnapshot?: string;
  private readonly cachedSkillIndex?: string;
  private readonly mediaCache: MediaCache;
  private readonly whisperApiKey?: string;
  /** Per-platform access control maps. */
  private readonly permissions?: PermissionModel;
  private readonly accessControl: Record<string, AccessControl>;
  private readonly clarifyTimeoutMs: number;
  private readonly pairingStore?: PairingStore;

  /** session-key → live metadata */
  private readonly sessions = new Map<string, LiveSession>();
  private readonly pendingClarifications = new Map<string, PendingClarification>();

  constructor(options: MessageHandlerOptions) {
    this.provider = options.provider;
    this.sessionStore = options.sessionStore;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.deliveryRouter = options.deliveryRouter;
    this.sessionPolicy = options.sessionPolicy;
    this.groupPerUser = options.groupSessionsPerUser ?? true;
    this.systemPrompt = options.systemPrompt;
    this.config = options.config;
    this.permissions = options.permissions;
    this.whisperApiKey = options.whisperApiKey;
    this.clarifyTimeoutMs = options.clarifyTimeoutMs ?? DEFAULT_CLARIFY_TIMEOUT_MS;
    this.pairingStore = options.pairingStore;

    // Build access control from explicit option or gateway config
    this.accessControl = options.accessControl ?? {};
    if (options.gatewayConfig) {
      const p = options.gatewayConfig.platforms;
      for (const [name, cfg] of Object.entries(p)) {
        if (cfg && "accessControl" in cfg && cfg.accessControl && !this.accessControl[name]) {
          this.accessControl[name] = {
            allowedUsers: cfg.accessControl.allowedUsers,
            allowedChats: cfg.accessControl.allowedChats,
          };
        }
      }
    }

    const cacheDir = options.mediaCacheDir ?? join(homedir(), ".purrfect", "cache");
    this.mediaCache = new MediaCache(cacheDir);

    // Cache memory snapshot once at startup
    try {
      const memoriesDir = options.memoriesDir ?? join(homedir(), ".purrfect", "memories");
      const snapshot = new MemoryStore(memoriesDir).getSnapshot();
      if (snapshot) this.cachedMemorySnapshot = snapshot;
    } catch {
      // Memory unavailable
    }

    // Cache skill index once at startup
    try {
      const skillsDir = options.skillsDir ?? options.config?.skillsDir;
      if (skillsDir) {
        const reg = new SkillRegistry();
        reg.discover(skillsDir);
        const files = readdirSync(skillsDir).filter((f: string) => f.endsWith(".md")).sort();
        const names: string[] = [];
        for (const file of files) {
          const skill = reg.dispatch(file.replace(/\.md$/, ""));
          if (skill) {
            const triggers = skill.triggers.map((t: string) => t).join(", ");
            names.push(`${skill.name} (${triggers})`);
          }
        }
        if (names.length > 0) {
          this.cachedSkillIndex = `Available skills: ${names.join(", ")}`;
        }
      }
    } catch {
      // Skills unavailable
    }

    // Clean stale cached files on startup
    this.mediaCache.cleanup().catch(() => {});
  }

  /**
   * Handle an inbound message event from a platform adapter.
   */
  async handle(event: MessageEvent, adapter: BaseAdapter): Promise<void> {
    // ── Pairing-based ACL (optional) ───────────────────────────────────
    if (this.pairingStore) {
      const decision = evaluatePairing(
        this.pairingStore,
        event.source.platform,
        event.source.userId,
        { requireApproval: true, userName: event.source.userName },
      );
      if (decision.kind === "pending") {
        await adapter.send(event.source.chatId, formatPairingPrompt(decision.entry));
        return;
      }
      if (decision.kind === "denied") {
        await adapter.send(event.source.chatId, decision.reason);
        return;
      }
      // decision.kind === "allow" → fall through
    }

    // ── Access control check ────────────────────────────────────────────
    if (!this.isAllowed(event)) {
      await adapter.send(
        event.source.chatId,
        "You don't have access to this agent.",
      );
      return;
    }

    const key = buildSessionKey(event.source, this.groupPerUser);

    const existing = this.sessions.get(key);
    if (existing && shouldResetSession(existing.lastActivity, this.sessionPolicy)) {
      const stalePending = this.pendingClarifications.get(key);
      if (stalePending) {
        this.resolvePendingClarification(key, stalePending, {
          answer: stalePending.request.default ?? "",
          timedOut: true,
        });
      }
      this.sessions.delete(key);
    }

    const clarificationId = event.metadata?.clarificationId;
    const pending = this.pendingClarifications.get(key);
    if (clarificationId && (!pending || pending.id !== clarificationId)) {
      return;
    }

    if (pending) {
      this.resolvePendingClarification(
        key,
        pending,
        resolveClarifyAnswer(event.text, pending.request),
      );
      const liveSession = this.sessions.get(key);
      if (liveSession) {
        liveSession.lastActivity = Date.now();
      }
      return;
    }

    // Get or create session
    let live = this.sessions.get(key);
    if (!live) {
      const sessionId = randomUUID();
      this.sessionStore.createSession({
        id: sessionId,
        model: "gateway",
        source: key,
      });
      live = { sessionId, lastActivity: Date.now(), messageCount: 0 };
      this.sessions.set(key, live);
    }

    // Increment message count and log
    live.messageCount += 1;
    console.log(
      `[${event.source.platform}:${event.source.userId}] Message #${live.messageCount}`,
    );

    // Resolve media and build the agent input text
    const agentInput = await this.resolveMediaInput(event);

    // Build context prompt
    const contextPrompt = this.buildContextPrompt(event);

    // Per-message registry cloning is deliberate: send_message and clarify both
    // close over the source adapter/chat. Keeping those closures out of the
    // shared registry avoids cross-session origin bleed in concurrent gateways.
    let loopRegistry = new ToolRegistry();
    for (const name of this.toolRegistry.getAllToolNames()) {
      const def = this.toolRegistry.getDefinition(name);
      if (def) loopRegistry.register(def);
    }
    if (this.deliveryRouter) {
      // Register per-message send_message with origin context captured in closure
      const originTool = createSendMessageTool({
        router: this.deliveryRouter,
        originAdapter: adapter,
        originChatId: event.source.chatId,
      });
      // Remove the shared send_message if present, replace with origin-aware version
      loopRegistry.deregister("send_message");
      loopRegistry.register(originTool);
    }
    loopRegistry.deregister("clarify");
    loopRegistry.register(
      createClarifyTool({
        askClarification: (request) =>
          this.askGatewayClarification(key, event, adapter, request),
      }),
    );

    // Create AgentLoop and run
    const loop = new AgentLoop({
      provider: this.provider,
      toolRegistry: loopRegistry,
      systemPrompt: contextPrompt,
      sessionStore: this.sessionStore,
      sessionId: live.sessionId,
      permissions: this.permissions,
      modelName: this.config?.model,
      userHooks: (this.config as { hooks?: import("../core/user-hooks.js").UserHooksConfig } | undefined)?.hooks,
    });

    try {
      let responseText = "";
      let errorText = "";
      for await (const ev of loop.run(agentInput)) {
        if (ev.type === "completion" && ev.message.content) {
          responseText = ev.message.content;
        } else if (ev.type === "error") {
          errorText = ev.error.message;
        }
      }

      if (responseText) {
        const formatted = formatForPlatform(responseText, event.source.platform);
        await adapter.send(event.source.chatId, formatted);
      } else if (errorText) {
        await adapter.send(event.source.chatId, `Error: ${errorText}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await adapter.send(
        event.source.chatId,
        `Error: ${errorMsg}`,
      );
    }

    // Update lastActivity
    live.lastActivity = Date.now();
  }

  private async askGatewayClarification(
    key: string,
    event: MessageEvent,
    adapter: BaseAdapter,
    request: ClarifyRequest,
  ): Promise<ClarifyResponse> {
    if (this.pendingClarifications.has(key)) {
      return { answer: "", alreadyPending: true };
    }

    const requestWithId: ClarifyRequest = {
      ...request,
      id: request.id ?? randomUUID(),
    };
    const responsePromise = new Promise<ClarifyResponse>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingClarifications.get(key);
        if (!pending || pending.id !== requestWithId.id) return;
        this.resolvePendingClarification(key, pending, {
          answer: requestWithId.default ?? "",
          timedOut: true,
        });
      }, this.clarifyTimeoutMs);
      timeout.unref?.();
      this.pendingClarifications.set(key, {
        id: requestWithId.id!,
        request: requestWithId,
        timeout,
        resolve,
      });
    });

    try {
      const result = await adapter.sendClarification(event.source.chatId, requestWithId);
      if (!result.success) {
        this.clearPendingClarification(key);
        throw new Error(result.error ?? "failed to send clarification");
      }
    } catch (err) {
      this.clearPendingClarification(key);
      throw err;
    }

    return responsePromise;
  }

  private resolvePendingClarification(
    key: string,
    pending: PendingClarification,
    response: ClarifyResponse,
  ): void {
    this.clearPendingClarification(key, pending);
    pending.resolve(response);
  }

  private clearPendingClarification(
    key: string,
    pending: PendingClarification | undefined = this.pendingClarifications.get(key),
  ): void {
    if (pending) {
      clearTimeout(pending.timeout);
    }
    this.pendingClarifications.delete(key);
  }

  /**
   * Download media attachments and build the final text sent to the agent.
   */
  private async resolveMediaInput(event: MessageEvent): Promise<string> {
    const urls = event.mediaUrls ?? [];

    if (event.messageType === "voice" && urls.length > 0) {
      const localPath = await this.mediaCache.download(urls[0]);
      if (localPath) {
        const transcription = await this.mediaCache.transcribeVoice(
          localPath,
          this.whisperApiKey,
        );
        return event.text ? `${event.text}\n\n${transcription}` : transcription;
      }
      return event.text;
    }

    if (event.messageType === "photo" && urls.length > 0) {
      const paths: string[] = [];
      for (const url of urls) {
        const localPath = await this.mediaCache.download(url);
        if (localPath) paths.push(localPath);
      }
      if (paths.length > 0) {
        return `${event.text}\n\n[Attached images: ${paths.join(", ")}]`;
      }
      return event.text;
    }

    if (event.messageType === "document" && urls.length > 0) {
      const paths: string[] = [];
      for (const url of urls) {
        const localPath = await this.mediaCache.download(url);
        if (localPath) paths.push(localPath);
      }
      if (paths.length > 0) {
        return `${event.text}\n\n[Attached documents: ${paths.join(", ")}]`;
      }
      return event.text;
    }

    return event.text;
  }

  private buildContextPrompt(event: MessageEvent): string {
    // If a full config is available, use buildAgentContext for a richer prompt
    if (this.config) {
      const platformHint = `Connected via ${event.source.platform} in ${event.source.chatType}`;
      return buildAgentContext({
        config: this.config,
        memorySnapshot: this.cachedMemorySnapshot,
        skillIndex: this.cachedSkillIndex,
        platformHint,
        hasClarifyTool: true,
      });
    }

    // Fallback: legacy minimal context
    const parts: string[] = [];

    if (this.systemPrompt) {
      parts.push(this.systemPrompt);
    }

    parts.push(
      `Connected via ${event.source.platform} in ${event.source.chatType}`,
    );

    return parts.join("\n\n");
  }

  /**
   * Check whether the inbound event is permitted by the platform's access
   * control lists. If no access control is configured for the platform,
   * the message is allowed (open by default).
   */
  private isAllowed(event: MessageEvent): boolean {
    const acl = this.accessControl[event.source.platform];
    if (!acl) return true;

    const hasUsers = acl.allowedUsers.length > 0;
    const hasChats = acl.allowedChats.length > 0;

    // No restrictions configured → allow
    if (!hasUsers && !hasChats) return true;

    if (hasUsers && acl.allowedUsers.includes(event.source.userId)) return true;
    if (hasChats && acl.allowedChats.includes(event.source.chatId)) return true;

    return false;
  }

  /** Expose live sessions for testing. */
  getSession(key: string): LiveSession | undefined {
    return this.sessions.get(key);
  }

  /**
   * Fire user `stop` hooks once, on gateway shutdown. Called from
   * gateway-runner's SIGTERM/SIGINT handler so configured stop hooks
   * actually run for gateway sessions (parity with REPL rl-close).
   */
  async fireStopHooks(): Promise<void> {
    const hooks = (this.config as { hooks?: import("../core/user-hooks.js").UserHooksConfig } | undefined)?.hooks;
    if (!hooks) return;
    try {
      const { runUserHooks } = await import("../core/user-hooks.js");
      await runUserHooks(hooks, "stop", { toolName: "", args: {} });
    } catch {
      // best-effort
    }
  }
}
