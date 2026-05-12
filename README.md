# 🐱 Purr-Fect Agent

**The TypeScript agent harness we use inside Pieverse — now open source.**

60 seconds from clone to an agent with:

- a wallet (provisioned via Purr-Fect Claws)
- **142 onchain skills** out of the box (Binance, OKX, PancakeSwap, OpenSea, BNB Chain, Mantle, Morph L2, Kaia, x402, Pieverse-A2A, and 130 more)
- surfaces for your terminal, your editor (ACP), and every chat app you live in (Slack, Discord, Telegram, LINE, webhooks)

MIT. TypeScript. ~1150 tests.

> Status: **alpha (v0.1)**. APIs and storage formats may change.

---

## Part of the Pieverse stack

Purr-Fect Agent is one open layer of three:

| Layer | What | Status |
|---|---|---|
| 🛰 **Pieverse AI Gateway** | OpenAI-compatible model routing for any LLM | Shipped |
| ☁️ **Purr-Fect Claws** | Cloud agent runtime — runs Hermes + OpenClaw today; Purr-Fect Agent next | Shipped |
| 🐱 **Purr-Fect Agent** (this repo) | The open-source agent harness | Alpha |

Each layer is optionality, not lock-in — pick your model, pick your harness,
pick your surface. Purr-Fect Agent talks to the Pieverse Gateway by default
but works against any OpenAI-compatible or Anthropic provider.

## Why

Most agent harnesses ship generic — you bring your own tools, your own
wallet, your own integrations. Purr-Fect ships **batteries-included for the
onchain stack**: one `purrfect setup` and you have an agent that knows the
exchanges, chains, and protocols you actually use.

- **Onchain skill commons** — 142 curated skills covering CEXs (Binance,
  OKX, Gate, Kraken, Bitget), DEXs (PancakeSwap, Aster, DFlow), L1/L2 chains
  (BNB, Mantle, Morph L2, Kaia), NFT marketplaces (OpenSea), intelligence
  (BlockBeats, PANews, RootData), and A2A payment protocols (x402,
  Pieverse-A2A). Maintained at
  [Pieverse-Eng/purrfect-skills](https://github.com/Pieverse-Eng/purrfect-skills).
- **Agent wallet** — `purrfect setup` (with Y default) registers an agent
  identity on Purr-Fect Claws and stores the wallet in `~/.purrfect/agent.env`.
  Required for onchain WRITE skills (signing, swaps, sends); read-only skills
  work without it.
- **Multi-surface** — same agent core runs in terminal, editor, and chat
  apps. Build once, deploy anywhere a user can reach it.
- **Self-learning** — memory + runtime skill authoring so the next session
  doesn't restart from scratch.

Translation: open it, run `setup`, and you have a working agent for the
onchain economy. Iterate from there.

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
purrfect setup           # config + install onchain skills + onboard agent wallet
purrfect doctor          # verify the install
purrfect "what's in this repo?"   # one-shot prompt
purrfect                 # interactive REPL
```

`setup` does three things in one flow:

1. Writes your LLM config (`~/.purrfect/config.json`).
2. Installs the Pieverse onchain skill commons (Binance, OKX, PancakeSwap,
   OpenSea, BNB Chain, x402, and ~25 more — see `purrfect skills` after).
3. Onboards an agent wallet via Purr-Fect Claws (`~/.purrfect/agent.env`).
   Y is the default — required for onchain WRITE skills (signing, swaps,
   sends). Decline if you only need read-only onchain skills, or skip and
   onboard later via `purrfect onboard`.

If any step fails because of no network, the others still complete. Re-run
the missing step manually:

```bash
purrfect skills install --all     # finish the skill install
purrfect onboard                  # finish the wallet onboard
```

By default, `setup` points at the Pieverse AI Gateway
(`https://ai.pieverse.io/v1`). Swap to any OpenAI-compatible endpoint or
native Anthropic by editing `~/.purrfect/config.json`.

## The five surfaces

One core, five front doors.

### 1. Terminal

```bash
purrfect                 # REPL
purrfect --plan          # REPL in read-only planning mode
purrfect "<prompt>"      # one-shot
purrfect sessions browse # pick a past session to resume
```

### 2. Editor (ACP)

ACP-compatible editors (Zed, and others) launch Purr-Fect over stdin/stdout:

```bash
purrfect acp
```

JSON-RPC frames go to stdout; logs to stderr.

### 3. Chat apps (Gateway)

One gateway, five adapters. Drop tokens into `gateway.yaml` or env vars and
start it:

```bash
purrfect gateway start
purrfect gateway status
```

Adapters:

- **Slack** (Bolt-style events)
- **Discord** (discord.js)
- **Telegram** (grammy)
- **LINE** (@line/bot-sdk)
- **Webhook** (HMAC-signed delivery)

Multi-user gateways ship with a built-in ACL — pair specific external users
to internal identities:

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
purrfect skills list                 # what's installed
purrfect skills install --all        # install every skill in every tap
purrfect skills install <name>       # install one
purrfect skills tap add <name> <url> # register a new skill source
purrfect skills audit                # check installed-vs-source integrity
```

The Pieverse onchain skill commons (`Pieverse-Eng/purrfect-skills`) is
registered as the default tap and installed automatically by `purrfect setup`.
Remove it with `purrfect skills tap remove pieverse` if you want a clean
slate.

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
npm test            # vitest, ~1130 unit/integration tests (no network)
npm run smoke       # real-LLM wire-format checks (auto-skips without an API key)
npx tsc --noEmit    # type-check
npm run build       # tsc + chmod +x dist/cli/index.js
```

Tests mirror `src/` paths under `test/`. The default suite is hermetic — all
provider calls go through a queue-based fetch mock. The smoke suite under
`test/smoke/` hits a real LLM endpoint to validate the wire format and runs
only when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set (picks the cheapest
model on each provider; well under $0.01 per full run).

## What's next

This is the harness layer. Purr-Fect Claws (managed cloud) and the Pieverse
AI Gateway sit beside it. Together they form what we believe an open A2A stack
should look like: any model, any harness, your choice. More open contributions
to follow as we go.

## License

MIT — see [LICENSE](LICENSE).
