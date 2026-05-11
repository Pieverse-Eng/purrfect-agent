import { describe, it, expect } from "vitest";
import {
  CommandRegistry,
  parseSlashCommand,
  type CommandDef,
  type CommandContext,
} from "../../src/cli/commands/registry.js";

function stubContext(): CommandContext {
  return { config: {}, output: () => {} };
}

function stubCommand(overrides: Partial<CommandDef> = {}): CommandDef {
  return {
    name: "test",
    description: "A test command",
    category: "Info",
    aliases: [],
    handler: async () => {},
    ...overrides,
  };
}

describe("CommandRegistry", () => {
  it("register + resolve by name", () => {
    const reg = new CommandRegistry();
    const cmd = stubCommand({ name: "help", description: "Show help" });
    reg.register(cmd);

    const result = reg.resolve("/help some args");
    expect(result).not.toBeNull();
    expect(result!.command).toBe(cmd);
    expect(result!.args).toBe("some args");
  });

  it("resolve by alias", () => {
    const reg = new CommandRegistry();
    const cmd = stubCommand({ name: "config", aliases: ["cfg", "c"] });
    reg.register(cmd);

    const result = reg.resolve("/cfg key=value");
    expect(result).not.toBeNull();
    expect(result!.command).toBe(cmd);
    expect(result!.args).toBe("key=value");
  });

  it("unknown command returns null", () => {
    const reg = new CommandRegistry();
    reg.register(stubCommand({ name: "help" }));

    expect(reg.resolve("/unknown")).toBeNull();
  });

  it("getByCategory groups correctly", () => {
    const reg = new CommandRegistry();
    reg.register(stubCommand({ name: "help", category: "Info" }));
    reg.register(stubCommand({ name: "config", category: "Configuration" }));
    reg.register(stubCommand({ name: "status", category: "Info" }));

    const grouped = reg.getByCategory();
    expect(grouped.get("Info")?.length).toBe(2);
    expect(grouped.get("Configuration")?.length).toBe(1);
    expect(grouped.has("Session")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  it("parses name + args", () => {
    const result = parseSlashCommand("/help search query");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("help");
    expect(result!.args).toBe("search query");
  });

  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });
});
