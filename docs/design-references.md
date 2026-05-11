# Agent CLI Overview: Claude Code, Hermes Agent, and OpenClaw

## Scope

This workspace contains direct source trees for:

- `claude-code`
- `hermes-agent`
- `openclaw` (via symlink to `../openclaw-as-service/purrfectclaw`)

All three sections below are source-based overviews. The OpenClaw tree is symlinked into this folder, which is why it was easy to miss on a first pass.

## Quick Repo Read

| Repo | Shape | Core idea | Standout strengths |
| --- | --- | --- | --- |
| `claude-code` | TypeScript CLI + custom Ink/React terminal app | Productized coding assistant CLI with strong UX, permissions, MCP, plugins, and background tasks | Best terminal UX, strong tool/policy plumbing, mature command surface, first-class MCP/plugin architecture |
| `hermes-agent` | Python agent runtime + CLI + gateway + tool ecosystem | General-purpose agent runtime that can run in CLI, editor, API server, and messaging contexts | Strong runtime modularity, broad provider support, memory/skills/session features, delegation, compression |
| `openclaw` | TypeScript local-first gateway + CLI + plugin platform | Agent system organized around a Gateway control plane, isolated agents/workspaces, and a manifest-first capability/plugin registry | Best control-plane architecture, strongest plugin/capability model, multi-channel routing, pluggable CLI backends, strong subagent/session isolation |

## Repo-by-Repo Notes

### 1. Claude Code

Relevant files:

- `claude-code/src/main.tsx`
- `claude-code/src/query.ts`
- `claude-code/src/tools.ts`
- `claude-code/src/tasks/LocalMainSessionTask.ts`

What it appears to be:

- A large, polished terminal product, not just an agent loop.
- `src/main.tsx` is the real bootstrap: startup optimization, auth/config loading, policy checks, MCP/plugin/skill initialization, command registration, and REPL launch.
- The command surface is extensive: chat, MCP management, server mode, SSH remote mode, auth, plugins, marketplaces, agents, doctor, update, tasks, export, logs, and more.

Key architectural components:

- **CLI/bootstrap layer**: command parsing, startup checks, onboarding, auth, policy loading, remote/local mode selection.
- **Terminal UI layer**: custom Ink stack, React-based screens, dialogs, focus handling, keybindings, render pipeline.
- **Query engine**: streaming model loop in `src/query.ts` with tool calls, continuation handling, token budgets, compaction, hook execution, and message normalization.
- **Tool system**: `src/tools.ts` assembles built-in tools plus MCP tools, filtered through permission context and deny rules.
- **Background task model**: `LocalMainSessionTask.ts` shows a strong pattern for backgrounding an active session while keeping transcript/output isolation.
- **Extension surface**: plugins, marketplaces, bundled skills, MCP resources/tools, remote bridge/server.

What is especially worth copying:

- Tool pool assembly as a first-class subsystem, not ad hoc branching.
- Permissions integrated both before prompt construction and at execution time.
- Background session/task handling with explicit task IDs, disk-backed output, and notifications.
- Strong separation between command/bootstrap code and the actual query loop.
- A serious terminal UI architecture instead of a print-loop REPL.

Tradeoff:

- It is very feature-dense. Great reference for polish and architecture boundaries, but not the model for a minimal first version.

### 2. Hermes Agent

Relevant files:

- `hermes-agent/hermes_cli/main.py`
- `hermes-agent/run_agent.py`
- `hermes-agent/environments/agent_loop.py`
- `hermes-agent/tools/registry.py`
- `hermes-agent/toolsets.py`
- `hermes-agent/agent/prompt_builder.py`

What it appears to be:

- A reusable agent runtime first, CLI product second.
- The runtime is designed to work across CLI, editor/ACP, API server, gateway/messaging, and training/eval environments.

Key architectural components:

