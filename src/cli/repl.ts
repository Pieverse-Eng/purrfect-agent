/**
 * Interactive REPL — readline interface with streaming output via AgentEvent.
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
import { generateSessionTitle, type TitleProvider } from "../core/title-generator.js";
import { CacheStats } from "../core/cache-stats.js";
import { loadConfigV2, defaultConfigDir } from "./config.js";
import { formatApprovalPrompt, parseApprovalResponse, logApprovalDecision } from "./approval.js";
import { askClarificationWithReadline } from "./clarify.js";
import { InterruptController } from "./interrupt.js";
import { buildPermissionModel, buildAgentContext } from "./runtime.js";
import { VERSION } from "../version.js";
import { MemoryStore } from "../core/memory/store.js";
import { loadRuntimeSkills } from "../core/skills/layers.js";
import {
  formatToolCall,
  formatToolResult,
  formatTodoList,
  formatError,
  formatTokenDisplay,
  formatCost,
  ansiColor,
  spinner,
} from "./formatter.js";
import { buildBanner, buildCompactBanner } from "./banner.js";
import { CommandRegistry, parseSlashCommand } from "./commands/registry.js";
import type { LoadedPluginInfo, ConnectedMcpInfo } from "./commands/registry.js";
import { registerAllCommands } from "./commands/index.js";
import { createCompleter, formatCompletionHint } from "./completer.js";
import { InlineDropdown } from "./dropdown.js";
import { McpClient } from "../core/mcp/client.js";
import { PluginDiscovery } from "../core/plugins/discovery.js";
import { PluginLoader } from "../core/plugins/loader.js";
import { HookRegistry } from "../core/plugins/hooks.js";
import { CheckpointManager } from "../core/checkpoint.js";
import { CredentialPool } from "../core/credential-pool.js";
import { buildToolEnablementMap, isPluginDisabled } from "./toggles.js";

interface TitleGenerationJob {
  provider: TitleProvider;
  sessionStore: SessionStore;
  sessionId: string;
  userMessage: string;
  assistantReply: string;
}

function kickOffTitleGeneration(job: TitleGenerationJob): void {
  // Fire-and-forget: title gen must never block the REPL turn. Swallow
  // everything — callers already received their response by the time this runs.
  void (async () => {
    try {
      const title = await generateSessionTitle({
        provider: job.provider,
        firstUserMessage: job.userMessage,
        firstAssistantReply: job.assistantReply,
      });
      if (title) {
        job.sessionStore.updateSessionTitle(job.sessionId, title);
      }
    } catch {
      // Silent; keep the placeholder title.
    }
  })();
}

export async function startRepl(configDir?: string, options?: { planMode?: boolean }): Promise<void> {
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
  let memoryEntryCount = 0;
  const memoriesDir = config.memoriesDir ?? join(dir, "memories");
  try {
    const memStore = new MemoryStore(memoriesDir);
    // Freeze snapshot at session start for prompt cache stability
    const snapshot = memStore.freezeSnapshot();
    if (snapshot) {
      memorySnapshot = snapshot;
      // Count entries by parsing § headers
      const { parseEntries } = await import("../core/memory/parser.js");
      memoryEntryCount = parseEntries(snapshot).length;
    }
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

  const buildCurrentSystemPrompt = (planMode?: boolean) => buildAgentContext({
    config,
    memorySnapshot,
    skillIndex: runtimeSkills.skillIndex,
    hasMemoryTool: true,
    hasSessionSearchTool: true,
    hasTodoWriteTool: true,
    hasClarifyTool: true,
    planMode,
  });
  const systemPrompt = buildCurrentSystemPrompt();
  // Child agents spawned via `delegate` don't have todo_write, so build a
  // parallel prompt that omits the TODO guidance. Reconstructing from the
  // same inputs is the only reliable way to avoid touching unrelated content.
  // NOTE: planMode is intentionally omitted — `delegate` is in
  // PLAN_MODE_BLOCKED_TOOLS so children can never spawn while plan mode is
  // active. If `delegate` is ever removed from the blocked set, propagate
  // planMode here too.
  const childSystemPrompt = buildAgentContext({
    config,
    memorySnapshot,
    skillIndex: runtimeSkills.skillIndex,
    hasMemoryTool: true,
    hasSessionSearchTool: true,
    hasTodoWriteTool: false,
    hasClarifyTool: true,
  });
  const permissions = buildPermissionModel(config);

  // Mutable state ref so /new and /sessions resume can propagate to the loop
  const state: {
    sessionId: string;
    resumeSessionId: string | undefined;
    /** When true, the next turn will inject full conversation history instead of a recap. */
    fullResumeMessages: boolean;
    /** Running token usage totals across the session, for checkpoint snapshots. */
    cumulativeUsage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
    /** When true, mutating tools are filtered from the agent loop. */
    planMode: boolean;
    /**
     * Tracks sessions that still have the placeholder title — we only try to
     * auto-generate a title the first time the agent replies in that session.
     */
    pendingTitleSessions: Set<string>;
  } = {
    sessionId,
    resumeSessionId: undefined,
    fullResumeMessages: false,
    cumulativeUsage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    planMode: options?.planMode ?? false,
    pendingTitleSessions: new Set([sessionId]),
  };

  sessionStore.createSession({
    id: state.sessionId,
    model: config.model,
    source: "repl",
    title: `REPL session ${new Date().toISOString().slice(0, 19)}`,
  });

  // Mutable reference so the completer delegates to a registry populated later.
  let registryRef: CommandRegistry | undefined;
  const wrapperCompleter = (line: string): [string[], string] => {
    if (!registryRef) return [[], line];
    return createCompleter(registryRef)(line);
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: wrapperCompleter,
  });
  const sp = spinner();
  const interrupts = new InterruptController();

  const approvalHandler = async (
    toolName: string,
    args: Record<string, unknown>,
    context?: { reason?: string },
  ): Promise<"allow_once" | "allow_session" | "deny"> => {
    sp.stop();
    console.log(formatApprovalPrompt(toolName, args, context?.reason ?? "permission denied"));
    const answer = await askQuestion(
      rl,
      ansiColor("Approve [1/2/3]: ", "yellow"),
    );
    const decision = parseApprovalResponse(answer);
    try {
      logApprovalDecision(sessionStore, state.sessionId, toolName, decision);
    } catch {
      // Approval logging is best-effort; denied tool execution remains the safe default.
    }
    return decision;
  };

  const onExitPlanModeApproval = async (): Promise<boolean> => {
    sp.stop();
    console.log(ansiColor("\n── Exit Plan Mode ──", "magenta"));
    console.log("The agent wants to exit Plan Mode and begin execution.");
    const answer = await askQuestion(
      rl,
      ansiColor("Approve? [y/n]: ", "yellow"),
    );
    // Strict match — typos like "yo" must NOT approve a destructive transition.
    const normalized = answer.trim().toLowerCase();
    const approved = normalized === "y" || normalized === "yes";
    if (approved) {
      console.log(ansiColor("Plan Mode deactivated.", "green"));
    } else {
      console.log(ansiColor("Exit denied — Plan Mode remains active.", "yellow"));
    }
    return approved;
  };

  const toolRegistry = new ToolRegistry();
  const { createMemoryBackend } = await import("../core/memory/backend.js");
  const memoryBackend = createMemoryBackend({
    dir: memoriesDir,
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
    getSessionId: () => state.sessionId,
    getPlanMode: () => state.planMode,
    setPlanMode: (v: boolean) => { state.planMode = v; },
    onExitPlanModeApproval,
    onClarify: (request) => askClarificationWithReadline(rl, request),
    memoryBackend,
  });

  // ── MCP servers ─────────────────────────────────────────────────
  const mcpClients: McpClient[] = [];
  const connectedMcpServers: ConnectedMcpInfo[] = [];
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
      // Count tools registered by this server (toolset "mcp")
      const toolCount = toolRegistry.getAllToolNames().filter((n: string) => {
        const def = toolRegistry.getDefinition(n);
        return def?.toolset === "mcp";
      }).length;
      connectedMcpServers.push({ name: server.name, toolCount });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`MCP server "${server.name}" unavailable: ${msg}`);
    }
  }

  // ── Plugins ─────────────────────────────────────────────────────
  const loadedPlugins: LoadedPluginInfo[] = [];
  const hookRegistry = new HookRegistry();
  const pluginDirs: string[] = (config as any).pluginDirs ?? [];
  if (pluginDirs.length > 0) {
    try {
      const manifests = await PluginDiscovery.scan(pluginDirs);
      const loader = new PluginLoader();
      for (const manifest of manifests) {
        if (isPluginDisabled(manifest.name, dir)) {
          continue;
        }
        try {
          await loader.load(manifest, toolRegistry, hookRegistry);
          loadedPlugins.push({
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            capabilities: manifest.capabilities as Record<string, string[] | undefined>,
          });
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

  // Apply persisted tool-enablement overrides after every source has registered.
  toolRegistry.applyEnablement(buildToolEnablementMap(dir));

  // ── Command registry ──────────────────────────────────────────────
  const commandRegistry = new CommandRegistry();
  registerAllCommands(commandRegistry);

  registryRef = commandRegistry;

  // Custom completion display: show command descriptions when multiple matches.
  (rl as any)[Symbol.for("nodejs.readline.completer.display")] =
    (matches: string[]) => {
      if (matches.length > 1) {
        console.log();
        console.log(formatCompletionHint(matches, commandRegistry));
      }
    };

  // ── Inline completion dropdown ──────────────────────────────────
  const dropdown = new InlineDropdown(commandRegistry.getAll());

  // Enable keypress events on stdin for live dropdown
  readline.emitKeypressEvents(process.stdin, rl);

  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str: string | undefined, key: readline.Key) => {
      if (!key) return;

      const line = (rl as any).line as string | undefined;
      if (!line) {
        if (dropdown.isVisible()) dropdown.hide();
        return;
      }

      // Show/update dropdown when typing a slash command (no space yet)
      if (line.startsWith("/") && !line.includes(" ")) {
        dropdown.show(line.slice(1));
      } else {
        if (dropdown.isVisible()) dropdown.hide();
      }

      if (dropdown.isVisible()) {
        if (key.name === "up") {
          dropdown.moveUp();
        } else if (key.name === "down") {
          dropdown.moveDown();
        } else if (key.name === "tab") {
          const selected = dropdown.getSelected();
          if (selected) {
            // Clear line and write selected command
            rl.write(null as any, { ctrl: true, name: "u" });
            rl.write("/" + selected);
          }
          dropdown.hide();
        } else if (key.name === "escape") {
          dropdown.hide();
        }
      }
    });
  }

  const commandContext = {
    config,
    sessionStore,
    get sessionId() { return state.sessionId; },
    set sessionId(v: string) {
      state.sessionId = v;
      // /new creates a fresh session; mark it pending so the next completion
      // triggers title generation like the initial session.
      state.pendingTitleSessions.add(v);
    },
    toolRegistry,
    skillRegistry: runtimeSkills.registry,
    commandRegistry,
    memoriesDir,
    router,
    loadedPlugins,
    connectedMcpServers,
    get resumeSessionId() { return state.resumeSessionId; },
    set resumeSessionId(v: string | undefined) { state.resumeSessionId = v; },
    get fullResumeMessages() { return state.fullResumeMessages; },
    set fullResumeMessages(v: boolean) { state.fullResumeMessages = v; },
    output: (text: string) => console.log(text),
  };

  // ── Banner ───────────────────────────────────────────────────────
  const bannerOpts = {
    model: config.model,
    cwd: process.cwd(),
    toolCount: toolRegistry.getAllToolNames().length,
    skillCount: runtimeSkills.registry.getAllSkillNames().length,
    memoryEntries: memoryEntryCount,
    tools: toolRegistry.getAllToolNames(),
    sessionId: state.sessionId,
    version: VERSION,
  };
  const termWidth = process.stdout.columns ?? 80;
  console.log(
    termWidth < 60
      ? buildCompactBanner(bannerOpts)
      : buildBanner(bannerOpts),
  );
  if (state.planMode) {
    console.log(ansiColor("  PLAN MODE active — mutating tools disabled until approved", "magenta"));
  }
  console.log();

  const prompt = () => {
    const promptPrefix = state.planMode
      ? ansiColor("[PLAN MODE] ", "magenta") + ansiColor("❯ ", "cyan")
      : ansiColor("❯ ", "cyan");
    rl.question(promptPrefix, async (rawInput) => {
      // ── Clear dropdown if visible ────────────────────────────────
      if (dropdown.isVisible()) dropdown.hide();

      // ── Multiline: backslash continuation ────────────────────────
      let input = rawInput;
      while (input.endsWith("\\")) {
        input = input.slice(0, -1);
        const continuation = await askQuestion(rl, ansiColor("... ", "green"));
        input += continuation;
      }

      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        sessionStore.endSession(state.sessionId);
        sessionStore.close();
        rl.close();
        return;
      }

      // ── Slash command dispatch ───────────────────────────────────
      if (trimmed.startsWith("/")) {
        const resolved = commandRegistry.resolve(trimmed);
        if (resolved) {
          try {
            await resolved.command.handler(resolved.args, commandContext);
          } catch (err) {
            console.error(formatError(err instanceof Error ? err.message : String(err)));
          }
          prompt();
          return;
        }

        // ── Skill trigger dispatch ────────────────────────────────
        const spaceIdx = trimmed.indexOf(" ");
        const skillName = spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
        const skillArgs = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : "";
        const matchedSkill = runtimeSkills.registry.dispatch(skillName, skillArgs);
        if (matchedSkill) {
          // Prepend skill body to user message and send to agent
          input = `${matchedSkill.body}\n\n${skillArgs}`;
          // Fall through to agent loop below
        } else {
          console.log(ansiColor("Unknown command. Type /help for available commands.", "yellow"));
          prompt();
          return;
        }
      }

        let handleSigint: (() => void) | undefined;
        let lastUsage: {
          promptTokens: number;
          completionTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
        } | undefined;
        try {
          let streamed = false;
          let renderedOutput = false;
          const signal = interrupts.start();
          handleSigint = () => {
            sp.stop();
            if (interrupts.interrupt() === "force-exit") {
              sessionStore.endSession(state.sessionId);
              sessionStore.close();
              rl.close();
              process.exit(130);
            }
          };
          process.on("SIGINT", handleSigint);
          sp.start();
          // Consume resume flags — reset after each turn so they only apply once
          const currentResumeId = state.resumeSessionId;
          const currentFullResume = state.fullResumeMessages;
          if (currentResumeId) {
            state.resumeSessionId = undefined;
            state.fullResumeMessages = false;
          }

          const checkpointManager = new CheckpointManager({
            store: sessionStore,
            sessionId: state.sessionId,
            getTokenUsage: () => ({ ...state.cumulativeUsage }),
            getPlanMode: () => state.planMode,
          });

          // Rebuild system prompt per-turn so plan mode hint is included/excluded dynamically
          const currentSystemPrompt = state.planMode
            ? buildCurrentSystemPrompt(true)
            : systemPrompt;

          const loop = new AgentLoop({
            provider,
            toolRegistry,
            permissions,
            sessionStore,
            sessionId: state.sessionId,
            systemPrompt: currentSystemPrompt,
            skillRegistry: runtimeSkills.skillsMap,
            stream: true,
            resumeSessionId: currentResumeId,
            fullResumeMessages: currentFullResume,
            onApprovalRequired: approvalHandler,
            modelName: config.model,
            smartModelRouting,
            checkpointManager,
            getPlanMode: () => state.planMode,
            userHooks: (config as any).hooks,
          });

          for await (const event of loop.run(trimmed, { signal })) {
            if (!renderedOutput && shouldStopSpinner(event)) {
              sp.stop();
              renderedOutput = true;
            }
            if (event.type === "text_delta") streamed = true;
            if (event.type === "completion") {
              // Capture usage info from completion event
              const usage = (event.message as any).usage;
              if (usage) {
                const inp = usage.prompt_tokens ?? usage.promptTokens ?? 0;
                const out = usage.completion_tokens ?? usage.completionTokens ?? 0;
                const cacheRead = usage.cache_read_input_tokens ?? 0;
                const cacheCreation = usage.cache_creation_input_tokens ?? 0;
                lastUsage = {
                  promptTokens: inp,
                  completionTokens: out,
                  cacheReadInputTokens: cacheRead,
                  cacheCreationInputTokens: cacheCreation,
                };
                // Accumulate for checkpoint token_usage snapshots
                state.cumulativeUsage.input_tokens += inp;
                state.cumulativeUsage.output_tokens += out;
                state.cumulativeUsage.cache_read_input_tokens += cacheRead;
                state.cumulativeUsage.cache_creation_input_tokens += cacheCreation;
              }
              if (state.pendingTitleSessions.has(state.sessionId)) {
                state.pendingTitleSessions.delete(state.sessionId);
                kickOffTitleGeneration({
                  provider: provider as TitleProvider,
                  sessionStore,
                  sessionId: state.sessionId,
                  userMessage: trimmed,
                  assistantReply: event.message.content ?? "",
                });
              }
              if (streamed) continue;
            }
            handleEvent(event);
          }
          if (interrupts.interrupted) {
            console.log("\n" + ansiColor("[interrupted]", "yellow"));
          }
          console.log(); // newline after response

          // ── Token display after response ─────────────────────────
          if (lastUsage) {
            const cacheStats = new CacheStats();
            cacheStats.recordUsage({
              cache_read_input_tokens: lastUsage.cacheReadInputTokens,
              cache_creation_input_tokens: lastUsage.cacheCreationInputTokens,
            });
            const hasCacheUsage =
              lastUsage.cacheReadInputTokens + lastUsage.cacheCreationInputTokens > 0;
            const tokenInfo = formatTokenDisplay(
              lastUsage.promptTokens,
              lastUsage.completionTokens,
              hasCacheUsage ? cacheStats : undefined,
            );
            const costInfo = formatCost(config.model, lastUsage.promptTokens, lastUsage.completionTokens);
            console.log(ansiColor(`${tokenInfo} | ${costInfo}`, "gray"));
          }
        } catch (err) {
          console.error(formatError(err instanceof Error ? err.message : String(err)));
        } finally {
          if (handleSigint) {
            process.off("SIGINT", handleSigint);
          }
          sp.stop();
        }

        prompt();
      });
    };

  rl.on("close", async () => {
    // Fire user "stop" hooks before tearing down so users can run final
    // notifications, audit log flushes, etc.
    const stopHooks = (config as any).hooks;
    if (stopHooks) {
      try {
        const { runUserHooks } = await import("../core/user-hooks.js");
        await runUserHooks(stopHooks, "stop", { toolName: "", args: {} });
      } catch {
        // best-effort
      }
    }
    for (const client of mcpClients) {
      try { await client.disconnect(); } catch { /* best-effort */ }
    }
    sessionStore.endSession(state.sessionId);
    sessionStore.close();
    process.exit(0);
  });

  prompt();
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function shouldStopSpinner(event: AgentEvent): boolean {
  return event.type !== "completion" || Boolean(event.message.content);
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.content);
      break;
    case "tool_call_start": {
      const name = event.toolCall.function.name;
      if (name === "clarify") {
        break;
      }
      // Suppress noisy todo_write arg dump — the rendered list comes in tool_result.
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
      if (event.name === "clarify") {
        try {
          const parsed = JSON.parse(event.result) as { answer?: string; error?: string };
          if (parsed.error) {
            console.log(formatToolResult(event.name, event.result));
          } else if (parsed.answer) {
            console.log(ansiColor(`Clarification answered: ${parsed.answer}`, "gray"));
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
