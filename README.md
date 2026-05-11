# Purr-Fect Agent

A TypeScript agent that runs in your terminal, editor (via ACP), and chat apps
(Slack, Discord, Telegram, LINE, webhooks) — and gets smarter over time by
writing its own memory and skills.

> Status: **alpha (v0.1)**. APIs and storage formats may change.

## Why

Most agent harnesses pick one surface and call it done — a terminal coder, an
SDK, or a chat bot. Purr-Fect runs the **same agent core** across every surface
you actually use, with two compounding loops baked in:

- **Durable memory** — the agent writes user preferences, environment quirks,
  and stable conventions to a markdown-backed memory store. Every future
  session sees them.
- **Runtime skills** — the agent can author its own reusable skills
  (markdown + YAML frontmatter) when a workflow is worth keeping. Skills live
  in a layered hub (bundled / managed / personal / project / workspace) and
  are loaded into the next turn automatically.

Translation: the longer you use it, the less you have to re-explain.

## Install

```bash
git clone https://github.com/Pieverse-Eng/purrfect-agent
cd purrfect-agent
npm install
npm run build
node dist/cli/index.js setup     # interactive first-run setup
```

Requires Node ≥ 20 and a C++ toolchain for `better-sqlite3` on platforms
without a prebuilt binary.

## 60-second quickstart

```bash
purrfect setup           # configure API key and model
purrfect doctor          # verify the install
purrfect "what's in this repo?"   # one-shot prompt
purrfect                 # interactive REPL
```

## The five surfaces

### 1. Terminal

```bash
purrfect                 # REPL
purrfect --plan          # REPL in read-only planning mode
purrfect "<prompt>"      # one-shot
purrfect sessions browse # pick a past session to resume
```

### 2. Editor (ACP)

ACP-compatible editors (Zed, and others) can launch Purr-Fect over stdin/stdout:

```bash
purrfect acp
```

JSON-RPC frames go to stdout; logs to stderr.

### 3. Chat apps (Gateway)

One gateway, five adapters. Drop in tokens via `gateway.yaml` or environment
variables and start it:

```bash
purrfect gateway start
purrfect gateway status
```

Supported adapters:

- **Slack** (Bolt-style events)
- **Discord** (discord.js)
- **Telegram** (grammy)
- **LINE** (@line/bot-sdk)
- **Webhook** (HMAC-signed delivery)

Multi-user gateways have a built-in ACL — pair specific external users to
internal identities:

```bash
purrfect pairing add slack U01234 alice
purrfect pairing list
```

### 4. HTTP API

```bash
purrfect serve --port 8080
# POST /chat, POST /chat/stream, GET /sessions
```

### 5. Background tasks & schedules

```bash
purrfect cron create "0 9 * * MON" "summarize last week's commits"
purrfect tasks list
```

## Self-learning, concretely

### Memory

The agent calls a `memory` tool to persist tagged entries to `MEMORY.md` /
`USER.md`. Entries are injected into the next session's prompt automatically.

```bash
purrfect memory list
purrfect memory add prefers-tabs "user prefers tabs over spaces in TS files"
purrfect memory remove prefers-tabs
```

Backends are pluggable (local markdown today, HTTP for shared/team memory).
All writes are scanned for prompt-injection patterns before they hit disk.

### Skills

A skill is a markdown file with YAML frontmatter (`name`, `description`,
`triggers`) and an instruction body. The agent can manage skills at runtime
via the `skill_manage` tool, and you can manage them from the CLI:

```bash
purrfect skills list
purrfect skills install <name>     # install from a tap
purrfect skills tap add <name> <url>
purrfect skills audit              # check installed-vs-source integrity
```

Skill precedence: workspace → project → personal → managed → bundled.

## Multi-identity profiles

One install can host several isolated agents — each with its own memory,
sessions, skills, and gateway channels:

```bash
purrfect profile create work
purrfect --profile work "draft the standup post"
purrfect profile list
```

## Architecture in 60 seconds

```
AgentLoop  ← the engine
  ├── Provider           (Anthropic native or OpenAI-compat HTTP)
  ├── ToolRegistry       (built-in + MCP + plugin tools)
  ├── PromptBuilder      (identity + context files + memory + skills)
  ├── SessionStore       (SQLite + FTS5)
  ├── ContextCompressor  (trajectory + structured summary)
  ├── PermissionModel    (allow/deny + dangerous-command guards)
  └── SkillRegistry      (layered markdown skills hub)
```

The core is a library (`./dist/core/index.js`). The CLI, ACP server, HTTP
server, and gateway are all thin consumers of the same engine.

## Configuration

Config lives at `~/.purrfect/config.json` (or `$PURRFECT_CONFIG_DIR`). Run
`purrfect setup` to generate it interactively, or hand-edit. Per-profile
configs live at `~/.purrfect/profiles/<name>/`.

Sensitive values can be referenced as env vars:

```json
{ "apiKey": { "env": "ANTHROPIC_API_KEY" } }
```

## Extensibility

- **MCP** — stdio MCP servers register tools alongside built-ins
  (`purrfect mcp add <name> --command <cmd>`).
- **Plugins** — manifest-first discovery; plugins register tools, hooks, and
  capabilities.
- **User hooks** — shell commands fired on `preToolUse` / `postToolUse` /
  `stop` (`purrfect hooks add ...`).

## Development

```bash
npm test            # vitest, ~1100 unit/integration tests (no network)
npm run smoke       # real-LLM wire-format checks (auto-skips without an API key)
npx tsc --noEmit    # type-check
npm run build       # tsc + chmod +x dist/cli/index.js
```

Tests mirror `src/` paths under `test/`. The default suite is hermetic — all
provider calls go through a queue-based fetch mock. The smoke suite under
`test/smoke/` hits a real LLM endpoint to validate the wire format and runs
only when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set (picks the cheapest
model on each provider; well under $0.01 per full run).

## License

MIT — see [LICENSE](LICENSE).
