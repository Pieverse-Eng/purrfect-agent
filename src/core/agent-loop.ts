/**
 * Core agent loop — send messages, stream responses, detect tool calls,
 * execute them, repeat. Wires provider, tool registry, and optional
 * subsystems (session store, compressor, permissions, skills) together.
 */

import type { Message, ProviderUsage, ToolCall, ToolSchema } from "./types.js";
import type { ChatResponse } from "./provider.js";
import type { HttpProvider } from "./provider.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { PermissionModel } from "./permissions.js";
import { ProviderError } from "./errors.js";
import { generateSessionRecap } from "./session-resume.js";
import { getModelMetadata, estimateCostUsd } from "./model-metadata.js";
import { TrajectoryCompressor } from "./trajectory-compressor.js";
import { ContextReferenceStore } from "./context-references.js";
import type { ModelTier, SmartModelRoutingController } from "./model-routing.js";
import { estimateTotalTokens } from "./compressor.js";
import {
  PLAN_MODE_BLOCKED_TOOLS,
  PLAN_MODE_HIDDEN_WHEN_ACTIVE,
  PLAN_MODE_HIDDEN_WHEN_INACTIVE,
} from "./plan-mode.js";
import {
  runUserHooks,
  type UserHooksConfig,
  type HookOutcome,
} from "./user-hooks.js";

// ---------------------------------------------------------------------------
// AgentEvent discriminated union
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_result"; name: string; result: string }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "completion"; message: Message }
  | { type: "error"; error: Error }
  | { type: "budget_exceeded" }
  | { type: "warning"; message: string };

// ---------------------------------------------------------------------------
// IterationBudget
// ---------------------------------------------------------------------------

export class IterationBudget {
  readonly max: number;
  private _consumed = 0;

  constructor(max = 25) {
    this.max = max;
  }

  get consumed(): number {
    return this._consumed;
  }

  get exhausted(): boolean {
    return this._consumed >= this.max;
  }

  consume(): void {
    this._consumed++;
  }
}

// ---------------------------------------------------------------------------
// Minimal interfaces for optional subsystems (duck-typed to avoid hard deps)
// ---------------------------------------------------------------------------

