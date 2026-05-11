/**
 * One-shot mode — run a single prompt and exit.
 */

import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentLoop } from "../core/agent-loop.js";
import type { AgentEvent } from "../core/agent-loop.js";
import { HttpProvider } from "../core/provider.js";
import { AnthropicProvider } from "../core/anthropic-provider.js";
import { ModelRouter, type ModelEntry } from "../core/router.js";
import { SmartModelRoutingController } from "../core/model-routing.js";
import { getModelMetadata } from "../core/model-metadata.js";
import { resolveApiKey } from "../core/secrets.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { registerBuiltins } from "../core/tools/index.js";
import { SessionStore } from "../core/session-store.js";
import { loadConfigV2, defaultConfigDir } from "./config.js";
import { formatApprovalPrompt, parseApprovalResponse, logApprovalDecision } from "./approval.js";
import { InterruptController } from "./interrupt.js";
import { buildPermissionModel, buildAgentContext } from "./runtime.js";
import { MemoryStore } from "../core/memory/store.js";
import { loadRuntimeSkills } from "../core/skills/layers.js";
import {
  formatToolCall,
  formatTodoList,
  formatToolResult,
  formatError,
  ansiColor,
} from "./formatter.js";
import { McpClient } from "../core/mcp/client.js";
import { PluginDiscovery } from "../core/plugins/discovery.js";
import { PluginLoader } from "../core/plugins/loader.js";
import { HookRegistry } from "../core/plugins/hooks.js";
import { CredentialPool } from "../core/credential-pool.js";

