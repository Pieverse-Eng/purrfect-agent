import type { ToolRegistry } from "../tool-registry.js";
import type { SessionStore } from "../session-store.js";
import type { HttpProvider } from "../provider.js";
import type { PermissionModel } from "../permissions.js";
import type { SkillRegistry } from "../skills/registry.js";
import { fileReadTool, createFileReadTool } from "./file-read.js";
import { fileWriteTool, createFileWriteTool } from "./file-write.js";
import { createFileEditTool } from "./file-edit.js";
import { shellExecTool, createShellExecTool } from "./shell-exec.js";
import type { SandboxMode } from "../sandbox/index.js";
import { webFetchTool } from "./web-fetch.js";
import { memoryTool, createMemoryTool } from "./memory.js";
import type { MemoryBackend } from "../memory/backend.js";
import { createSessionSearchTool } from "./session-search.js";
import { createDelegateTool } from "./delegate.js";
import { createReadRefTool, type ContextReferenceStore } from "../context-references.js";
import { createSkillManageTool } from "./skill-manage.js";
import { createTodoWriteTool } from "./todo-write.js";
import { createCheckpointCreateTool } from "./checkpoint-create.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "./plan-mode.js";
import { createClarifyTool } from "./clarify.js";
import { FileStateCache } from "./file-state-cache.js";
import type { AgentLoopOptions } from "../agent-loop.js";
import { isToolAllowed, type Platform } from "../toolsets.js";

export { fileReadTool, createFileReadTool } from "./file-read.js";
export { fileWriteTool, createFileWriteTool } from "./file-write.js";
export { createFileEditTool } from "./file-edit.js";
export { shellExecTool, createShellExecTool } from "./shell-exec.js";
export { webFetchTool } from "./web-fetch.js";
export { memoryTool, createMemoryTool } from "./memory.js";
export type { MemoryToolOptions } from "./memory.js";
export { createSessionSearchTool } from "./session-search.js";
export { createDelegateTool } from "./delegate.js";
export type { DelegateToolOptions } from "./delegate.js";
export { createReadRefTool } from "../context-references.js";
export { createSkillManageTool } from "./skill-manage.js";
export type { SkillManageToolOptions } from "./skill-manage.js";
export { createTodoWriteTool } from "./todo-write.js";
export type { TodoWriteToolOptions } from "./todo-write.js";
export { createCheckpointCreateTool } from "./checkpoint-create.js";
export type { CheckpointCreateToolOptions } from "./checkpoint-create.js";
export { createEnterPlanModeTool, createExitPlanModeTool } from "./plan-mode.js";
export type { PlanModeToolOptions } from "./plan-mode.js";
export { createClarifyTool } from "./clarify.js";
export type {
  ClarifyHandler,
  ClarifyOption,
  ClarifyRequest,
  ClarifyResponse,
  ClarifyToolOptions,
} from "./clarify.js";
export { FileStateCache } from "./file-state-cache.js";

export interface RegisterBuiltinsOptions {
  sessionStore?: SessionStore;
  provider?: HttpProvider;
  permissions?: PermissionModel;
  systemPrompt?: string;
  /**
   * Optional system prompt for child agents spawned via `delegate`. Should be
   * built with `hasTodoWriteTool: false` (the child registry excludes that
   * tool). If omitted, the parent `systemPrompt` is used — which may cause
   * child agents to reference tools they don't have.
   */
  childSystemPrompt?: string;
  onApprovalRequired?: AgentLoopOptions["onApprovalRequired"];
  maxDepth?: number;
  fileStateCache?: FileStateCache;
  skillRegistry?: SkillRegistry;
  skillsDir?: string;
  /** Runtime surface — controls which tools are registered. Default: purrfect-cli (all tools). */
  platform?: Platform;
  /** Model name for escalation tier lookup in delegate child loops. */
  modelName?: string;
  /** Store used by the read_ref tool and AgentLoop context references. */
  contextReferences?: ContextReferenceStore;
  /** Sandbox mode for shell_exec tool. Defaults to 'none' if not provided. */
  sandboxMode?: SandboxMode;
  /** Late-binding resolver for the current session id. Required for todo_write / checkpoint_create. */
  getSessionId?: () => string | undefined;
  /** Late-binding resolver for the current in-flight messages. Required for checkpoint_create. */
  getMessages?: () => import("../session-store.js").StoredMessage[];
  /** Late-binding resolver for plan-mode flag. Optional for checkpoint_create. */
  getPlanMode?: () => boolean;
  /** Setter for plan-mode flag. Required for plan mode tools. */
  setPlanMode?: (value: boolean) => void;
  /** Approval callback invoked when the agent requests to exit plan mode. */
  onExitPlanModeApproval?: () => Promise<boolean>;
  /** Interactive clarification callback used by the clarify tool. */
  onClarify?: import("./clarify.js").ClarifyHandler;
  /** Memory backend (overrides default LocalMarkdownBackend). */
  memoryBackend?: MemoryBackend;
}