interface SessionStoreLike {
  appendMessage(sessionId: string, message: { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; tool_name?: string; reasoning?: string }): void;
  recordTokenUsage?(sessionId: string, usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void;
  recordTurn?(turn: {
    session_id: string;
    model?: string | null;
    model_tier?: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cost_usd?: number | null;
    latency_ms?: number | null;
  }): void;
  getMessages?(sessionId: string): Array<{
    id: number;
    session_id: string;
    role: string;
    content: string | null;
    timestamp: number;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    tool_name?: string;
  }>;
}

interface CompressorLike {
  shouldCompress(messages: Message[], contextLength: number): boolean;
  compress(messages: Message[], options?: Record<string, unknown>): Promise<Message[]>;
  /** Optional preflight hook — cheap check + compress-before-send. */
  shouldCompressPreflight?(messages: Message[], promptTokens?: number): boolean;
  preflightCompress?(
    messages: Message[],
    options?: Record<string, unknown>,
  ): Promise<Message[]>;
}

interface TrajectoryCompressorLike {
  compress(messages: Message[]): { messages: Message[] } | Message[];
}

/** Duck-typed interface for checkpoint persistence. */
export interface CheckpointManagerLike {
  /**
   * Persist a snapshot of the current session state.
   * @param trigger  Why this checkpoint was created (for labelling).
   * @param messages Current message array.
   * @param compressionMeta  Present when this checkpoint precedes compression.
   */
  save(
    trigger: "auto" | "pre_compression" | "post_delegate",
    messages: Message[],
    compressionMeta?: { original_message_count: number },
  ): void;
}

interface StreamingToolCallState {
  id?: string;
  name?: string;
  arguments: string;
}

// ---------------------------------------------------------------------------
// AgentLoop options
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  provider: HttpProvider;
  toolRegistry: ToolRegistry;
  systemPrompt?: string;
  permissions?: PermissionModel;
  sessionStore?: SessionStoreLike;
  sessionId?: string;
  compressor?: CompressorLike;
  /**
   * Cheap per-turn trajectory slimming. Runs before boundary-level context
   * compression once the main compressor says the prompt is near budget.
   */
  trajectoryCompressor?: TrajectoryCompressorLike;
  skillRegistry?: Map<string, string>;
  maxIterations?: number;
  stream?: boolean;
  /** Current delegation depth (default 0). */
  depth?: number;
  /** Maximum allowed delegation depth (default 3). */
  maxDepth?: number;
  /** If set, loads a recap of the previous session and prepends as a system message. */
  resumeSessionId?: string;
  /** Interactive approval callback. Called when a tool fails permission check. */
  onApprovalRequired?: (
    toolName: string,
    args: Record<string, unknown>,
    context?: { reason?: string },
  ) => Promise<"allow_once" | "allow_session" | "deny">;
  /** Model name for escalation tier lookup. */
  modelName?: string;
  /**
   * Optional large tool-result reference store. When omitted but a session id
   * is available, AgentLoop creates the default ~/.purrfect/refs store.
   */
  contextReferences?: ContextReferenceStore;
  /** Optional per-turn smart model routing controller. */
  smartModelRouting?: SmartModelRoutingController;
  /** Optional checkpoint manager. When provided, snapshots are saved automatically. */
  checkpointManager?: CheckpointManagerLike;
  /**
   * How often (in agent loop iterations) to auto-save a checkpoint.
   * Defaults to 10. Set to 0 to disable iteration-based auto-checkpointing.
   */
  checkpointEveryN?: number;
  /**
   * When true and resumeSessionId is set, inject the full message history
   * of the resumed session as actual conversation messages rather than a
   * truncated recap system message. Use this for checkpoint resumes where
   * full state fidelity matters.
   */
  fullResumeMessages?: boolean;
  /** Returns true when plan mode is active. Tools in PLAN_MODE_BLOCKED_TOOLS are filtered out. */
  getPlanMode?: () => boolean;
  /** User-defined shell hooks for preToolUse / postToolUse / stop phases. */
  userHooks?: UserHooksConfig;
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private readonly provider: HttpProvider;
  private readonly toolRegistry: ToolRegistry;
  private readonly systemPrompt?: string;
  private readonly permissions?: PermissionModel;
  private readonly sessionStore?: SessionStoreLike;
  private readonly sessionId?: string;
  private readonly compressor?: CompressorLike;
  private readonly trajectoryCompressor: TrajectoryCompressorLike;
  private readonly skillRegistry?: Map<string, string>;
  private readonly maxIterations: number;
  private readonly useStream: boolean;
  readonly depth: number;
  readonly maxDepth: number;
  private readonly resumeSessionId?: string;
  private readonly onApprovalRequired?: AgentLoopOptions["onApprovalRequired"];
  private readonly modelName?: string;
  private readonly contextReferences?: ContextReferenceStore;
  private readonly smartModelRouting?: SmartModelRoutingController;
  private readonly checkpointManager?: CheckpointManagerLike;
  private readonly checkpointEveryN: number;
  private readonly fullResumeMessages: boolean;
  private readonly getPlanMode?: () => boolean;
  private readonly userHooks?: UserHooksConfig;
  /** Exact tool invocations approved for the session via onApprovalRequired callback. */
  private readonly sessionApprovedRequests = new Set<string>();

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.toolRegistry = options.toolRegistry;
    this.systemPrompt = options.systemPrompt;
    this.permissions = options.permissions;
    this.sessionStore = options.sessionStore;
    this.sessionId = options.sessionId;
    this.compressor = options.compressor;
    this.trajectoryCompressor =
      options.trajectoryCompressor ?? new TrajectoryCompressor();
    this.skillRegistry = options.skillRegistry;
    this.maxIterations = options.maxIterations ?? 25;
    this.useStream = options.stream ?? false;
    this.depth = options.depth ?? 0;
    this.maxDepth = options.maxDepth ?? 3;
    this.resumeSessionId = options.resumeSessionId;
    this.onApprovalRequired = options.onApprovalRequired;
    this.modelName = options.modelName;
    this.contextReferences =
      options.contextReferences ??
      (options.sessionId ? new ContextReferenceStore() : undefined);
    this.smartModelRouting = options.smartModelRouting;
    this.checkpointManager = options.checkpointManager;
    this.checkpointEveryN = options.checkpointEveryN ?? 10;
    this.fullResumeMessages = options.fullResumeMessages ?? false;
    this.getPlanMode = options.getPlanMode;
    this.userHooks = options.userHooks;
  }

  async *run(
    userMessage: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const budget = new IterationBudget(this.maxIterations);
    const signal = options?.signal;

    // Skill dispatch: if message starts with /, look up skill and prepend instructions
    let processedMessage = userMessage;
    if (this.skillRegistry && userMessage.startsWith("/")) {
      const spaceIdx = userMessage.indexOf(" ");
      const skillName = spaceIdx > 0 ? userMessage.slice(1, spaceIdx) : userMessage.slice(1);
      const rest = spaceIdx > 0 ? userMessage.slice(spaceIdx + 1) : "";
      const skillInstructions = this.skillRegistry.get(skillName);
      if (skillInstructions) {
        processedMessage = `${skillInstructions}\n\n${rest}`;
      }
    }

    // Build initial messages — optionally prepend session recap as system message
    const messages: Message[] = [];

    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }

    if (this.resumeSessionId && this.sessionStore?.getMessages) {
      if (this.fullResumeMessages) {
        // Full-history mode: inject all messages directly so the model has exact state.
        // Used for checkpoint resumes where a truncated recap would lose critical context.
        const historicMessages = this.sessionStore.getMessages(this.resumeSessionId);
        for (const msg of historicMessages) {
          if (msg.role === "system") continue; // skip stale system messages from prior session
          const m: Message = { role: msg.role as Message["role"], content: msg.content };
          if (msg.tool_calls?.length) m.tool_calls = msg.tool_calls;
          if (msg.tool_call_id) m.tool_call_id = msg.tool_call_id;
          if (msg.tool_name) (m as any).name = msg.tool_name;
          messages.push(m);
        }
      } else {
        const recap = generateSessionRecap(
          this.sessionStore as import("./session-resume.js").SessionStoreLike,
          this.resumeSessionId,
        );
        if (recap) {
          messages.push({ role: "system", content: recap });
        }
      }
    }

    messages.push({ role: "user", content: processedMessage });

    // Persist user message
    yield* this.persistAndWarn({ role: "user", content: processedMessage });

    let compressionAttempted = false;
    // Truncation recovery state — resets per user turn
    let recoveryAttempts = 0;
    let maxTokensOverride: number | undefined;
    const meta = this.modelName ? getModelMetadata(this.modelName) : undefined;
    const maxRecovery = meta?.maxRecoveryAttempts ?? 3;
    const escalationTiers = meta?.escalationTiers ?? [4_096, 8_192, 16_384];

    while (true) {
      // Check budget
      if (budget.exhausted) {
        yield { type: "budget_exceeded" };
        return;
      }

      // Check abort
      if (signal?.aborted) {
        return;
      }

      budget.consume();

      // Auto-checkpoint every N iterations
      if (
        this.checkpointManager &&
        this.checkpointEveryN > 0 &&
        budget.consumed % this.checkpointEveryN === 0
      ) {
        this.checkpointManager.save("auto", messages);
      }

      // Resolve tool list each iteration so plan-mode toggles take effect immediately.
      // Hide tools that are irrelevant in the current mode (e.g. exit_plan_mode when
      // not in plan mode) so the model never wastes a turn calling them.
      const allTools = this.toolRegistry.getDefinitions();
      const hidden = this.getPlanMode?.()
        ? PLAN_MODE_HIDDEN_WHEN_ACTIVE
        : PLAN_MODE_HIDDEN_WHEN_INACTIVE;
      const tools = allTools.filter((t) => !hidden.has(t.function.name));

      // Preflight compression — run BEFORE dispatch so we never burn a
      // round-trip on a request that would be rejected for size. No-op if
      // the compressor doesn't implement preflight or estimate is under the
      // threshold.
      if (
        this.compressor?.shouldCompressPreflight?.(messages) &&
        this.compressor.preflightCompress
      ) {
        this.checkpointManager?.save("pre_compression", messages, {
          original_message_count: messages.length,
        });
        try {
          this.applyTrajectoryCompression(messages);
          const next = await this.compressor.preflightCompress(messages);
          if (next !== messages) {
            messages.length = 0;
            messages.push(...next);
            compressionAttempted = true;
          }
        } catch (err) {
          // Preflight is best-effort; fall through to real dispatch and
          // let the 413-recovery path handle it. Surface a warning so the
          // failure is observable instead of being silently swallowed.
          const message =
            err instanceof Error ? err.message : String(err);
          yield {
            type: "warning",
            message: `Preflight compression failed: ${message}`,
          };
        }
      }

      let assistantMessage: ChatResponse["choices"][number]["message"];
      let reasoning: string | undefined;
      let finishReason: string | undefined;
      let responseUsage: ProviderUsage | undefined;
      const modelTier = this.routeModelForTurn(messages);
      const turnStartedAt = Date.now();

      try {
        if (this.useStream) {
          const streamed = yield* this.handleStreamingResponse(messages, tools, signal, maxTokensOverride);
          assistantMessage = streamed.message;
          reasoning = streamed.reasoning;
          finishReason = streamed.finishReason;
          responseUsage = streamed.usage;
        } else {
          const response = await this.provider.chat(messages, tools, { signal, maxTokens: maxTokensOverride });
          const choice = response.choices?.[0];
          if (!choice) {
            yield { type: "error", error: new Error("No choices in response") };
            return;
          }

          assistantMessage = choice.message;
          reasoning = (assistantMessage as any).reasoning as string | undefined;
          finishReason = choice.finish_reason;
          responseUsage = response.usage;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        // Check for context length exceeded — try compression
        if (
          err instanceof ProviderError &&
          err.contextLengthExceeded &&
          this.compressor &&
          !compressionAttempted
        ) {
          compressionAttempted = true;
          // Snapshot before compressing so the full context is recoverable
          this.checkpointManager?.save("pre_compression", messages, {
            original_message_count: messages.length,
          });
          try {
            this.applyTrajectoryCompression(messages);
            const compressed = await this.compressor.compress(messages);
            messages.length = 0;
            messages.push(...compressed);
            continue;
          } catch {
            yield { type: "error", error: err };
            return;
          }
        }
        // Second 413 after compression — surface error
        if (
          err instanceof ProviderError &&
          err.contextLengthExceeded &&
          compressionAttempted
        ) {
          yield { type: "error", error: err };
          return;
        }
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
        return;
      }

      if (responseUsage) {
        yield { type: "usage", usage: responseUsage };
      }
      this.smartModelRouting?.recordUsage(modelTier, responseUsage);
      yield* this.recordUsageAndWarn(responseUsage, modelTier);
      yield* this.recordTurnAndWarn(responseUsage, modelTier, Date.now() - turnStartedAt);

      // Handle output truncation (max_tokens / length)
      const isTruncated =
        finishReason === "length" || finishReason === "max_tokens";

      if (isTruncated) {
        if (recoveryAttempts >= maxRecovery) {
          yield { type: "budget_exceeded" };
          return;
        }

        // Discard tool calls with incomplete JSON
        if (assistantMessage.tool_calls?.length) {
          const validToolCalls = assistantMessage.tool_calls.filter((tc) => {
            try {
              JSON.parse(tc.function.arguments);
              return true;
            } catch {
              return false;
            }
          });
          assistantMessage = {
            ...assistantMessage,
            tool_calls: validToolCalls.length > 0 ? validToolCalls : undefined,
          };
        }

        // If only text was truncated (no valid tool calls), retry with continuation
        if (!assistantMessage.tool_calls?.length) {
          const nextTier = escalationTiers[Math.min(recoveryAttempts, escalationTiers.length - 1)];
          maxTokensOverride = nextTier;
          recoveryAttempts++;

          yield {
            type: "warning",
            message: `Response truncated, retrying with higher limit (${nextTier} tokens, attempt ${recoveryAttempts}/${maxRecovery})`,
          };

          // Append partial text as continuation context
          if (assistantMessage.content) {
            messages.push({ role: "assistant", content: assistantMessage.content });
            messages.push({
              role: "user",
              content: "Your previous response was truncated. Continue from where you left off.",
            });
          }

          continue;
        }
        // If valid tool calls exist, proceed with them (text may be truncated but tools are fine)
      }

      // Handle empty response — retry once
      if (!assistantMessage.content && !assistantMessage.tool_calls?.length) {
        // Append empty assistant message to context and retry
        messages.push({
          role: "assistant",
          content: null,
        });
        continue;
      }

      // Handle tool calls
      if (assistantMessage.tool_calls?.length) {
        const assistantMsg: Message = {
          role: "assistant",
          content: assistantMessage.content,
          tool_calls: assistantMessage.tool_calls,
        };
        messages.push(assistantMsg);

        for (const tc of assistantMessage.tool_calls) {
          // Check abort between tool executions
          if (signal?.aborted) {
            return;
          }

          yield { type: "tool_call_start", toolCall: tc };

          let result: string;

          // Check permissions
          if (this.permissions) {
            let permArgs: Record<string, unknown>;
            try {
              permArgs = JSON.parse(tc.function.arguments);
            } catch {
              permArgs = {};
            }
            const check = this.permissions.check(tc.function.name, permArgs);
            const approvalKey = this.getApprovalKey(tc.function.name, tc.function.arguments);
            if (!check.allowed && !this.sessionApprovedRequests.has(approvalKey)) {
              // Interactive approval: if callback exists, ask user
              let approved = false;
              if (this.onApprovalRequired) {
                const decision = await this.onApprovalRequired(tc.function.name, permArgs, {
                  reason: check.reason,
                });
                if (decision === "allow_once") {
                  approved = true;
                } else if (decision === "allow_session") {
                  this.sessionApprovedRequests.add(approvalKey);
                  if (typeof permArgs.command === "string") {
                    this.permissions.approveForSession(tc.function.name, permArgs.command);
                  }
                  approved = true;
                }
                // decision === "deny" → approved stays false
              }

              if (!approved) {
                result = JSON.stringify({
                  error: `Permission denied: ${check.reason}`,
                });
                yield { type: "tool_result", name: tc.function.name, result };
                messages.push({
                  role: "tool",
                  content: result,
                  tool_call_id: tc.id,
                  name: tc.function.name,
                });
                continue;
              }
            }
          }

          // Defence-in-depth: block mutating tools that slip through in plan mode
          if (this.getPlanMode?.() && PLAN_MODE_BLOCKED_TOOLS.has(tc.function.name)) {
            result = JSON.stringify({
              error: "not_allowed_in_plan_mode",
              tool: tc.function.name,
              message: "This tool is disabled while Plan Mode is active.",
            });
            yield { type: "tool_result", name: tc.function.name, result };
            messages.push({
              role: "tool",
              content: result,
              tool_call_id: tc.id,
              name: tc.function.name,
            });
            continue;
          }

          // Dispatch tool
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          // preToolUse user hooks — may block the call
          const preOutcomes = this.userHooks
            ? await runUserHooks(this.userHooks, "preToolUse", {
                toolName: tc.function.name,
                args,
              })
            : [];
          for (const out of preOutcomes) {
            yield* this.warnOnHookFailure("preToolUse", tc.function.name, out);
          }
          const blocked = preOutcomes.find((o) => o.blocked);
          if (blocked) {
            result = JSON.stringify({
              error: `preToolUse hook blocked tool: ${tc.function.name}`,
              hook_command: blocked.hook.command,
              exit_code: blocked.exitCode,
              stderr: blocked.stderr.slice(0, 500),
            });
            yield { type: "tool_result", name: tc.function.name, result };
            messages.push({
              role: "tool",
              content: result,
              tool_call_id: tc.id,
              name: tc.function.name,
            });
            continue;
          }

          result = await this.toolRegistry.dispatch(tc.function.name, args);

          // postToolUse user hooks — observation only, never blocks
          if (this.userHooks) {
            const postOutcomes = await runUserHooks(this.userHooks, "postToolUse", {
              toolName: tc.function.name,
              args,
              result,
            });
            for (const out of postOutcomes) {
              yield* this.warnOnHookFailure("postToolUse", tc.function.name, out);
            }
          }
          if (this.contextReferences && this.sessionId && tc.function.name !== "read_ref") {
            const materialized =
              await this.contextReferences.materializeToolResult({
                sessionId: this.sessionId,
                toolCallId: tc.id,
                toolName: tc.function.name,
                content: result,
              });
            result = materialized.content;
          }

          yield { type: "tool_result", name: tc.function.name, result };

          messages.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
            name: tc.function.name,
          });

          // Checkpoint after delegate result is appended — snapshot includes sub-agent output
          if (tc.function.name === "delegate" && this.checkpointManager) {
            this.checkpointManager.save("post_delegate", messages);
          }
        }

        // Persist assistant + tool messages
        yield* this.persistAndWarn({
          role: "assistant",
          content: assistantMessage.content,
          tool_calls: assistantMessage.tool_calls,
        });
        for (const tc of assistantMessage.tool_calls) {
          const toolMsg = messages.find(
            (m) => m.role === "tool" && m.tool_call_id === tc.id,
          );
          if (toolMsg) {
            yield* this.persistAndWarn({
              role: "tool",
              content: toolMsg.content,
              tool_call_id: tc.id,
              tool_name: tc.function.name,
            });
          }
        }

        // Reset compression flag for next iteration
        compressionAttempted = false;
        continue;
      }

      // Text completion — loop exits
      const completionMsg: Message = {
        role: "assistant",
        content: assistantMessage.content,
      };
      if (reasoning) {
        (completionMsg as any).reasoning = reasoning;
      }
      if (responseUsage) {
        (completionMsg as any).usage = responseUsage;
      }

      yield* this.persistAndWarn({
        role: "assistant",
        content: assistantMessage.content,
        reasoning,
      });

      yield { type: "completion", message: completionMsg };
      return;
    }
  }

  // ── Streaming path ─────────────────────────────────────────────────────

  private async *handleStreamingResponse(
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
    maxTokensOverride?: number,
  ): AsyncGenerator<
    AgentEvent,
    {
      message: ChatResponse["choices"][number]["message"];
      reasoning?: string;
      finishReason?: string;
      usage?: ProviderUsage;
    },
    unknown
  > {
    let textContent = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: ProviderUsage | undefined;
    const toolCalls = new Map<number, StreamingToolCallState>();

    for await (const delta of this.provider.chatStream(messages, tools, { signal, maxTokens: maxTokensOverride })) {
      if (delta.type === "text" && delta.content) {
        textContent += delta.content;
        yield { type: "text_delta", content: delta.content };
        continue;
      }
      if (delta.type === "thinking" && delta.content) {
        reasoning += delta.content;
        continue;
      }
      if (delta.type === "tool_call" && delta.toolCall) {
        this.mergeStreamingToolCall(
          toolCalls,
          delta.toolCall,
          delta.toolCallIndex ?? toolCalls.size,
        );
        continue;
      }
      if (delta.type === "done") {
        finishReason = delta.finishReason;
        usage = delta.usage;
        break;
      }
    }

    return {
      message: {
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.size > 0
          ? { tool_calls: this.finalizeStreamingToolCalls(toolCalls) }
          : {}),
      },
      ...(reasoning ? { reasoning } : {}),
      finishReason,
      ...(usage ? { usage } : {}),
    };
  }

  // ── Session persistence (best-effort, yields warnings) ─────────────────

  private *persistAndWarn(msg: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    tool_name?: string;
    reasoning?: string;
  }): Generator<AgentEvent> {
    if (!this.sessionStore || !this.sessionId) return;
    try {
      this.sessionStore.appendMessage(this.sessionId, msg);
    } catch {
      yield { type: "warning", message: "SessionStore write failed: message not persisted" };
    }
  }

  private *recordUsageAndWarn(
    usage: ProviderUsage | undefined,
    modelTier?: ModelTier,
  ): Generator<AgentEvent> {
    if (!usage || !this.sessionStore?.recordTokenUsage || !this.sessionId) return;
    try {
      this.sessionStore.recordTokenUsage(this.sessionId, {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        ...(modelTier ? { model_tier: modelTier } : {}),
      });
    } catch {
      yield { type: "warning", message: "SessionStore write failed: token usage not persisted" };
    }
  }

  private *recordTurnAndWarn(
    usage: ProviderUsage | undefined,
    modelTier: ModelTier | undefined,
    latencyMs: number,
  ): Generator<AgentEvent> {
    if (!usage || !this.sessionStore?.recordTurn || !this.sessionId) return;
    const cost = estimateCostUsd(this.modelName ?? null, {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    });
    try {
      this.sessionStore.recordTurn({
        session_id: this.sessionId,
        model: this.modelName ?? null,
        model_tier: modelTier ?? null,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cost_usd: cost,
        latency_ms: latencyMs,
      });
    } catch {
      yield { type: "warning", message: "SessionStore write failed: turn insight not persisted" };
    }
  }

  private getApprovalKey(toolName: string, rawArguments: string): string {
    return `${toolName}::${rawArguments}`;
  }

  /**
   * Surface non-zero hook outcomes when configured to "warn". "log" stays
   * silent; "block" is handled by the caller via outcome.blocked.
   */
  private *warnOnHookFailure(
    phase: "preToolUse" | "postToolUse",
    toolName: string,
    outcome: HookOutcome,
  ): Generator<AgentEvent> {
    const failed = (outcome.exitCode ?? 1) !== 0 || outcome.timedOut;
    if (!failed) return;
    if (outcome.hook.onFailure !== "warn") return;
    const reason = outcome.timedOut
      ? "timed out"
      : outcome.error
        ? outcome.error
        : `exit ${outcome.exitCode}`;
    yield {
      type: "warning",
      message: `${phase} hook (${toolName}) ${reason}: ${outcome.hook.command}`,
    };
  }

  /**
   * Fire all `stop` user hooks once. Callers (REPL/gateway) invoke this on
   * shutdown so users get a final chance to log/cleanup. Errors are swallowed.
   */
  async fireStopHooks(): Promise<void> {
    if (!this.userHooks) return;
    try {
      await runUserHooks(this.userHooks, "stop", { toolName: "", args: {} });
    } catch {
      // best-effort
    }
  }

  private applyTrajectoryCompression(messages: Message[]): void {
    const result = this.trajectoryCompressor.compress(messages);
    const next = Array.isArray(result) ? result : result.messages;
    if (next !== messages) {
      messages.length = 0;
      messages.push(...next);
    }
  }

  private routeModelForTurn(messages: Message[]): ModelTier | undefined {
    if (!this.smartModelRouting) return undefined;
    const decision = this.smartModelRouting.route({
      messages,
      lastMessage: messages.at(-1),
      contextSizeTokens: estimateTotalTokens(messages),
    });

    const switcher = this.provider as unknown as {
      switchModel?: (model: string) => void;
    };
    if (typeof switcher.switchModel === "function") {
      switcher.switchModel(decision.model);
    }

    return decision.tier;
  }

  private mergeStreamingToolCall(
    toolCalls: Map<number, StreamingToolCallState>,
    partial: Partial<ToolCall>,
    index: number,
  ): void {
    const existing = toolCalls.get(index) ?? { arguments: "" };

    if (typeof partial.id === "string" && partial.id.length > 0) {
      existing.id = partial.id;
    }
    if (typeof partial.function?.name === "string" && partial.function.name.length > 0) {
      existing.name = partial.function.name;
    }
    if (typeof partial.function?.arguments === "string") {
      existing.arguments += partial.function.arguments;
    }

    toolCalls.set(index, existing);
  }

  private finalizeStreamingToolCalls(
    toolCalls: Map<number, StreamingToolCallState>,
  ): ToolCall[] {
    return [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, toolCall]) => ({
        id: toolCall.id ?? `stream_call_${index}`,
        type: "function",
        function: {
          name: toolCall.name ?? "",
          arguments: toolCall.arguments || "{}",
        },
      }));
  }
}
