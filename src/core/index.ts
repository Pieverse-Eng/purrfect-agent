export { ConfigSchema, validateConfig, migrateConfig } from "./config-schema.js";
export type { Config } from "./config-schema.js";
export { getModelMetadata, getContextLength } from "./model-metadata.js";
export type { ModelMetadata, ModelCapabilities, ModelMetadataOverrides } from "./model-metadata.js";
export { ToolRegistry } from "./tool-registry.js";
export { HttpProvider } from "./provider.js";
export type { ChatResponse } from "./provider.js";
export { CredentialPool } from "./credential-pool.js";
export type {
  CredentialPoolEntry,
  CredentialPoolOptions,
  CredentialProvider,
  CredentialStatus,
} from "./credential-pool.js";
export { parseSSEStream } from "./stream-parser.js";
export { AnthropicProvider } from "./anthropic-provider.js";
export { parseAnthropicSSEStream } from "./anthropic-stream-parser.js";
export { RetryPolicy } from "./retry.js";
export { ModelRouter } from "./router.js";
export type { ModelRouterConfig, ModelEntry } from "./router.js";
export {
  HeuristicModelRoutingPolicy,
  SmartModelRoutingController,
  createEmptyTierUsage,
  estimateRoutingCostSavings,
} from "./model-routing.js";
export type {
  ModelRoutingDecision,
  ModelRoutingPolicy,
  ModelTier,
  ModelTierUsage,
  ModelTierUsageMap,
  SmartModelRoutingControllerOptions,
  SmartModelRoutingInput,
} from "./model-routing.js";
export { SessionStore } from "./session-store.js";
export type {
  SessionRecord,
  CreateSessionOptions,
  StoredMessage,
  AppendMessageOptions,
  SearchResult,
} from "./session-store.js";
export { PromptBuilder } from "./prompt-builder.js";
export type { PromptBuilderOptions, BuildOptions } from "./prompt-builder.js";
export { scanContextContent, truncateContent, CONTEXT_FILE_MAX_CHARS } from "./prompt-builder.js";
export { PermissionModel } from "./permissions.js";
export type { PermissionCheckResult, PermissionModelOptions } from "./permissions.js";
export {
  ContextCompressor,
  SUMMARY_PREFIX,
  pruneToolResults,
  createProviderSummarizer,
  estimateTokens,
  estimateTotalTokens,
} from "./compressor.js";
export {
  TrajectoryCompressor,
  compressTrajectory,
  TRAJECTORY_DUPLICATE_RESULT_PLACEHOLDER,
  TRAJECTORY_FILE_SNAPSHOT_HEADER,
} from "./trajectory-compressor.js";
export {
  ContextReferenceStore,
  createReadRefTool,
  DEFAULT_CONTEXT_REFERENCE_THRESHOLD_BYTES,
} from "./context-references.js";
export type {
  ContextReference,
  ContextReferenceStoreOptions,
  MaterializedToolResult,
  MaterializeToolResultOptions,
} from "./context-references.js";
export { AgentLoop, IterationBudget } from "./agent-loop.js";
export type { AgentEvent, AgentLoopOptions } from "./agent-loop.js";
export { generateSessionRecap } from "./session-resume.js";
export type { SessionStoreLike as SessionResumeStoreLike } from "./session-resume.js";
export type {
  CompressorOptions,
  CompressOptions,
  SummarizerProvider,
  SummarizeCallback,
  PruneToolResultsOptions,
} from "./compressor.js";
export type {
  TrajectoryCompressionOptions,
  TrajectoryCompressionMetrics,
  TrajectoryCompressionResult,
} from "./trajectory-compressor.js";

export {
  AwesomeCliError,
  ProviderError,
  RateLimitError,
  AuthError,
  NetworkError,
  ToolExecutionError,
  PermissionDeniedError,
  SessionStoreError,
  CompressorError,
} from "./errors.js";