/** Register all built-in tools into the given registry, filtered by platform. */
export function registerBuiltins(registry: ToolRegistry, options?: RegisterBuiltinsOptions): void {
  const platform = options?.platform ?? "purrfect-cli";

  const maybeRegister = (tool: { name: string } & Parameters<ToolRegistry["registerBuiltin"]>[0]) => {
    if (isToolAllowed(tool.name, platform)) {
      registry.registerBuiltin(tool);
    }
  };

  // Static tools (no shared state)
  const shellExec = createShellExecTool({ mode: options?.sandboxMode ?? "none" });
  maybeRegister(shellExec);
  maybeRegister(webFetchTool);
  maybeRegister(createReadRefTool(options?.contextReferences));
  maybeRegister(
    options?.memoryBackend ? createMemoryTool({ backend: options.memoryBackend }) : memoryTool,
  );
  if (options?.onClarify) {
    maybeRegister(createClarifyTool({ askClarification: options.onClarify }));
  }

  // File tools share a FileStateCache for read-before-write enforcement
  const cache = options?.fileStateCache ?? new FileStateCache();
  maybeRegister(createFileReadTool(cache));
  maybeRegister(createFileWriteTool(cache));
  maybeRegister(createFileEditTool(cache));

  if (options?.sessionStore && isToolAllowed("session_search", platform)) {
    registry.registerBuiltin(createSessionSearchTool(options.sessionStore));
  }

  if (options?.provider && isToolAllowed("delegate", platform)) {
    registry.registerBuiltin(
      createDelegateTool({
        provider: options.provider,
        toolRegistry: registry,
        permissions: options.permissions,
        sessionStore: options.sessionStore,
        systemPrompt: options.systemPrompt,
        childSystemPrompt: options.childSystemPrompt,
        onApprovalRequired: options.onApprovalRequired,
        maxDepth: options.maxDepth,
        modelName: options.modelName,
      }),
    );
  }

  if (options?.sessionStore && options?.getSessionId && isToolAllowed("todo_write", platform)) {
    registry.registerBuiltin(
      createTodoWriteTool({
        store: options.sessionStore,
        getSessionId: options.getSessionId,
      }),
    );
  }

  if (options?.sessionStore && options?.getSessionId && isToolAllowed("checkpoint_create", platform)) {
    const store = options.sessionStore;
    const getSessionId = options.getSessionId;
    // Fall back to reading persisted messages from the DB when no in-flight snapshot is
    // provided. This covers most of the conversation; only the current assistant turn's
    // message (not yet persisted at tool dispatch time) is absent.
    const getMessages =
      options.getMessages ??
      (() => {
        const sid = getSessionId();
        if (!sid) return [];
        return store.getMessages(sid);
      });
    registry.registerBuiltin(
      createCheckpointCreateTool({
        store,
        getSessionId,
        getMessages,
        getPlanMode: options.getPlanMode,
      }),
    );
  }

  if (options?.skillRegistry && options?.skillsDir) {
    registry.registerBuiltin(
      createSkillManageTool({
        skillRegistry: options.skillRegistry,
        skillsDir: options.skillsDir,
      }),
    );
  }

  if (options?.getPlanMode && options?.setPlanMode && options?.onExitPlanModeApproval) {
    const planModeOpts = {
      getPlanMode: options.getPlanMode,
      setPlanMode: options.setPlanMode,
      onExitApproval: options.onExitPlanModeApproval,
    };
    if (isToolAllowed("enter_plan_mode", platform)) {
      registry.registerBuiltin(createEnterPlanModeTool(planModeOpts));
    }
    if (isToolAllowed("exit_plan_mode", platform)) {
      registry.registerBuiltin(createExitPlanModeTool(planModeOpts));
    }
  }
}