- **Command surface**: `hermes_cli/main.py` exposes chat/setup/model/doctor/status/cron/gateway/honcho/sessions/claw and more.
- **Runtime agent**: `run_agent.py` contains the long-lived `AIAgent` state machine with session IDs, logging, memory, Honcho integration, interrupts, checkpoints, compression, and delegation state.
- **Reusable loop**: `environments/agent_loop.py` is a clean standalone OpenAI-style tool-calling loop. This is one of the clearest “engine core” references in the repo.
- **Tool registry**: `tools/registry.py` gives a simple but solid registry pattern: register at import time, retrieve schemas, dispatch uniformly, bridge async handlers, expose toolset metadata.
- **Toolsets**: `toolsets.py` separates raw tools from product bundles (`web`, `terminal`, `file`, `browser`, `delegation`, `hermes-acp`, `hermes-api-server`, etc.).
- **Prompt builder**: `agent/prompt_builder.py` is strong. It assembles identity, memory guidance, session search guidance, skills index, platform hints, and project context files.
- **Context-file hygiene**: prompt-injection scanning for `SOUL.md`, `AGENTS.md`, `.hermes.md`, `CLAUDE.md`, `.cursorrules`.
- **Skill indexing**: cached, filtered skills manifest with both in-process and disk snapshot caching.
- **Long-context management**: compression is explicit and configurable rather than hidden in the loop.

What is especially worth copying:

- Clear separation of agent runtime, CLI shell, tool registry, toolset bundles, and prompt builder.
- Toolsets as a product abstraction. This makes it easy to expose different capabilities in CLI vs API vs editor.
- Prompt-builder discipline: identity + policy + context files + skills + memory guidance.
- Built-in session persistence, session search, and cross-session memory.
- Interrupt propagation, subagent/delegation support, and checkpointing as explicit runtime concepts.

Tradeoff:

- The runtime surface is broad, so it is easier to overbuild if you copy too much at once.

### 3. OpenClaw

Relevant files:

- `openclaw/src/entry.ts`
- `openclaw/src/cli/run-main.ts`
- `openclaw/src/cli/program/core-command-descriptors.ts`
- `openclaw/src/cli/program/subcli-descriptors.ts`
- `openclaw/src/agents/cli-runner.ts`
- `openclaw/src/agents/cli-session.ts`
- `openclaw/docs/plugins/architecture.md`
- `openclaw/docs/plugins/sdk-overview.md`
- `openclaw/docs/tools/subagents.md`
- `openclaw/docs/tools/skills.md`

What it appears to be:

- A full local-first agent platform, not just a CLI wrapper.
- The center of the system is the Gateway control plane. CLI, WebChat, apps/nodes, channels, and agent runs all hang off that.
- The CLI bootstrap is optimized heavily: fast root help/version paths, lazy command registration, profile/container rewriting, and container-aware execution in `src/entry.ts` and `src/cli/run-main.ts`.

Key architectural components:

- **Gateway-first architecture**: OpenClaw treats the gateway as the control plane for sessions, channels, tools, events, UI surfaces, and node/app integrations.
- **Large but coherent command surface**: root commands cover setup/onboard/config/doctor/dashboard/message/agent/agents/status/sessions; sub-CLIs add gateway, models, plugins, channels, hooks, cron, sandbox, tui, acp, nodes, devices, secrets, approvals, and more.
- **Per-agent isolation model**: agents have isolated workspaces, identities, session stores, and routing. The docs and commands make per-agent workspaces a first-class product concept, not an implementation detail.
- **Pluggable agent backends**: the plugin SDK can register CLI backends, so local AI CLIs such as Claude CLI or Codex CLI are part of the architecture rather than one-off adapters.
- **Manifest-first plugin system**: discovery and validation happen from manifest/schema metadata before runtime code is loaded. Then enabled plugins register capabilities into a central registry.
- **Capability model instead of simple plugins**: plugins can register providers, channels, tools, commands, hooks, CLI surfaces, HTTP routes, gateway methods, services, context engines, memory runtimes, and more.
- **Shared tool host with plugin-owned execution**: OpenClaw’s `message` tool is especially strong as a pattern. Core owns the generic tool surface and bookkeeping, while channel plugins own action discovery and final execution.
- **Subagent model**: subagents are explicit background runs with their own sessions, announce-back behavior, concurrency limits, nested depth control, and optional thread binding.
- **Skills model**: strong precedence rules across bundled, managed, personal, project, and workspace skills, plus plugin-shipped skills and registry integration through ClawHub.
- **Security model**: it is explicit about host access vs sandboxed non-main sessions, which is the right architecture for an agent meant to operate across personal and group channels.

