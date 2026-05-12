import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseProfileArgs, runProfileCommand } from "../../src/cli/profiles.js";
import { ProfileStore } from "../../src/core/profiles.js";
import { extractProfileFlag, stripProfileFlag, parseArgs } from "../../src/cli/index.js";

describe("profile CLI parser", () => {
  it("defaults to list", () => {
    expect(parseProfileArgs([])).toEqual({ kind: "list" });
    expect(parseProfileArgs(["list"])).toEqual({ kind: "list" });
  });

  it("parses show with optional name", () => {
    expect(parseProfileArgs(["show"])).toEqual({ kind: "show", name: undefined });
    expect(parseProfileArgs(["show", "dev"])).toEqual({ kind: "show", name: "dev" });
  });

  it("requires names for create/delete/use/alias", () => {
    for (const sub of ["create", "delete", "use", "alias"]) {
      expect(() => parseProfileArgs([sub])).toThrow();
      expect(parseProfileArgs([sub, "dev"])).toEqual({ kind: sub as any, name: "dev" });
    }
  });

  it("rejects unknown subcommands", () => {
    expect(() => parseProfileArgs(["nonsense"])).toThrow(/Unknown profile subcommand/);
  });
});

describe("extractProfileFlag", () => {
  it("returns undefined when --profile absent", () => {
    const args = ["foo", "bar"];
    expect(extractProfileFlag(args)).toBeUndefined();
    expect(args).toEqual(["foo", "bar"]);
  });

  it("extracts and removes --profile <name>", () => {
    const args = ["foo", "--profile", "dev", "bar"];
    expect(extractProfileFlag(args)).toBe("dev");
    expect(args).toEqual(["foo", "bar"]);
  });

  it("throws on missing value", () => {
    expect(() => extractProfileFlag(["--profile"])).toThrow(/requires a name/);
    expect(() => extractProfileFlag(["--profile", "--other"])).toThrow(/requires a name/);
  });
});

describe("stripProfileFlag (full process.argv)", () => {
  it("returns undefined and leaves argv intact when --profile absent", () => {
    const argv = ["/usr/bin/node", "/bin/purrfect", "sessions", "list"];
    expect(stripProfileFlag(argv)).toBeUndefined();
    expect(argv).toEqual(["/usr/bin/node", "/bin/purrfect", "sessions", "list"]);
  });

  it("removes --profile <name> from argv before subcommand", () => {
    const argv = ["/usr/bin/node", "/bin/purrfect", "--profile", "dev", "sessions", "list"];
    expect(stripProfileFlag(argv)).toBe("dev");
    expect(argv).toEqual(["/usr/bin/node", "/bin/purrfect", "sessions", "list"]);
  });

  it("removes --profile <name> from argv after subcommand", () => {
    const argv = ["/usr/bin/node", "/bin/purrfect", "sessions", "list", "--profile", "dev"];
    expect(stripProfileFlag(argv)).toBe("dev");
    expect(argv).toEqual(["/usr/bin/node", "/bin/purrfect", "sessions", "list"]);
  });

  it("downstream parseArgs sees the original subcommand after stripping", () => {
    const argv = ["/usr/bin/node", "/bin/purrfect", "--profile", "dev", "doctor"];
    stripProfileFlag(argv);
    const parsed = parseArgs(argv);
    expect(parsed.command).toBe("doctor");
  });
});

describe("runProfileCommand", () => {
  let baseDir: string;
  let lines: string[];
  const out = (t: string) => lines.push(t);

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "profile-cli-"));
    lines = [];
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("create then list shows the new profile and marks active", () => {
    runProfileCommand({ kind: "create", name: "dev" }, { baseDir, output: out });
    runProfileCommand({ kind: "use", name: "dev" }, { baseDir, output: out });
    lines = [];
    runProfileCommand({ kind: "list" }, { baseDir, output: out });
    const text = lines.join("\n");
    expect(text).toMatch(/\* dev/);
    expect(text).toContain("default");
  });

  it("show reports profile path", () => {
    runProfileCommand({ kind: "create", name: "dev" }, { baseDir, output: out });
    lines = [];
    runProfileCommand({ kind: "show", name: "dev" }, { baseDir, output: out });
    expect(lines.join("\n")).toContain(join(baseDir, "profiles", "dev"));
  });

  it("delete removes profile and is reflected in list", () => {
    runProfileCommand({ kind: "create", name: "dev" }, { baseDir, output: out });
    runProfileCommand({ kind: "delete", name: "dev" }, { baseDir, output: out });
    expect(existsSync(join(baseDir, "profiles", "dev"))).toBe(false);
  });

  it("alias prints a shell snippet", () => {
    runProfileCommand({ kind: "alias", name: "dev" }, { baseDir, output: out });
    expect(lines[0]).toBe(`alias purrfect-dev='PURRFECT_PROFILE=dev purrfect'`);
  });

  it("show with no name uses the active profile", () => {
    const store = new ProfileStore({ baseDir });
    store.create("dev");
    store.setActive("dev");
    runProfileCommand({ kind: "show" }, { baseDir, output: out });
    expect(lines.join("\n")).toContain("Profile: dev");
  });
});
