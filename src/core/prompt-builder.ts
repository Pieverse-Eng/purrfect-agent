/**
 * System prompt assembly — identity, context files, memory snippets, platform hints.
 *
 * Stateless assembly with injection scanning and context file discovery.
 * Skills are NOT included here — they are injected at runtime by AgentLoop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { guardContextFileContent } from "./safety/context-file-guard.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY =
  "You are Purr-Fect Agent, an intelligent AI assistant. " +
  "You are helpful, knowledgeable, and direct. You assist users with a wide " +
  "range of tasks including answering questions, writing and editing code, " +
  "analyzing information, creative work, and executing actions via your tools. " +
  "You communicate clearly, admit uncertainty when appropriate, and prioritize " +
  "being genuinely useful over being verbose.";

// ---------------------------------------------------------------------------
// Behavioral guidance blocks — tell the agent WHEN to use specific tools
// ---------------------------------------------------------------------------

const MEMORY_GUIDANCE =
  "You have persistent memory across sessions. Save durable facts using the memory " +
  "tool: user preferences, environment details, tool quirks, and stable conventions. " +
  "Memory is injected into every session, so keep it compact and focused on facts that " +
  "will still matter later.\n" +
  "Prioritize what reduces future user steering — the most valuable memory is one " +
  "that prevents the user from having to correct or remind you again. " +
  "User preferences and recurring corrections matter more than procedural task details.\n" +
  "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO " +
  "state to memory; use session_search to recall those from past transcripts.";

const SKILLS_GUIDANCE =
  "You can create, update, and remove skills at runtime using the skill_manage tool. " +
  "After completing a complex task that required 5+ tool calls, consider saving the " +
  "approach as a reusable skill. Skills are markdown files with YAML frontmatter " +
  "(name, description, triggers) and a body with instructions. " +
  "Use skill_manage(action='list') to see available skills, and " +
  "skill_manage(action='view', name='...') to read full skill content.";

const TODO_WRITE_GUIDANCE =
  "You have a session-scoped task list via the todo_write tool. Use it when a user " +
  "request requires 3 or more distinct steps, spans multiple tool calls, or is easy " +
  "to lose track of mid-execution. Create the initial list as soon as you understand " +
  "the work, then update it after each meaningful step.\n" +
  "Rules:\n" +
  "- Each call REPLACES the full list — always pass every todo, not just changes.\n" +
  "- At most ONE todo may have status 'in_progress' at any time.\n" +
  "- Mark a todo 'completed' the moment it is actually done; never batch completions.\n" +
  "- 'activeForm' is the present-continuous description shown while a task runs " +
  "(e.g. content='Run tests', activeForm='Running tests'). It is required when " +
  "a task is in_progress; optional for pending/completed tasks.\n" +
  "- Do NOT use todo_write for trivial single-step requests — it is overhead there.";

const SESSION_SEARCH_GUIDANCE =
  "When the user references something from a past conversation or you suspect " +
  "relevant cross-session context exists, use session_search to recall it before " +
  "asking them to repeat themselves.";

const CLARIFY_GUIDANCE =
  "Use the clarify tool when you cannot proceed responsibly without a user decision: " +
  "the request is ambiguous, a choice is high-risk or expensive to undo, or a required " +
  "parameter is missing. Ask one clear question, include 2-4 concise options when useful, " +
  "mark a sensible default when you can, and include the reason so the user understands " +
  "why you are asking. Prefer making reasonable assumptions for low-risk routine choices; " +
  "do not use clarify for simple dangerous-command approval handled by permissions.";

/**
 * Tool-use enforcement guidance injected only for models that tend to
 * describe intentions instead of calling tools (e.g. GPT, Codex).
 */
const TOOL_USE_ENFORCEMENT_GUIDANCE =
  "You MUST use your tools to take action — do not describe what you would do " +
  "or plan to do without actually doing it. When you say you will perform an " +
  "action (e.g. 'I will run the tests', 'Let me check the file'), you MUST " +
  "immediately make the corresponding tool call in the same response. " +
  "Never end your turn with a promise of future action — execute it now.\n" +
  "Every response should either (a) contain tool calls that make progress, or " +
  "(b) deliver a final result to the user. Responses that only describe intentions " +
  "without acting are not acceptable.";

/**
 * Model name substrings that trigger tool-use enforcement guidance.
 * These models tend to describe actions instead of executing them.
 */
const TOOL_USE_ENFORCEMENT_MODELS = ["gpt", "codex"];

