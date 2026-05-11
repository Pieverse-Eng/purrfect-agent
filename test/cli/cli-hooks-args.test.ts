import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";

describe("parseArgs: hooks subcommands", () => {
  it("'hooks' defaults to list", () => {
    expect(parseArgs(["node", "purrfect", "hooks"])).toEqual({
      command: "hooks",
      action: { kind: "list" },
    });
  });

  it("'hooks list' explicit", () => {
    expect(parseArgs(["node", "purrfect", "hooks", "list"])).toEqual({
      command: "hooks",
      action: { kind: "list" },
    });
  });

  it("'hooks test <toolName>'", () => {
    expect(parseArgs(["node", "purrfect", "hooks", "test", "file_write"])).toEqual({
      command: "hooks",
      action: { kind: "test", toolName: "file_write" },
    });
  });

  it("'hooks add <phase> <matcher> <command...>'", () => {
    expect(
      parseArgs([
        "node",
        "purrfect",
        "hooks",
        "add",
        "postToolUse",
        "file_*",
        "echo",
        "done",
      ]),
    ).toEqual({
      command: "hooks",
      action: {
        kind: "add",
        phase: "postToolUse",
        matcher: "file_*",
        cmd: "echo done",
      },
    });
  });
});