Why it matters for your CLI:

- Claude Code is strongest at terminal UX, Hermes is strongest at runtime modularity, and OpenClaw is strongest at turning the whole system into a control plane with clean ownership boundaries.
- OpenClaw’s plugin/capability design is useful if you want channels, providers, tools, HTTP routes, hooks, and CLI extensions to be registered the same way instead of bolted on separately.
- Its per-agent workspace/session model is also a good reference if you want multiple agent identities or routing domains without mixing their state.

Tradeoff:

- It is the broadest platform here, so copying it wholesale would overcomplicate a first implementation. The main things to borrow are the capability boundaries and session/workspace model, not the entire surface area.

## Key Components Of A Good Agent CLI

If your goal is to build your own agent CLI, these are the components that matter most.

### 1. Entry point and command surface

You need more than `chat`.

- Interactive chat
- One-shot prompt mode
- Resume/browse sessions
- Setup/auth/model selection
- Doctor/status
- Tool/plugin/MCP management
- Optional server/API/editor modes

Claude Code is strongest here for product completeness. Hermes is strong for breadth and operator workflows.

### 2. System prompt and context assembly

This should be a dedicated subsystem, not inline string concatenation.

It usually needs:

- agent identity
- behavior/policy guidance
- project instruction files
- memory snippets
- skills/indexed workflows
- platform-specific formatting rules
- session continuity context

Hermes has the cleanest explicit prompt-builder module in this workspace.

### 3. Tool registry

Treat tools as data:

- name
- schema
- handler
- availability check
- grouping/toolset
- permission/safety metadata

Hermes has the clearest minimal registry pattern. Claude Code has the strongest “tool assembly under permissions + MCP merge” pattern. OpenClaw has the strongest “registry as the foundation for the whole platform” pattern.

### 4. Tool-calling loop

This is the real engine:

- send messages + tool schemas
- stream assistant output
- detect tool calls
- validate tool names and args
- execute tools
- append tool results
- repeat until completion or max turns

Hermes’ `environments/agent_loop.py` is the cleanest compact reference. Claude Code’s `query.ts` is the more industrial version with compaction, thinking preservation, hooks, and streaming edge cases.

### 5. Session model

A real agent CLI needs session state, not just chat history in RAM.

- session id
- transcripts/logs
- resume
- search
- background runs
- optional DB index

Claude Code shines on backgrounded sessions. Hermes shines on persistence and session search. OpenClaw is strongest on multi-agent session keys, per-agent workspaces, and routing-aware sessions.

### 6. Context pressure management

You will need this earlier than you think.

- token accounting
- compression/summarization
- protected recent turns
- tool-result budgeting
- continuation/recovery logic

Claude Code and Hermes both treat this as a dedicated concern, which is correct.

### 7. Memory

There are really three layers:

- per-session transcript history
- durable local memory/preferences
- optional external memory system

Hermes is strongest here because it supports local memory, session search, and Honcho-backed cross-session memory. OpenClaw is useful for its explicit session/workspace separation and plugin-owned memory/context-engine slots.

### 8. Extensibility

This is where these repos differ most.

- Claude Code: MCP, plugins, marketplaces, server/bridge modes
- Hermes: toolsets, skills, ACP/editor mode, gateway integrations
- OpenClaw: manifest-first capability/plugin registry, channel plugins, CLI backends, hooks, context engines, memory runtimes