/** Maximum characters for a context file before truncation. */
export const CONTEXT_FILE_MAX_CHARS = 100_000;

/**
 * Context file names in priority order. The first match wins.
 * .purrfect.md > CLAUDE.md > AGENTS.md > .hermes.md
 */
const CONTEXT_FILE_NAMES = [
  ".purrfect.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".hermes.md",
];

// ---------------------------------------------------------------------------
// Prompt injection scanning
// ---------------------------------------------------------------------------

const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_override"],
  [/^system\s*:\s*/im, "system_role_override"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [
    /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
    "disregard_rules",
  ],
  [
    /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    "bypass_restrictions",
  ],
  [
    /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i,
    "html_comment_injection",
  ],
  [/<\s*div\s+style\s*=\s*["'].*display\s*:\s*none/i, "hidden_div"],
  [
    /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i,
    "translate_execute",
  ],
  [
    /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    "exfil_curl",
  ],
  [
    /(?:curl|wget)\s+[^\n]*(?:\$\(|`)[^\n]*(?:cat|head|tail)\s+[^\n]*(?:\/etc\/|\/proc\/|\/home\/)/i,
    "exfil_cmd_substitution",
  ],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, "read_secrets"],
  [
    /(?:show|print|reveal|display|output|dump|echo)\s+[^\n]*(?:api[_\s]?key|secret[_\s]?key|password|token|credential)/i,
    "credential_access",
  ],
  [
    /(?:print|echo|cat|show)\s+[^\n]*(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET|GITHUB_TOKEN)/i,
    "env_credential_access",
  ],
  [/bypass\s+(?:your\s+)?(?:restrictions|safety|filters|rules|guardrails)/i, "bypass_restrictions"],
];

const INVISIBLE_CHARS = new Set([
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
]);

/**
 * Scan context file content for prompt injection patterns.
 * Returns the original content if clean, or a BLOCKED message if threats found.
 */
export function scanContextContent(content: string, filename: string): string {
  return guardContextFileContent(content, filename).content;
}

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content that exceeds CONTEXT_FILE_MAX_CHARS, preserving head and tail.
 */
export function truncateContent(
  content: string,
  filename: string,
  maxChars: number = CONTEXT_FILE_MAX_CHARS,
): string {
  if (content.length <= maxChars) {
    return content;
  }

  const keepEach = Math.floor(maxChars * 0.4);
  const head = content.slice(0, keepEach);
  const tail = content.slice(-keepEach);
  const marker = `\n\n[... ${filename} truncated: ${content.length} chars exceeded ${maxChars} limit ...]\n\n`;

  return head + marker + tail;
}

// ---------------------------------------------------------------------------
// Context file discovery
// ---------------------------------------------------------------------------

/**
 * Find the git repository root by walking up from `start`.
 */
function findGitRoot(start: string): string | null {
  let current = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null; // filesystem root
    }
    current = parent;
  }
}

/**
 * Discover the nearest context file by walking up from `cwd`.
 * Stops at the git root (or filesystem root).
 * Priority: .purrfect.md > CLAUDE.md > AGENTS.md > .hermes.md
 */
function findContextFile(cwd: string): string | null {
  const gitRoot = findGitRoot(cwd);
  let current = path.resolve(cwd);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of CONTEXT_FILE_NAMES) {
      const candidate = path.join(current, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // file doesn't exist, continue
      }
    }

    // Stop at git root
    if (gitRoot && current === gitRoot) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break; // filesystem root
    }
    current = parent;
  }

  return null;
}

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export interface PromptBuilderOptions {
  identity?: string;
}

export interface IdentityConfig {
  name?: string;
  persona?: string;
  instructions?: string;
}

export interface ModelHints {
  name: string;
  capabilities: Record<string, boolean>;
}

export interface BuildOptions {
  cwd?: string;
  memory?: string[];
  memorySnapshot?: string;
  platform?: string;
  identity?: IdentityConfig;
  modelHints?: ModelHints;
  /** Whether the memory tool is available in this session. */
  hasMemoryTool?: boolean;
  /** Whether the session_search tool is available in this session. */
  hasSessionSearchTool?: boolean;
  /** Whether the skill_manage tool is available in this session. */
  hasSkillManageTool?: boolean;
  /** Whether the todo_write tool is available in this session. */
  hasTodoWriteTool?: boolean;
  /** Whether the clarify tool is available in this session. */
  hasClarifyTool?: boolean;
  /** Concise skill index (name + description) for system prompt. */
  skillIndex?: string;
}

export class PromptBuilder {
  private readonly identity: string;

  constructor(options?: PromptBuilderOptions) {
    this.identity = options?.identity ?? DEFAULT_IDENTITY;
  }

  /**
   * Assemble the system prompt from identity, context files, and memory.
   * Skills are NOT included — they are injected by AgentLoop at runtime.
   */
  build(options?: BuildOptions): string {
    const sections: string[] = [];

    // 1. Identity — BuildOptions.identity overrides constructor identity
    if (options?.identity) {
      const parts: string[] = [];
      if (options.identity.name) {
        parts.push(`You are ${options.identity.name}.`);
      }
      if (options.identity.persona) {
        parts.push(`You are ${options.identity.persona}.`);
      }
      if (options.identity.instructions) {
        parts.push(options.identity.instructions);
      }
      sections.push(parts.join(" "));
    } else {
      sections.push(this.identity);
    }

    // 2. Behavioral guidance — only when tools are available
    if (options?.hasMemoryTool) {
      sections.push(`# Memory Guidance\n${MEMORY_GUIDANCE}`);
    }
    if (options?.hasSessionSearchTool) {
      sections.push(`# Session Search Guidance\n${SESSION_SEARCH_GUIDANCE}`);
    }
    if (options?.hasClarifyTool) {
      sections.push(`# Clarification Guidance\n${CLARIFY_GUIDANCE}`);
    }
    if (options?.hasTodoWriteTool) {
      sections.push(`# Task List Guidance\n${TODO_WRITE_GUIDANCE}`);
    }
    if (options?.hasSkillManageTool) {
      sections.push(`# Skills Guidance\n${SKILLS_GUIDANCE}`);
    }
    if (options?.skillIndex) {
      sections.push(`# Available Skills\n${options.skillIndex}`);
    }

    // 2b. Tool-use enforcement for models that need it
    if (options?.modelHints?.name) {
      const modelLower = options.modelHints.name.toLowerCase();
      if (TOOL_USE_ENFORCEMENT_MODELS.some((m) => modelLower.includes(m))) {
        sections.push(`# Tool Use\n${TOOL_USE_ENFORCEMENT_GUIDANCE}`);
      }
    }

    // 3. Context file (if cwd provided)
    if (options?.cwd) {
      const contextPath = findContextFile(options.cwd);
      if (contextPath) {
        try {
          let content = fs.readFileSync(contextPath, "utf-8");
          const filename = path.basename(contextPath);

          // Scan for injection
          content = scanContextContent(content, filename);

          // Truncate if needed (only if not already blocked)
          if (!content.startsWith("[BLOCKED:")) {
            content = truncateContent(content, filename);
          }

          sections.push(`# Project Context (${filename})\n${content}`);
        } catch {
          // Failed to read context file — skip silently
        }
      }
    }

    // 4. .cursorrules (if cwd provided)
    if (options?.cwd) {
      const cursorrulesPath = path.join(options.cwd, ".cursorrules");
      try {
        if (fs.statSync(cursorrulesPath).isFile()) {
          let content = fs.readFileSync(cursorrulesPath, "utf-8");
          content = scanContextContent(content, ".cursorrules");
          if (!content.startsWith("[BLOCKED:")) {
            content = truncateContent(content, ".cursorrules");
          }
          sections.push(`# Project Rules (.cursorrules)\n${content}`);
        }
      } catch {
        // .cursorrules doesn't exist — skip silently
      }
    }

    // 5. Model hints
    if (options?.modelHints) {
      const capList = Object.entries(options.modelHints.capabilities)
        .map(([key, val]) => `${key}: ${val ? "yes" : "no"}`)
        .join(", ");
      sections.push(
        `# Model Hints\nYou are running on ${options.modelHints.name}. Capabilities: ${capList}.`,
      );
    }

    // 6. Memory snapshot (from MemoryStore)
    if (options?.memorySnapshot && options.memorySnapshot.trim().length > 0) {
      sections.push(`# Memory Snapshot\n${options.memorySnapshot.trim()}`);
    }

    // 7. Memory snippets (legacy array form)
    if (options?.memory && options.memory.length > 0) {
      const memoryBlock = options.memory.map((m) => `- ${m}`).join("\n");
      sections.push(`# Memory\n${memoryBlock}`);
    }

    // 8. Platform hints
    if (options?.platform) {
      sections.push(`# Platform\n${options.platform}`);
    }

    return sections.join("\n\n");
  }
}
