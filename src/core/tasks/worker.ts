/**
 * Background task worker — runs as a forked child process.
 *
 * Receives task config via IPC message, creates an AgentLoop,
 * runs the prompt, writes output to disk, and reports status back.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentLoop } from "../agent-loop.js";
import type { AgentEvent } from "../agent-loop.js";
import { HttpProvider } from "../provider.js";
import { AnthropicProvider } from "../anthropic-provider.js";
import { ModelRouter, type ModelEntry } from "../router.js";
import { getModelMetadata } from "../model-metadata.js";
import { resolveApiKey } from "../secrets.js";
import { ToolRegistry } from "../tool-registry.js";
import { registerBuiltins } from "../tools/index.js";
import { SessionStore } from "../session-store.js";
import { loadConfigV2 } from "../../cli/config.js";
import { buildPermissionModel, buildAgentContext } from "../../cli/runtime.js";
import { MemoryStore } from "../memory/store.js";
import { loadRuntimeSkills } from "../skills/layers.js";
import { McpClient } from "../mcp/client.js";
import { PluginDiscovery } from "../plugins/discovery.js";
import { PluginLoader } from "../plugins/loader.js";
import { HookRegistry } from "../plugins/hooks.js";

export interface WorkerMessage {
  prompt: string;
  configDir: string;
  taskId: string;
}

export interface WorkerResult {
  status: "completed" | "failed";
  result?: string;
  error?: string;
}

function appendOutput(outputPath: string, event: Record<string, unknown>): void {
  appendFileSync(outputPath, JSON.stringify(event) + "\n", "utf-8");
}

async function runWorker(msg: WorkerMessage): Promise<void> {
  const { prompt, configDir, taskId } = msg;

  const outputDir = join(configDir, "tasks", taskId);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = join(outputDir, "output.jsonl");

  try {
    const config = loadConfigV2(configDir);

    const apiKey = resolveApiKey(config.apiKey, config.providerType as "openai" | "anthropic");
    if (!apiKey) {
      throw new Error("No API key configured. Run 'purrfect setup' first.");
    }

    const primaryEntry: ModelEntry = {
      name: config.model,
      provider: config.providerType as "openai" | "anthropic",
      config: { baseUrl: config.baseUrl, apiKey, model: config.model },
    };
    const fallbackEntries: ModelEntry[] = (config.fallbackModels ?? []).map(
      (modelName: string) => {
        const meta = getModelMetadata(modelName);
        return {
          name: modelName,
          provider: meta.provider,
          config: { baseUrl: config.baseUrl, apiKey, model: modelName },
        } as ModelEntry;
      },
    );
    const router = new ModelRouter({ models: [primaryEntry, ...fallbackEntries] });
    const provider = router as unknown as HttpProvider;

    const dbPath = join(configDir, "sessions.db");
    const sessionStore = new SessionStore(dbPath);
    const sessionId = randomUUID();

    // Load memory snapshot
    let memorySnapshot: string | undefined;
    try {
      const memoriesDir = config.memoriesDir ?? join(configDir, "memories");
      const snapshot = new MemoryStore(memoriesDir).getSnapshot();
      if (snapshot) memorySnapshot = snapshot;
    } catch {
      // Memory unavailable — proceed without it
    }

    // Load skill registry
    let runtimeSkills = loadRuntimeSkills({ configDir, config });
    try {
      runtimeSkills = loadRuntimeSkills({ configDir, config });
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

    sessionStore.createSession({
      id: sessionId,
      model: config.model,
      source: "task",
      title: prompt.slice(0, 80),
    });

    registerBuiltins(toolRegistry, {
      sessionStore,
      provider,
      permissions,
      systemPrompt,
      childSystemPrompt,
      platform: "purrfect-cli",
      modelName: config.model,
      sandboxMode: config.sandbox,
      skillRegistry: runtimeSkills.skillsMap ? runtimeSkills.registry : undefined,
      skillsDir: runtimeSkills.personalDir,
      getSessionId: () => sessionId,
    });

    // Load MCP servers
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
      } catch {
        // MCP unavailable in task worker — proceed without it
      }
    }

    // Load plugins
    const hookRegistry = new HookRegistry();
    const pluginDirs: string[] = (config as any).pluginDirs ?? [];
    if (pluginDirs.length > 0) {
      try {
        const manifests = await PluginDiscovery.scan(pluginDirs);
        const loader = new PluginLoader();
        for (const manifest of manifests) {
          try {
            await loader.load(manifest, toolRegistry, hookRegistry);
          } catch {
            // Plugin load failed — proceed without it
          }
        }
      } catch {
        // Plugin discovery failed — proceed without plugins
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
      stream: false,
      modelName: config.model,
    });

    let completionText = "";

    for await (const event of loop.run(prompt)) {
      appendOutput(outputPath, eventToRecord(event));
      if (event.type === "completion" && event.message.content) {
        completionText += event.message.content;
      }
    }

    sessionStore.endSession(sessionId);
    sessionStore.close();

    const result: WorkerResult = { status: "completed", result: completionText };
    if (process.send) {
      process.send(result);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    appendOutput(outputPath, { type: "error", error: errorMessage, timestamp: new Date().toISOString() });

    const result: WorkerResult = { status: "failed", error: errorMessage };
    if (process.send) {
      process.send(result);
    }
  }
}

function eventToRecord(event: AgentEvent): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", content: event.content, timestamp };
    case "tool_call_start":
      return { type: "tool_call_start", toolCall: event.toolCall, timestamp };
    case "tool_result":
      return { type: "tool_result", name: event.name, result: event.result, timestamp };
    case "usage":
      return { type: "usage", usage: event.usage, timestamp };
    case "completion":
      return { type: "completion", content: event.message.content, timestamp };
    case "error":
      return { type: "error", error: event.error.message, timestamp };
    case "budget_exceeded":
      return { type: "budget_exceeded", timestamp };
    case "warning":
      return { type: "warning", message: event.message, timestamp };
  }
}

// ── IPC listener ──────────────────────────────────────────────────────────

if (process.send) {
  process.on("message", (msg: WorkerMessage) => {
    runWorker(msg)
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (process.send) {
          process.send({ status: "failed", error: errorMessage } satisfies WorkerResult);
        }
      })
      .finally(() => {
        process.exit(0);
      });
  });
}