export async function runOneshot(prompt: string, configDir?: string): Promise<void> {
  const dir = configDir ?? defaultConfigDir();
  const config = loadConfigV2(dir);

  const providerType = config.providerType as "openai" | "anthropic";
  const credentialPool = new CredentialPool({ path: join(dir, "credentials.json") });
  const apiKey = resolveApiKey(config.apiKey, providerType);
  if (!apiKey && credentialPool.availableCount(providerType) === 0) {
    console.error("No API key configured. Run 'purrfect setup' first.");
    process.exit(1);
  }

  const tierModels = config.modelTiers ?? {};
  const smartRoutingEnabled =
    config.smartModelRouting?.enabled ||
    Object.values(tierModels).some((model) => typeof model === "string" && model.length > 0);
  const primaryEntry: ModelEntry = {
    name: config.model,
    provider: providerType,
    config: {
      baseUrl: config.baseUrl,
      apiKey: apiKey ?? "",
      model: config.model,
      credentialPool,
      providerType,
    },
  };
  const additionalModelNames = [
    ...(config.fallbackModels ?? []),
    ...Object.values(tierModels).filter((model): model is string => typeof model === "string"),
  ].filter((model, index, models) => model !== config.model && models.indexOf(model) === index);
  const fallbackEntries: ModelEntry[] = additionalModelNames.map(
    (modelName: string) => {
      const meta = getModelMetadata(modelName);
      const fallbackApiKey =
        resolveApiKey(config.apiKey, meta.provider) ?? apiKey ?? "";
      return {
        name: modelName,
        provider: meta.provider,
        config: {
          baseUrl: config.baseUrl,
          apiKey: fallbackApiKey,
          model: modelName,
          credentialPool,
          providerType: meta.provider,
        },
      } as ModelEntry;
    },
  );
  const router = new ModelRouter({ models: [primaryEntry, ...fallbackEntries] });
  const provider = router as unknown as HttpProvider;
  const smartModelRouting = smartRoutingEnabled
    ? new SmartModelRoutingController({
        tierModels: {
          fast: tierModels.fast ?? config.model,
          balanced: tierModels.balanced ?? config.model,
          deep: tierModels.deep ?? config.model,
        },
      })
    : undefined;

  const dbPath = join(dir, "sessions.db");
  const sessionStore = new SessionStore(dbPath);
  const sessionId = randomUUID();
  // Load memory snapshot
  let memorySnapshot: string | undefined;
  try {
    const memoriesDir = config.memoriesDir ?? join(dir, "memories");
    const snapshot = new MemoryStore(memoriesDir).getSnapshot();
    if (snapshot) memorySnapshot = snapshot;
  } catch {
    // Memory unavailable — proceed without it
  }

  // Load skill registry and index
  let runtimeSkills = loadRuntimeSkills({ configDir: dir, config });
  try {
    runtimeSkills = loadRuntimeSkills({ configDir: dir, config });
  } catch {
    // Skills unavailable — proceed without them
  }

  const systemPrompt = buildAgentContext({
    config,
    memorySnapshot,
    skillIndex: runtimeSkills.skillIndex,
    hasMemoryTool: true,
    hasSessionSearchTool: true,
    hasTodoWriteTool: true,
  });
  const childSystemPrompt = buildAgentContext({
    config,
    memorySnapshot,
    skillIndex: runtimeSkills.skillIndex,
    hasMemoryTool: true,
    hasSessionSearchTool: true,
    hasTodoWriteTool: false,
  });
  const permissions = buildPermissionModel(config);
  const toolRegistry = new ToolRegistry();
  const interrupts = new InterruptController();
  const rl = process.stdin.isTTY && process.stdout.isTTY
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;

  sessionStore.createSession({
    id: sessionId,
    model: config.model,
    source: "oneshot",
    title: prompt.slice(0, 80),
  });

  const approvalHandler = rl
    ? async (
        toolName: string,
        args: Record<string, unknown>,
        context?: { reason?: string },
      ): Promise<"allow_once" | "allow_session" | "deny"> => {
        console.log(formatApprovalPrompt(toolName, args, context?.reason ?? "permission denied"));
        const answer = await askQuestion(
          rl,
          ansiColor("Approve [1/2/3]: ", "yellow"),
        );
        const decision = parseApprovalResponse(answer);
        try {
          logApprovalDecision(sessionStore, sessionId, toolName, decision);
        } catch {
          // Approval logging is best-effort; denied tool execution remains the safe default.
        }
        return decision;
      }
    : undefined;

  const { createMemoryBackend } = await import("../core/memory/backend.js");
  const oneshotMemoriesDir = config.memoriesDir ?? join(dir, "memories");
  const memoryBackend = createMemoryBackend({
    dir: oneshotMemoriesDir,
    config: (config as any).memory,
  });
  registerBuiltins(toolRegistry, {
    sessionStore,
    provider,
    permissions,
    systemPrompt,
    childSystemPrompt,
    onApprovalRequired: approvalHandler,
    platform: "purrfect-cli",
    modelName: config.model,
    sandboxMode: config.sandbox,
    skillRegistry: runtimeSkills.skillsMap ? runtimeSkills.registry : undefined,
    skillsDir: runtimeSkills.personalDir,
    getSessionId: () => sessionId,
    memoryBackend,
  });

  // ── MCP servers ─────────────────────────────────────────────────
  const mcpClients: McpClient[] = [];
  const mcpServers = (config as any).mcpServers ?? [];
  for (const server of mcpServers) {
    try {
      const client = new McpClient(toolRegistry, {
        command: server.command,
        args: server.args,
        env: server.env,
        enabledTools: server.enabledTools,
      });
      await client.connect();
      mcpClients.push(client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`MCP server "${server.name}" unavailable: ${msg}`);
    }
  }

  // ── Plugins ─────────────────────────────────────────────────────
  const hookRegistry = new HookRegistry();
  const pluginDirs: string[] = (config as any).pluginDirs ?? [];
  if (pluginDirs.length > 0) {
    try {
      const manifests = await PluginDiscovery.scan(pluginDirs);
      const loader = new PluginLoader();
      for (const manifest of manifests) {
        try {
          await loader.load(manifest, toolRegistry, hookRegistry);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Plugin "${manifest.name}" failed to load: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Plugin discovery failed: ${msg}`);
    }
  }

  const loop = new AgentLoop({
    provider,
    toolRegistry,
    permissions,
    sessionStore,
    sessionId,
    systemPrompt,
    skillRegistry: runtimeSkills.skillsMap,
    stream: true,
    onApprovalRequired: approvalHandler,
    modelName: config.model,
    smartModelRouting,
  });

  const signal = interrupts.start();
  const handleSigint = () => {
    if (interrupts.interrupt() === "force-exit") {
      rl?.close();
      process.exit(130);
    }
  };

  process.on("SIGINT", handleSigint);

  try {
    let streamed = false;
    for await (const event of loop.run(prompt, { signal })) {
      if (event.type === "text_delta") streamed = true;
      if (event.type === "completion" && streamed) continue;
      handleEvent(event);
    }
    if (interrupts.interrupted) {
      console.log("\n" + ansiColor("[interrupted]", "yellow"));
    }
    console.log(); // trailing newline
  } finally {
    for (const client of mcpClients) {
      try { await client.disconnect(); } catch { /* best-effort */ }
    }
    process.off("SIGINT", handleSigint);
    rl?.close();
    sessionStore.endSession(sessionId);
    sessionStore.close();
  }
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.content);
      break;
    case "tool_call_start": {
      const name = event.toolCall.function.name;
      if (name === "todo_write") {
        console.log("\n" + formatToolCall(name, {}));
        break;
      }
      const args = event.toolCall.function.arguments
        ? JSON.parse(event.toolCall.function.arguments)
        : {};
      console.log("\n" + formatToolCall(name, args));
      break;
    }
    case "tool_result":
      if (event.name === "todo_write") {
        try {
          const parsed = JSON.parse(event.result) as {
            todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }>;
            error?: string;
          };
          if (parsed.error) {
            console.log(formatToolResult(event.name, event.result));
          } else if (parsed.todos) {
            console.log(formatTodoList(parsed.todos));
          }
        } catch {
          console.log(formatToolResult(event.name, event.result));
        }
        break;
      }
      console.log(formatToolResult(event.name, event.result));
      break;
    case "usage":
      break;
    case "completion":
      if (event.message.content) {
        process.stdout.write(event.message.content);
      }
      break;
    case "error":
      console.error("\n" + formatError(event.error.message));
      break;
    case "budget_exceeded":
      console.log("\n" + ansiColor("⚠ iteration budget exceeded", "yellow"));
      break;
    case "warning":
      console.log("\n" + ansiColor(`⚠ ${event.message}`, "yellow"));
      break;
  }
}
