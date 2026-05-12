import { describe, it, expect } from "vitest";
import { CommandRegistry, type CommandDef } from "../../src/cli/commands/registry.js";
import { createCompleter, formatCompletionHint } from "../../src/cli/completer.js";

function makeDef(overrides: Partial<CommandDef>): CommandDef {
  return {
    name: "test",
    description: "A test command",
    category: "Info",
    aliases: [],
    handler: async () => {},
    ...overrides,
  };
}

function buildRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register(makeDef({ name: "help", description: "Show available commands", aliases: ["h"] }));
  reg.register(makeDef({ name: "history", description: "Show conversation history", aliases: [] }));
  reg.register(makeDef({ name: "model", description: "Show or change model", aliases: ["m"] }));
  reg.register(makeDef({ name: "quit", description: "Exit the CLI", aliases: ["q", "exit"] }));
  return reg;
}

describe("createCompleter", () => {
  const registry = buildRegistry();
  const completer = createCompleter(registry);

  it("/h → completes to [/h, /help, /history]", () => {
    const [matches, line] = completer("/h");
    expect(matches.sort()).toEqual(["/h", "/help", "/history"]);
    expect(line).toBe("/h");
  });

  it("/q → completes to [/quit, /q]", () => {
    const [matches, line] = completer("/q");
    // /q matches: /quit (name starts with q), /q (alias)
    expect(matches.sort()).toEqual(["/q", "/quit"]);
    expect(line).toBe("/q");
  });

  it("/exit → single match", () => {
    const [matches, line] = completer("/exit");
    expect(matches).toEqual(["/exit"]);
    expect(line).toBe("/exit");
  });

  it("/help m → completes help subcommand with command names", () => {
    const [matches, line] = completer("/help m");
    expect(matches).toContain("/help model");
    expect(line).toBe("/help m");
  });

  it("hello (no slash) → empty completions", () => {
    const [matches, line] = completer("hello");
    expect(matches).toEqual([]);
    expect(line).toBe("hello");
  });

  it("/ alone → all commands and aliases listed", () => {
    const [matches, line] = completer("/");
    // Should include all names and aliases
    expect(matches).toContain("/help");
    expect(matches).toContain("/history");
    expect(matches).toContain("/model");
    expect(matches).toContain("/quit");
    expect(matches).toContain("/q");
    expect(matches).toContain("/exit");
    expect(matches).toContain("/h");
    expect(matches).toContain("/m");
    expect(line).toBe("/");
  });
});

describe("formatCompletionHint", () => {
  it("renders command names with descriptions", () => {
    const registry = buildRegistry();
    const matches = ["/help", "/history"];
    const hint = formatCompletionHint(matches, registry);
    expect(hint).toContain("help");
    expect(hint).toContain("Show available commands");
    expect(hint).toContain("history");
    expect(hint).toContain("Show conversation history");
  });
});
