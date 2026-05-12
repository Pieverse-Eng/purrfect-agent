/**
 * Delegate tool — spawns a child AgentLoop to handle a sub-task.
 * The child gets its own session (fresh message context) but shares
 * the parent's Provider plus a child-scoped ToolRegistry.
 */

import type { ProviderUsage, ToolDefinition } from "../types.js";
import type { HttpProvider } from "../provider.js";
import { ToolRegistry } from "../tool-registry.js";
import { AgentLoop } from "../agent-loop.js";
import type { AgentLoopOptions } from "../agent-loop.js";
import type { PermissionModel } from "../permissions.js";

export interface DelegateToolOptions {
  provider: HttpProvider;
  toolRegistry: ToolRegistry;
  permissions?: PermissionModel;
  sessionStore?: AgentLoopOptions["sessionStore"];
  systemPrompt?: string;
  /**
   * Optional system prompt to hand to child agents. Should be built with
   * `hasTodoWriteTool: false` (and any other parent-only guidance disabled).
   * If omitted, the parent `systemPrompt` is forwarded verbatim — which can
   * cause the child to reference tools it does not have.
   */
  childSystemPrompt?: string;
  onApprovalRequired?: AgentLoopOptions["onApprovalRequired"];
  depth?: number;
  maxDepth?: number;
  /** Model name for escalation tier lookup in child loops. */
  modelName?: string;
}

interface ParallelDelegateTask {
  task: string;
  tools?: string[];
  maxTurns?: number;
}

interface SubagentResult {
  summary: string | null;
  result: string | null;
  trajectoryRef: string;
  tokensUsed: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  durationMs: number;
  announcements: string[];
  error?: string;
}

const MAX_PARALLEL_DELEGATE_TASKS = 5;

/**
 * Tools that must never be handed to a delegated child agent.
 *
 * - `delegate` / `todo_write`: already scoped to the parent session; allowing
 *   children to call them would either recurse forever or mutate the parent's
 *   task list.
 * - `clarify`: children run non-interactively and cannot prompt the user.
 * - `memory` / `checkpoint_create`: writes are shared with the parent session;
 *   children should not mutate parent state.
 * - `send_message`: cross-platform side effect; only the parent (which owns
 *   the origin context) should reply.
 * - `enter_plan_mode` / `exit_plan_mode`: plan mode is a parent-session
 *   control toggle, not something a sub-task should flip.
 */
export const DELEGATE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "delegate",
  "todo_write",
  "clarify",
  "memory",
  "checkpoint_create",
  "send_message",
  "enter_plan_mode",
  "exit_plan_mode",
]);

/**
 * Factory that creates a delegate ToolDefinition wired to the given
 * provider/registry and aware of the current delegation depth.
 */