export type {
  Message,
  ToolCall,
  ToolDefinition,
  ToolSchema,
  ProviderConfig,
  StreamDelta,
} from "./types.js";

export {
  fileReadTool,
  fileWriteTool,
  shellExecTool,
  createShellExecTool,
  webFetchTool,
  memoryTool,
  registerBuiltins,
  createDelegateTool,
  createFileReadTool,
  createFileWriteTool,
  createFileEditTool,
  FileStateCache,
} from "./tools/index.js";
export type { DelegateToolOptions } from "./tools/index.js";

export { SkillLoader } from "./skills/loader.js";
export { SkillRegistry, SKILL_LAYER_ORDER } from "./skills/registry.js";
export type { SkillLayerSource } from "./skills/registry.js";
export { SkillHub } from "./skills/hub.js";
export type { SkillTap, TapSkill, SkillAuditReport, SkillCheckResult } from "./skills/hub.js";
export { defaultSkillLayerSources, loadRuntimeSkills } from "./skills/layers.js";
export type { RuntimeSkillRegistry, SkillLayerOptions } from "./skills/layers.js";
export type { SkillDefinition, SkillLayer } from "./skills/types.js";

export { CronStore } from "./cron/store.js";
export type { CronJob } from "./cron/store.js";
export { CronScheduler } from "./cron/scheduler.js";
export type { JobFireCallback } from "./cron/scheduler.js";

export { CacheStats } from "./cache-stats.js";
export type { CacheUsage } from "./cache-stats.js";
export {
  applyAnthropicPromptCaching,
  normalizeOpenAiUsage,
} from "./prompt-caching.js";
export type {
  OpenAiUsageLike,
  PromptCacheControl,
} from "./prompt-caching.js";

export { resolveSecret, resolveApiKey, SecretRegistry, SecretRefSchema } from "./secrets.js";
export type { SecretRef, ProviderType } from "./secrets.js";
export { scanForPromptInjection } from "./safety/injection-scan.js";
export type { InjectionScanResult, SafetyFinding } from "./safety/injection-scan.js";
export { redactSensitiveText, sanitizeToolResultObject } from "./safety/redact.js";
export type { Redaction, RedactionResult, SafetyAction, ToolSafetyResult } from "./safety/redact.js";
export { checkUrlPolicy } from "./safety/url-policy.js";
export type { UrlPolicyOptions, UrlPolicyResult } from "./safety/url-policy.js";
export { guardContextFileContent } from "./safety/context-file-guard.js";
export type { ContextFileGuardResult } from "./safety/context-file-guard.js";
export { getToolsForPlatform, isToolAllowed, CORE_TOOLS } from "./toolsets.js";
export type { Platform } from "./toolsets.js";

export { MemoryStore } from "./memory/store.js";
export { parseEntries, serializeEntries } from "./memory/parser.js";
export type { MemoryEntry } from "./memory/parser.js";

export { PluginManifestSchema } from "./plugins/manifest.js";
export type { PluginManifest } from "./plugins/manifest.js";
export { PluginDiscovery } from "./plugins/discovery.js";
export { HookRegistry } from "./plugins/hooks.js";
export type { HookEvent, HookHandler } from "./plugins/hooks.js";
export { PluginLoader } from "./plugins/loader.js";
export type { PluginModule } from "./plugins/loader.js";
export { CapabilityRegistry } from "./plugins/capability-registry.js";
export type {
  CommandDefinition,
  ProviderEntry,
  ContextEngineEntry,
  PluginCapabilities,
} from "./plugins/capability-registry.js";

export { TaskStore } from "./tasks/store.js";
export type { TaskRecord, TaskStatus, CreateTaskOptions } from "./tasks/store.js";
export { TaskRunner } from "./tasks/runner.js";
export type { SpawnFn } from "./tasks/runner.js";

export { McpClient } from "./mcp/client.js";
export type { McpClientOptions } from "./mcp/client.js";
