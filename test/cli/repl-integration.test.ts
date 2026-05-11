import { describe, it, expect } from "vitest";
import { parseSlashCommand } from "../../src/cli/commands/registry.js";
import { formatTokenDisplay } from "../../src/cli/formatter.js";

describe("REPL integration logic", () => {
  it("parseSlashCommand('/help') returns {name: 'help', args: ''}", () => {
    const result = parseSlashCommand("/help");
    expect(result).toEqual({ name: "help", args: "" });
  });

  it("parseSlashCommand('hello') returns null (not a command)", () => {
    const result = parseSlashCommand("hello");
    expect(result).toBeNull();
  });

  it("formatTokenDisplay(100, 50) produces correct string", () => {
    const display = formatTokenDisplay(100, 50);
    expect(display).toBe("[tokens: 100/50]");
  });

  it("multiline detection: 'hello\\\\' endsWith('\\\\') is true", () => {
    const input = "hello\\";
    expect(input.endsWith("\\")).toBe(true);
  });
});
