import { PromptBuilder } from "../core/prompt-builder.js";
import { getModelMetadata } from "../core/model-metadata.js";
import { PermissionModel } from "../core/permissions.js";
import type { Config } from "../core/config-schema.js";
import { planModeAllowedToolList, planModeBlockedToolList } from "../core/plan-mode.js";

// ---------------------------------------------------------------------------
// AgentContext assembly
// ---------------------------------------------------------------------------

export interface AgentContextOptions {
  config: Config;
  memorySnapshot?: string;
  skillIndex?: string;
  platformHint?: string;
  resumeRecap?: string;
  /** Whether the memory tool is available in this session. */
  hasMemoryTool?: boolean;
  /** Whether the session_search tool is available in this session. */
  hasSessionSearchTool?: boolean;
  /** Whether the todo_write tool is available in this session. */
  hasTodoWriteTool?: boolean;
  /** Whether the clarify tool is available in this session. */
  hasClarifyTool?: boolean;
  /** Whether plan mode is currently active. */
  planMode?: boolean;
}

export function buildAgentContext(options: AgentContextOptions): string {
  const { config, memorySnapshot, skillIndex, platformHint, resumeRecap } = options;
  const metadata = getModelMetadata(config.model);
  const builder = new PromptBuilder();

  const prompt = builder.build({
    cwd: process.cwd(),
    identity: config.identity,
    modelHints: {
      name: config.model,
      capabilities: { ...metadata.capabilities },
    },
    memorySnapshot,
    platform: platformHint ?? `${process.platform} ${process.arch}, Node.js ${process.version}`,
    hasMemoryTool: options.hasMemoryTool,
    hasSessionSearchTool: options.hasSessionSearchTool,
    hasTodoWriteTool: options.hasTodoWriteTool,
    hasClarifyTool: options.hasClarifyTool,
    skillIndex,
  });

  const extra: string[] = [];

  if (resumeRecap) {
    extra.push(`# Session Continuity\n${resumeRecap}`);
  }

  if (options.planMode) {
    extra.push(
      "# Plan Mode Active\n" +
      `You are in Plan Mode. You can only use read-only tools (${planModeAllowedToolList()}). ` +
      `Mutating tools (${planModeBlockedToolList()}) are disabled.\n` +
      "Produce a structured plan. When ready, call exit_plan_mode to request execution approval.",
    );
  }

  if (extra.length === 0) return prompt;
  return [prompt, ...extra].join("\n\n");
}

/** Backward-compatible wrapper — delegates to buildAgentContext. */
export function buildSystemPrompt(config: Config, cwd: string = process.cwd()): string {
  // Preserve the original cwd-aware behaviour by building directly
  const metadata = getModelMetadata(config.model);
  const builder = new PromptBuilder();

  return builder.build({
    cwd,
    identity: config.identity,
    modelHints: {
      name: config.model,
      capabilities: { ...metadata.capabilities },
    },
    platform: `${process.platform} ${process.arch}, Node.js ${process.version}`,
  });
}

export function buildPermissionModel(config: Config): PermissionModel {
  const allowTools = config.permissions?.allowTools;

  return new PermissionModel({
    mode: config.permissionMode,
    allowList:
      config.permissionMode === "deny-by-default" || (allowTools?.length ?? 0) > 0
        ? allowTools
        : undefined,
    denyList: config.permissions?.denyTools,
    allowedPaths: config.allowedPaths,
  });
}
