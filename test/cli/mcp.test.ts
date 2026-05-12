import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseMcpArgs } from "../../src/cli/mcp-args.js";
import {
  applyEnabledTools,
  mcpAdd,
  mcpConfigure,
  mcpList,
  mcpRemove,
  mcpTest,
  parseSelection,
} from "../../src/cli/mcp.js";

function tempConfigDir(seed?: { mcpServers?: any[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "purrfect-mcp-"));
  if (seed) {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ configVersion: 2, ...seed }, null, 2),
      "utf-8",
    );
  }
  return dir;
}

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
}

describe("parseMcpArgs", () => {
  it("returns list by default and on `list`", () => {
    expect(parseMcpArgs([])).toEqual({ kind: "list" });
    expect(parseMcpArgs(["list"])).toEqual({ kind: "list" });
  });

  it("parses `add` with command, args, env", () => {
    const action = parseMcpArgs([
      "add", "github", "--command", "npx",
      "--arg", "-y", "--arg", "@modelcontextprotocol/server-github",
      "--env", "GITHUB_TOKEN=abc",
    ]);
    expect(action).toEqual({
      kind: "add",
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "abc" },
    });
  });

  it("requires --command on add", () => {
    expect(() => parseMcpArgs(["add", "x"])).toThrow(/--command is required/);
  });

  it("parses `test`, `remove`, `configure` with their options", () => {
    expect(parseMcpArgs(["test", "x"])).toEqual({ kind: "test", name: "x" });
    expect(parseMcpArgs(["remove", "x"])).toEqual({ kind: "remove", name: "x" });
    expect(parseMcpArgs(["configure", "x", "--enable", "a,b"])).toEqual({
      kind: "configure",
      name: "x",
      enableTools: ["a", "b"],
      disable: false,
    });
    expect(parseMcpArgs(["configure", "x", "--disable"])).toEqual({
      kind: "configure",
      name: "x",
      enableTools: undefined,
      disable: true,
    });
  });

  it("rejects unknown subcommand", () => {
    expect(() => parseMcpArgs(["bogus"])).toThrow(/Unknown mcp subcommand/);
  });
});

describe("applyEnabledTools", () => {
  it("removes the enabledTools field when called with undefined", () => {
    const next = applyEnabledTools(
      { name: "n", command: "c", enabledTools: ["a"] },
      undefined,
    );
    expect(next).not.toHaveProperty("enabledTools");
    expect(next.name).toBe("n");
  });

  it("sets the enabledTools field when called with an array", () => {
    const next = applyEnabledTools({ name: "n", command: "c" }, ["a", "b"]);
    expect(next.enabledTools).toEqual(["a", "b"]);
  });
});

describe("parseSelection", () => {
  const tools = [
    { name: "alpha", description: "" },
    { name: "beta", description: "" },
    { name: "gamma", description: "" },
  ];

  it("accepts numbers and names, deduplicates", () => {
    expect(parseSelection("1, beta, 1", tools).sort()).toEqual(["alpha", "beta"]);
  });

  it("rejects unknown names", () => {
    expect(() => parseSelection("zeta", tools)).toThrow(/Unknown tool/);
  });
});

