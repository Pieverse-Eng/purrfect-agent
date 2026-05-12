import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";

describe("parseArgs: tools subcommands", () => {
  it("'tools' lists", () => {
    expect(parseArgs(["node", "purrfect", "tools"])).toEqual({
      command: "tools",
      action: { kind: "list" },
    });
  });

  it("'tools disable <name>'", () => {
    expect(parseArgs(["node", "purrfect", "tools", "disable", "shell_exec"])).toEqual({
      command: "tools",
      action: { kind: "disable", name: "shell_exec" },
    });
  });

  it("'tools enable <name>'", () => {
    expect(parseArgs(["node", "purrfect", "tools", "enable", "shell_exec"])).toEqual({
      command: "tools",
      action: { kind: "enable", name: "shell_exec" },
    });
  });
});

describe("parseArgs: plugins toggle", () => {
  it("'plugins disable <name>'", () => {
    expect(parseArgs(["node", "purrfect", "plugins", "disable", "myplug"])).toEqual({
      command: "plugins",
      action: { kind: "disable", name: "myplug" },
    });
  });

  it("'plugins' default", () => {
    expect(parseArgs(["node", "purrfect", "plugins"])).toEqual({
      command: "plugins",
    });
  });
});
