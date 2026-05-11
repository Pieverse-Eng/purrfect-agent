import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";
import { newSessionCommand } from "../../src/cli/commands/session-commands.js";
import { infoCommand } from "../../src/cli/commands/info-commands.js";
import type { CommandContext } from "../../src/cli/commands/registry.js";

// ── parseArgs: new subcommands ──────────────────────────────────────────

describe("parseArgs: new CLI subcommands (#10)", () => {
  it("plugins -> { command: 'plugins' }", () => {
    const result = parseArgs(["node", "purrfect", "plugins"]);
    expect(result).toEqual({ command: "plugins" });
  });

  it("mcp -> { command: 'mcp' }", () => {
    const result = parseArgs(["node", "purrfect", "mcp"]);
    expect(result).toEqual({ command: "mcp" });
  });

  it("memory list -> { command: 'memory', action: 'list', rest: '' }", () => {
    const result = parseArgs(["node", "purrfect", "memory", "list"]);
    expect(result).toEqual({ command: "memory", action: "list", rest: "" });
  });
});

// ── REPL command handlers (#11) ─────────────────────────────────────────

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    config: { model: "gpt-4o-test" },
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    output: (text: string) => lines.push(text),
    lines,
    ...overrides,
  };
}

describe("/new command (#11)", () => {
  it("outputs 'New session started'", async () => {
    const ctx = makeContext();
    await newSessionCommand.handler("", ctx);
    const joined = ctx.lines.join("\n");
    expect(joined).toContain("New session started");
  });
});

describe("/info command (#11)", () => {
  it("outputs session ID and model", async () => {
    const ctx = makeContext();
    await infoCommand.handler("", ctx);
    const joined = ctx.lines.join("\n");
    expect(joined).toContain("Session: aaaaaaaa");
    expect(joined).toContain("Model: gpt-4o-test");
  });
});
