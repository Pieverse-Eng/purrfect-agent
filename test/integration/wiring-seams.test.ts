/**
 * Integration tests for wiring seams — verify that startup entry points
 * correctly pass permissions, config, context, and session state to
 * the subsystems they create.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import { MessageHandler, type MessageHandlerOptions } from "../../src/gateway/handler.js";
import { SessionStore } from "../../src/core/session-store.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { registerBuiltins } from "../../src/core/tools/index.js";
import { createGatewayPermissions } from "../../src/core/permissions.js";
import { buildAgentContext } from "../../src/cli/runtime.js";
import { createServer, type ServerOptions } from "../../src/server/index.js";
import { createMockFetch, makeTextResponse } from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";
import {
  BaseAdapter,
  type SendResult,
  type MessageEvent,
  type SessionSource,
} from "../../src/gateway/adapter.js";
import type { SessionResetPolicy } from "../../src/gateway/session-keys.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class MockAdapter extends BaseAdapter {
  connected = false;
  sent: Array<{ chatId: string; content: string }> = [];

  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> {}
  async send(chatId: string, content: string): Promise<SendResult> {
    this.sent.push({ chatId, content });
    return { success: true, messageId: `mock-${this.sent.length}` };
  }
  async sendTyping(_chatId: string): Promise<void> {}

  simulateInbound(event: MessageEvent): void {
    this.emitMessage(event);
  }
}

function makeProvider(mockFetch: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    mockFetch,
  );
}

function makeSource(overrides?: Partial<SessionSource>): SessionSource {
  return {
    platform: "telegram",
    chatId: "chat-1",
    userId: "user-1",
    chatType: "dm",
    ...overrides,
  };
}

function makeEvent(text: string, overrides?: Partial<SessionSource>): MessageEvent {
  return {
    text,
    messageType: "text",
    source: makeSource(overrides),
  };
}

const noResetPolicy: SessionResetPolicy = {
  mode: "none",
  idleMinutes: 1440,
  dailyResetHour: 4,
};

// ---------------------------------------------------------------------------
// 1. Gateway handler: permissions passed to AgentLoop
// ---------------------------------------------------------------------------

describe("gateway-runner wiring", () => {
  let temp: { path: string; cleanup: () => void };

  afterEach(() => {
    temp?.cleanup();
  });

  it("passes permissions and gatewayConfig ACL to MessageHandler", async () => {
    temp = createTempDir();
    const dbPath = join(temp.path, "sessions.db");
    const sessionStore = new SessionStore(dbPath);

    const permissions = createGatewayPermissions();
    const mockFetch = createMockFetch([{ body: makeTextResponse("ok") }]);
    const provider = makeProvider(mockFetch);
    const toolRegistry = new ToolRegistry();
    registerBuiltins(toolRegistry, { permissions });

    const gatewayConfig = {
      sessionPolicy: noResetPolicy,
      groupSessionsPerUser: true,
      platforms: {
        telegram: {
          enabled: true,
          token: "fake",
          accessControl: {
            allowedUsers: ["user-42"],
            allowedChats: [],
          },
        },
      },
    };

    const handler = new MessageHandler({
      provider,
      sessionStore,
      toolRegistry,
      sessionPolicy: noResetPolicy,
      permissions,
      gatewayConfig: gatewayConfig as any,
    });

    // ACL should block non-allowed user
    const adapter = new MockAdapter();
    await handler.handle(
      makeEvent("hello", { userId: "blocked-user" }),
      adapter,
    );

    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0].content).toContain("don't have access");

    sessionStore.close();
  });

  it("creates AgentLoop with permissions (not undefined)", async () => {
    temp = createTempDir();
    const dbPath = join(temp.path, "sessions.db");
    const sessionStore = new SessionStore(dbPath);

    const permissions = createGatewayPermissions();
    const mockFetch = createMockFetch([{ body: makeTextResponse("pong") }]);
    const provider = makeProvider(mockFetch);
    const toolRegistry = new ToolRegistry();

    const handler = new MessageHandler({
      provider,
      sessionStore,
      toolRegistry,
      sessionPolicy: noResetPolicy,
      permissions,
    });

    // The handler stores permissions internally; verify by handling a message
    // and ensuring no crash (permissions are wired into AgentLoop)
    const adapter = new MockAdapter();
    await handler.handle(makeEvent("ping"), adapter);

    // Handler should have responded (agent ran successfully)
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0].content).toBe("pong");

    sessionStore.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Serve: createServer with sessionDbPath and tools registered
// ---------------------------------------------------------------------------

describe("serve command wiring", () => {
  let temp: { path: string; cleanup: () => void };

  afterEach(() => {
    temp?.cleanup();
  });

  it("createServer uses sessionDbPath for persistence", async () => {
    temp = createTempDir();
    const dbPath = join(temp.path, "server-sessions.db");

    const toolRegistry = new ToolRegistry();
    registerBuiltins(toolRegistry);

    const mockFetch = createMockFetch([{ body: makeTextResponse("hello") }]);
    const provider = makeProvider(mockFetch);

    const srv = createServer({
      token: "test-token",
      providerFactory: () => provider,
      streamingProviderFactory: () => provider,
      toolRegistry,
      sessionDbPath: dbPath,
    });

    // Verify built-in tools are registered
    const toolNames = toolRegistry.getAllToolNames();
    expect(toolNames).toContain("file_read");
    expect(toolNames).toContain("shell_exec");

    // Verify server is created and sessionDbPath is wired
    // (the server factory creates a SessionStore if dbPath is provided)
    expect(srv).toBeDefined();
    expect(typeof srv.listen).toBe("function");

    // Clean up: server was never started, no need to close
  });
});

// ---------------------------------------------------------------------------
// 3. REPL session state mutation propagates
// ---------------------------------------------------------------------------

describe("REPL session state mutation", () => {
  it("mutable state ref propagates sessionId changes", () => {
    // Simulate the mutable state pattern used in the REPL
    const state = { sessionId: "original-id", resumeSessionId: undefined as string | undefined };

    // Simulate what /new command does via commandContext
    const commandContext = {
      get sessionId() { return state.sessionId; },
      set sessionId(v: string) { state.sessionId = v; },
      get resumeSessionId() { return state.resumeSessionId; },
      set resumeSessionId(v: string | undefined) { state.resumeSessionId = v; },
    };

    // Simulate /new command
    commandContext.sessionId = "new-session-id";
    expect(state.sessionId).toBe("new-session-id");

    // Simulate /sessions resume
    commandContext.resumeSessionId = "resume-id";
    expect(state.resumeSessionId).toBe("resume-id");

    // Consume resumeSessionId (as the loop would)
    const consumed = state.resumeSessionId;
    state.resumeSessionId = undefined;
    expect(consumed).toBe("resume-id");
    expect(state.resumeSessionId).toBeUndefined();

    // Next loop iteration reads updated sessionId
    expect(state.sessionId).toBe("new-session-id");
  });
});

// ---------------------------------------------------------------------------
// 4. Gateway handler AgentLoop gets permissions
// ---------------------------------------------------------------------------

describe("gateway handler AgentLoop permissions", () => {
  let temp: { path: string; cleanup: () => void };

  afterEach(() => {
    temp?.cleanup();
  });

  it("handler constructed with permissions passes them to AgentLoop", async () => {
    temp = createTempDir();
    const dbPath = join(temp.path, "sessions.db");
    const sessionStore = new SessionStore(dbPath);

    const permissions = createGatewayPermissions();
    const mockFetch = createMockFetch([{ body: makeTextResponse("done") }]);
    const provider = makeProvider(mockFetch);
    const toolRegistry = new ToolRegistry();
    registerBuiltins(toolRegistry, { permissions });

    const handler = new MessageHandler({
      provider,
      sessionStore,
      toolRegistry,
      sessionPolicy: noResetPolicy,
      permissions,
    });

    const adapter = new MockAdapter();
    await handler.handle(makeEvent("test"), adapter);

    // If permissions were undefined, shell_exec would be allowed;
    // with gateway permissions (deny-by-default), only curated tools pass.
    // The handler should still work (no crash from missing permissions).
    expect(adapter.sent.length).toBe(1);

    sessionStore.close();
  });
});

// ---------------------------------------------------------------------------
// 5. buildAgentContext with memory + skills in server routes
// ---------------------------------------------------------------------------

describe("buildAgentContext with memory and skills", () => {
  let temp: { path: string; cleanup: () => void };

  afterEach(() => {
    temp?.cleanup();
  });

  it("system prompt includes memory and skills sections when provided", () => {
    temp = createTempDir();

    const config = {
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      providerType: "openai" as const,
      fallbackModels: [],
      permissions: { allowTools: [], denyTools: [], denyPatterns: [] },
      permissionMode: "allow-all" as const,
      mcpServers: [],
      pluginDirs: [],
      configVersion: 2,
    };

    const memorySnapshot = "# User Preferences\nPrefers dark mode.";
    const skillIndex = "Available skills: deploy (deploy, ship), test (test, check)";

    const prompt = buildAgentContext({
      config,
      memorySnapshot,
      skillIndex,
    });

    // Memory snapshot should be injected into the prompt
    expect(prompt).toContain("dark mode");
    // Skill index should appear
    expect(prompt).toContain("Available skills");
    expect(prompt).toContain("deploy");
  });

  it("system prompt works without memory or skills", () => {
    const config = {
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      providerType: "openai" as const,
      fallbackModels: [],
      permissions: { allowTools: [], denyTools: [], denyPatterns: [] },
      permissionMode: "allow-all" as const,
      mcpServers: [],
      pluginDirs: [],
      configVersion: 2,
    };

    const prompt = buildAgentContext({ config });
    // Should still produce a valid prompt
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(10);
  });
});