Your architecture should decide early whether extensions are:

- core-owned modules
- tool/plugin packages
- lifecycle hooks
- protocol-based integrations

### 9. UX layer

The UX is not decoration. It changes how usable the system feels.

- streaming output
- status indicators
- keybindings
- interruption
- approvals
- background notifications
- structured errors

Claude Code is the strongest reference here by a large margin.

### 10. Safety and policy

A serious agent CLI needs:

- permission modes
- deny lists / allow lists
- tool filtering before prompt exposure
- runtime validation at execution time
- trust/onboarding flows
- context-file injection protection

Claude Code is strongest on permissions. Hermes is notably good on scanning context files before injecting them into the system prompt.

## Best Features To Borrow

### Borrow from Claude Code

- Product-grade terminal UX
- Permission-aware tool assembly
- Built-in + MCP tool merging
- Background sessions/tasks
- Rich command surface
- Remote/server/bridge thinking

### Borrow from Hermes Agent

- Clean agent runtime boundaries
- Simple central tool registry
- Toolsets as capability bundles
- Prompt-builder module
- Skills + session search + memory as first-class features
- Interrupt/delegation/checkpoint support
- Explicit context compression

### Borrow from OpenClaw

- Manifest-first plugin discovery and validation
- Capability ownership model instead of ad hoc extension points
- Shared core tool surfaces with plugin-owned execution
- Per-agent workspace/session/routing architecture
- Subagent sessions with announce-back, depth limits, and thread binding
- Clear host-vs-sandbox security split by session type

## Recommended Blueprint For Your Own CLI

### Phase 1: Build the smallest serious core

Implement these first:

1. `main` / command parser
2. `AgentRuntime`
3. `PromptBuilder`
4. `ToolRegistry`
5. `AgentLoop`
6. `SessionStore`
7. basic TUI/REPL

Keep it small:

- one model provider
- local tool registry only
- local session logs
- no plugins yet
- no external memory yet

### Phase 2: Add the right product features

Then add:

- permission model
- resumable/searchable sessions
- context compression
- background tasks
- tool bundles/toolsets
- skill/workflow system

This is where Hermes and Claude Code are most helpful.

### Phase 3: Add extension surfaces

Choose one or both:

- protocol-based extensions like MCP
- hook/plugin lifecycle architecture

This is where Claude Code + OpenClaw together are useful references.

### Phase 4: Add durable memory carefully

Add memory in layers:

1. transcript search
2. compact durable preferences/facts
3. optional external memory backend
4. multi-agent memory structure only if you truly need it

Hermes is the best reference for the layering. OpenClaw is the best reference for session isolation and plugin-owned memory/context surfaces.

## Practical Takeaway

If I were designing a new agent CLI from these three references, I would combine them like this:

- **Base runtime shape from Hermes**
  - simple registry
  - prompt builder
  - reusable loop
  - session/memory/compression as explicit subsystems
- **UX and operator experience from Claude Code**
  - polished REPL
  - strong permissions
  - background tasks
  - extension/protocol integration
- **Platform architecture from OpenClaw**
  - gateway/control-plane thinking
  - capability registry for channels/providers/tools/CLI
  - isolated per-agent workspaces and sessions
  - plugin-owned execution behind shared core surfaces

The main design rule: keep the **agent loop** small, and move everything else into explicit subsystems around it. Claude Code and Hermes both do this, just at different scales.

## Suggested Starting Architecture

```text
cli/
  main
  commands
  tui

core/
  runtime
  agent_loop
  prompt_builder
  session_store
  permissions
  compression

tools/
  registry
  builtins
  toolsets

extensions/
  mcp
  plugins
  hooks
  gateway

memory/
  session_search
  durable_memory
  external_memory
```

That structure keeps the center of the system understandable while still leaving room to incorporate the strongest ideas from all three implementations.
