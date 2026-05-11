const USAGE = `purrfect — TypeScript agent runtime for terminal, editor, and chat apps.

USAGE
  purrfect                          Start interactive REPL
  purrfect "<prompt>"               Run a one-shot prompt
  purrfect <command> [...args]      Run a subcommand

GETTING STARTED
  setup                             Interactive first-run setup
  doctor                            Health check

CHAT & SESSIONS
  repl [--plan]                     Interactive REPL (--plan = read-only)
  sessions list|stats|rename|delete|prune|export|browse|checkpoint
  tasks list|run|show               Background tasks
  cron list|create|edit|pause|resume|remove|status
  insights [--session <id>] [--last <n>]

AGENT SURFACES
  acp                               Run as ACP stdio server (for editors)
  gateway start|status|stop         Slack / Discord / Telegram / LINE / Webhook
  serve [--port <n>]                HTTP API server
  webhook list|add|remove           HMAC-verified webhook subscriptions

LEARNING & EXTENSIONS
  memory list|add|remove|backend    Durable cross-session memory
  skills list|install|tap|browse|search|inspect|check|update|audit|uninstall
  tools list|enable|disable         Built-in / plugin / MCP tools
  plugins [enable|disable]          Plugin lifecycle
  mcp list|add|test|remove|configure
  hooks list|add|test               User-level pre/post-tool/stop hooks

IDENTITY & ACCESS
  profile list|create|use|remove    Multi-identity isolation
  pairing list|add|remove           Gateway multi-user ACL
  auth ...                          Provider credentials

GLOBAL FLAGS
  --profile <name>                  Switch profile (works with any command)
  --help, -h                        Show this help

Docs:    https://github.com/Pieverse-Eng/purrfect-agent
Issues:  https://github.com/Pieverse-Eng/purrfect-agent/issues
`;

export function printUsage(write: (text: string) => void = (t) => process.stdout.write(t)): void {
  write(USAGE);
}