describe("mcpAdd / mcpRemove / mcpList", () => {
  it("add then list", () => {
    const dir = tempConfigDir();
    try {
      const lines: string[] = [];
      mcpAdd(
        { kind: "add", name: "github", command: "npx", args: ["-y", "x"] },
        { configDir: dir, output: (t) => lines.push(t) },
      );
      expect(readConfig(dir).mcpServers).toEqual([
        { name: "github", command: "npx", args: ["-y", "x"] },
      ]);

      lines.length = 0;
      mcpList({ configDir: dir, output: (t) => lines.push(t) });
      expect(lines.join("\n")).toContain("github");
      expect(lines.join("\n")).toContain("npx -y x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate add", () => {
    const dir = tempConfigDir({
      mcpServers: [{ name: "github", command: "npx" }],
    });
    try {
      expect(() =>
        mcpAdd(
          { kind: "add", name: "github", command: "npx" },
          { configDir: dir },
        ),
      ).toThrow(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remove drops the entry", () => {
    const dir = tempConfigDir({
      mcpServers: [
        { name: "a", command: "npx" },
        { name: "b", command: "npx" },
      ],
    });
    try {
      mcpRemove({ kind: "remove", name: "a" }, { configDir: dir, output: () => {} });
      expect(readConfig(dir).mcpServers.map((s: any) => s.name)).toEqual(["b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remove on missing server throws", () => {
    const dir = tempConfigDir();
    try {
      expect(() =>
        mcpRemove({ kind: "remove", name: "nope" }, { configDir: dir }),
      ).toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mcpTest", () => {
  it("reports success and tool count from the probe", async () => {
    const dir = tempConfigDir({
      mcpServers: [{ name: "fake", command: "noop" }],
    });
    try {
      const lines: string[] = [];
      const result = await mcpTest(
        { kind: "test", name: "fake" },
        {
          configDir: dir,
          output: (t) => lines.push(t),
          probe: async () => ({
            ok: true,
            elapsed_ms: 5,
            tools: [
              { name: "echo", description: "Echo input" },
              { name: "time", description: "" },
            ],
          }),
        },
      );
      expect(result.ok).toBe(true);
      expect(lines.join("\n")).toContain("Connected in 5ms — 2 tools");
      expect(lines.join("\n")).toContain("echo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports failure with error message", async () => {
    const dir = tempConfigDir({
      mcpServers: [{ name: "fake", command: "noop" }],
    });
    try {
      const lines: string[] = [];
      const result = await mcpTest(
        { kind: "test", name: "fake" },
        {
          configDir: dir,
          output: (t) => lines.push(t),
          probe: async () => ({ ok: false, elapsed_ms: 1, error: "boom" }),
        },
      );
      expect(result.ok).toBe(false);
      expect(lines.join("\n")).toContain("Failed in 1ms: boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mcpConfigure", () => {
  it("--enable writes the chosen tools", async () => {
    const dir = tempConfigDir({
      mcpServers: [{ name: "fake", command: "noop" }],
    });
    try {
      await mcpConfigure(
        { kind: "configure", name: "fake", enableTools: ["a", "b"] },
        { configDir: dir, output: () => {} },
      );
      expect(readConfig(dir).mcpServers[0].enabledTools).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--disable sets enabledTools to []", async () => {
    const dir = tempConfigDir({
      mcpServers: [{ name: "fake", command: "noop" }],
    });
    try {
      await mcpConfigure(
        { kind: "configure", name: "fake", disable: true },
        { configDir: dir, output: () => {} },
      );
      expect(readConfig(dir).mcpServers[0].enabledTools).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interactive: `all` clears any previous filter", async () => {
    const dir = tempConfigDir({
      mcpServers: [
        { name: "fake", command: "noop", enabledTools: ["a"] },
      ],
    });
    try {
      await mcpConfigure(
        { kind: "configure", name: "fake" },
        {
          configDir: dir,
          output: () => {},
          ask: async () => "all",
          probe: async () => ({
            ok: true,
            elapsed_ms: 1,
            tools: [{ name: "a", description: "" }, { name: "b", description: "" }],
          }),
        },
      );
      expect(readConfig(dir).mcpServers[0]).not.toHaveProperty("enabledTools");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interactive: numeric selection saves names", async () => {
    const dir = tempConfigDir({
      mcpServers: [{ name: "fake", command: "noop" }],
    });
    try {
      await mcpConfigure(
        { kind: "configure", name: "fake" },
        {
          configDir: dir,
          output: () => {},
          ask: async () => "1, 3",
          probe: async () => ({
            ok: true,
            elapsed_ms: 1,
            tools: [
              { name: "a", description: "" },
              { name: "b", description: "" },
              { name: "c", description: "" },
            ],
          }),
        },
      );
      expect(readConfig(dir).mcpServers[0].enabledTools.sort()).toEqual(["a", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