export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  const {
    provider,
    toolRegistry,
    permissions,
    sessionStore,
    systemPrompt,
    childSystemPrompt,
    onApprovalRequired,
    depth = 0,
    maxDepth = 3,
    modelName,
  } = options;

  return {
    name: "delegate",
    description:
      "Delegate a sub-task to a child agent. The child runs independently with its own session context.",
    schema: {
      type: "function",
      function: {
        name: "delegate",
        description:
          "Delegate a sub-task to a child agent. The child runs independently with its own session context.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The prompt / task to delegate to the child agent.",
            },
            tools: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of tool names available to the child.",
            },
            maxTurns: {
              type: "number",
              description: "Maximum AgentLoop iterations for the child agent.",
            },
            parallel: {
              type: "array",
              maxItems: MAX_PARALLEL_DELEGATE_TASKS,
              description: "Optional parallel fanout of subagent tasks.",
              items: {
                type: "object",
                properties: {
                  task: { type: "string" },
                  tools: { type: "array", items: { type: "string" } },
                  maxTurns: { type: "number" },
                },
                required: ["task"],
              },
            },
          },
        },
      },
    },

    async handler(args: Record<string, unknown>): Promise<string> {
      // Depth guard
      if (depth >= maxDepth) {
        return JSON.stringify({ error: "Max delegation depth exceeded" });
      }

      try {
        const parallelTasks = normalizeParallelTasks(args.parallel);
        if (parallelTasks.length > 0) {
          if (parallelTasks.length > MAX_PARALLEL_DELEGATE_TASKS) {
            return JSON.stringify({
              error: `parallel supports at most ${MAX_PARALLEL_DELEGATE_TASKS} tasks`,
            });
          }
          const results = await Promise.all(
            parallelTasks.map((task, index) =>
              runSubagent({
                prompt: task.task,
                requestedTools: normalizeRequestedTools(task.tools),
                maxTurns: task.maxTurns,
                trajectorySuffix: `parallel-${index}`,
              }),
            ),
          );
          return JSON.stringify({
            summary: `${results.length} subagents completed`,
            results,
            tokensUsed: sumUsage(results.map((result) => result.tokensUsed)),
            durationMs: Math.max(...results.map((result) => result.durationMs), 0),
          });
        }

        const prompt = args.prompt as string | undefined;
        if (!prompt) {
          return JSON.stringify({ error: "prompt or parallel is required" });
        }

        const result = await runSubagent({
          prompt,
          requestedTools: normalizeRequestedTools(args.tools),
          maxTurns: normalizeMaxTurns(args.maxTurns),
          trajectorySuffix: "single",
        });

        if (result.error) {
          return JSON.stringify({ ...result, error: result.error });
        }

        return JSON.stringify(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };

  async function runSubagent(options: {
    prompt: string;
    requestedTools: Set<string> | null;
    maxTurns?: number;
    trajectorySuffix: string;
  }): Promise<SubagentResult> {
    const started = Date.now();
    const childPermissions = permissions?.forkSession() ?? permissions;
    const childRegistry = buildChildRegistry({
      parentRegistry: toolRegistry,
      provider,
      permissions: childPermissions,
      sessionStore,
      systemPrompt,
      onApprovalRequired,
      depth,
      maxDepth,
      modelName,
      requestedTools: options.requestedTools,
    });

    const childLoop = new AgentLoop({
      provider,
      toolRegistry: childRegistry,
      systemPrompt: childSystemPrompt ?? systemPrompt,
      permissions: childPermissions,
      sessionStore,
      onApprovalRequired,
      depth: depth + 1,
      maxDepth,
      modelName,
      maxIterations: options.maxTurns,
    });

    let completionContent: string | null = null;
    let errorMessage: string | undefined;
    const announcements: string[] = [];
    const tokensUsed = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let sawUsageEvent = false;

    for await (const event of childLoop.run(options.prompt)) {
      if (event.type === "tool_call_start") {
        announcements.push(`tool:${event.toolCall.function.name}`);
      } else if (event.type === "warning") {
        announcements.push(`warning:${event.message}`);
      } else if (event.type === "usage") {
        sawUsageEvent = true;
        addUsage(tokensUsed, event.usage);
      } else if (event.type === "completion") {
        completionContent = event.message.content;
        const usage = (event.message as { usage?: ProviderUsage }).usage;
        if (usage && !sawUsageEvent) {
          addUsage(tokensUsed, usage);
        }
      } else if (event.type === "error") {
        errorMessage = event.error.message;
      } else if (event.type === "budget_exceeded") {
        errorMessage = "Subagent budget exceeded";
      }
    }

    return {
      summary: completionContent,
      result: completionContent,
      trajectoryRef: `subagent://${depth + 1}/${Date.now()}-${options.trajectorySuffix}`,
      tokensUsed,
      durationMs: Date.now() - started,
      announcements,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }
}

function addUsage(
  target: { input_tokens: number; output_tokens: number; total_tokens: number },
  usage: ProviderUsage,
): void {
  target.input_tokens += usage.prompt_tokens;
  target.output_tokens += usage.completion_tokens;
  target.total_tokens += usage.total_tokens;
}

function normalizeRequestedTools(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const names = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return new Set(names);
}

function normalizeMaxTurns(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function normalizeParallelTasks(value: unknown): ParallelDelegateTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ParallelDelegateTask[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.task !== "string" || record.task.trim().length === 0) {
      return [];
    }
    return [{
      task: record.task,
      tools: Array.isArray(record.tools)
        ? record.tools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
      maxTurns: normalizeMaxTurns(record.maxTurns),
    }];
  });
}

function sumUsage(
  entries: Array<{ input_tokens: number; output_tokens: number; total_tokens: number }>,
): { input_tokens: number; output_tokens: number; total_tokens: number } {
  return entries.reduce(
    (acc, item) => ({
      input_tokens: acc.input_tokens + item.input_tokens,
      output_tokens: acc.output_tokens + item.output_tokens,
      total_tokens: acc.total_tokens + item.total_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );
}

function buildChildRegistry(options: {
  parentRegistry: ToolRegistry;
  provider: HttpProvider;
  permissions?: PermissionModel;
  sessionStore?: AgentLoopOptions["sessionStore"];
  systemPrompt?: string;
  onApprovalRequired?: AgentLoopOptions["onApprovalRequired"];
  depth: number;
  maxDepth: number;
  modelName?: string;
  requestedTools: Set<string> | null;
}): ToolRegistry {
  const childRegistry = new ToolRegistry();
  const {
    parentRegistry,
    provider,
    permissions,
    sessionStore,
    systemPrompt,
    onApprovalRequired,
    depth,
    maxDepth,
    modelName,
    requestedTools,
  } = options;

  const toolNames = requestedTools
    ? [...requestedTools]
    : parentRegistry.getAllToolNames();

  for (const toolName of toolNames) {
    if (DELEGATE_BLOCKED_TOOLS.has(toolName)) {
      continue;
    }
    const definition = parentRegistry.getDefinition(toolName);
    if (definition) {
      childRegistry.register(definition);
    }
  }

  if ((depth + 1) < maxDepth && (!requestedTools || requestedTools.has("delegate"))) {
    childRegistry.register(
        createDelegateTool({
          provider,
          toolRegistry: childRegistry,
          permissions,
          sessionStore,
          systemPrompt,
          onApprovalRequired,
          depth: depth + 1,
          maxDepth,
          modelName,
      }),
    );
  }

  return childRegistry;
}
