import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { parseArgs } from "../../src/cli/index.js";
import { skillsCommand } from "../../src/cli/skills.js";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(): string {
  const tmp = createTempDir("skills-command-");
  cleanup = tmp.cleanup;
  return tmp.path;
}

function writeTapSkill(root: string, name: string): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${name} description
triggers:
  - ${name}
tools: []
context_files: []
---

Instructions for ${name}.
`,
    "utf-8",
  );
}

describe("parseArgs: skills subcommand", () => {
  it("parses skills rest args", () => {
    const parsed = parseArgs(["node", "purrfect", "skills", "install", "demo"]);
    expect(parsed).toEqual({ command: "skills", rest: "install demo" });
  });
});

describe("skillsCommand", () => {
  it("adds taps, installs, lists, snapshots, audits, and uninstalls skills", async () => {
    const root = setup();
    const tapDir = join(root, "tap");
    writeTapSkill(tapDir, "demo");
    const lines: string[] = [];
    const ctx = { configDir: root, output: (line: string) => lines.push(line) };

    await skillsCommand(`tap add local ${tapDir}`, ctx);
    await skillsCommand("browse", ctx);
    await skillsCommand("install demo", ctx);
    await skillsCommand("list", ctx);
    await skillsCommand("inspect demo", ctx);
    await skillsCommand("snapshot", ctx);
    await skillsCommand("audit", ctx);

    const installed = join(root, "skills", "managed", "demo", "SKILL.md");
    writeFileSync(installed, readFileSync(installed, "utf-8") + "\nTampered.\n", "utf-8");
    await skillsCommand("audit", ctx);
    await skillsCommand("uninstall demo", ctx);
    await skillsCommand("list", ctx);

    const output = lines.join("\n");
    expect(output).toContain("Tap added: local");
    expect(output).toContain("demo description");
    expect(output).toContain("Installed: demo");
    expect(output).toContain("Audit clean");
    expect(output).toContain("Changed: demo/SKILL.md");
    expect(lines.at(-1)).toContain("No skills installed.");
  });
});
