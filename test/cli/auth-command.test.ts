import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { authCommand } from "../../src/cli/auth.js";
import { parseArgs } from "../../src/cli/index.js";
import { createTempDir } from "../helpers/fixtures.js";

describe("authCommand", () => {
  it("adds, lists, rotates, resets, and removes credential pool keys", async () => {
    const tmp = createTempDir();
    const lines: string[] = [];
    const ctx = {
      configDir: tmp.path,
      output: (line: string) => lines.push(line),
    };

    try {
      await authCommand("add openai sk-one --label one", ctx);
      await authCommand("add openai sk-two --label two", ctx);
      await authCommand("list openai", ctx);
      await authCommand("rotate openai", ctx);
      await authCommand("reset openai", ctx);
      await authCommand("remove openai one", ctx);
      await authCommand("list openai", ctx);

      expect(lines.join("\n")).toContain("one");
      expect(lines.join("\n")).toContain("two");
      expect(lines.join("\n")).toContain("Current key: two");
      expect(lines.at(-1)).not.toContain("one");
      expect(join(tmp.path, "credentials.json")).toBeTruthy();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parseArgs: auth subcommand", () => {
  it("parses auth command arguments", () => {
    const result = parseArgs(["node", "purrfect", "auth", "list", "openai"]);
    expect(result).toEqual({ command: "auth", rest: "list openai" });
  });
});
