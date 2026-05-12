import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SkillRegistry } from "../../src/core/skills/registry.js";
import { CommandRegistry, type CommandContext } from "../../src/cli/commands/registry.js";
import { registerAllCommands } from "../../src/cli/commands/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let cleanup: (() => void) | undefined;

afterEach(() => {
  if (cleanup) cleanup();
  cleanup = undefined;
});

function makeTempSkillsDir(): string {
  const tmp = createTempDir("skills-runtime-test-");
  cleanup = tmp.cleanup;
  return tmp.path;
}

function writeSkillFile(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, "utf-8");
}

const makeSkill = (
  name: string,
  opts: { triggers?: string[]; description?: string } = {},
) =>
  `---
name: ${name}
description: ${opts.description ?? `${name} skill`}
triggers:
${(opts.triggers ?? [name]).map((t) => `  - ${t}`).join("\n")}
tools: []
context_files: []
---

Instructions for ${name}.
`;

function buildCommandContext(overrides: Partial<CommandContext> = {}): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    config: { apiKey: "test-key", model: "test-model", baseUrl: "http://localhost" },
    output: (text: string) => lines.push(text),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Skills runtime wiring", () => {
  it("SkillRegistry.discover finds .md skill files and indexes them", () => {
    const dir = makeTempSkillsDir();
    writeSkillFile(dir, "deploy.md", makeSkill("deploy", { triggers: ["deploy", "ship"] }));
    writeSkillFile(dir, "review.md", makeSkill("review", { triggers: ["review code"] }));

    const registry = new SkillRegistry();
    registry.discover(dir);

    const names = registry.getAllSkillNames();
    expect(names).toContain("deploy");
    expect(names).toContain("review");
    expect(names).toHaveLength(2);

    const allSkills = registry.getAllSkills();
    expect(allSkills).toHaveLength(2);
    expect(allSkills.find((s) => s.name === "deploy")?.triggers).toEqual(["deploy", "ship"]);
  });

  it("/skills command lists discovered skills with triggers", async () => {
    const dir = makeTempSkillsDir();
    writeSkillFile(dir, "deploy.md", makeSkill("deploy", { triggers: ["deploy", "ship"], description: "Deploy to prod" }));
    writeSkillFile(dir, "lint.md", makeSkill("lint", { triggers: ["lint"], description: "Run linter" }));

    const registry = new SkillRegistry();
    registry.discover(dir);

    const cmdRegistry = new CommandRegistry();
    registerAllCommands(cmdRegistry);

    const ctx = buildCommandContext({ skillRegistry: registry });
    const resolved = cmdRegistry.resolve("/skills");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("deploy");
    expect(output).toContain("ship");
    expect(output).toContain("Deploy to prod");
    expect(output).toContain("lint");
    expect(output).toContain("Run linter");
  });

  it("skill trigger match prepends skill body via dispatch", () => {
    const dir = makeTempSkillsDir();
    writeSkillFile(dir, "deploy.md", makeSkill("deploy", { triggers: ["deploy", "ship"] }));

    const registry = new SkillRegistry();
    registry.discover(dir);

    // Simulate what the REPL does: dispatch by trigger name
    const skill = registry.dispatch("deploy", "production --force");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("deploy");
    expect(skill!.body).toContain("Instructions for deploy.");
    expect(skill!.args).toBe("production --force");

    // buildSkillsMap provides the body for AgentLoop's skill dispatch
    const skillsMap = registry.buildSkillsMap();
    expect(skillsMap.get("deploy")).toContain("Instructions for deploy.");
    expect(skillsMap.get("ship")).toContain("Instructions for deploy.");
  });

  it("no skills dir results in empty registry and /skills says none", async () => {
    const registry = new SkillRegistry();
    // No discover call — simulates missing skillsDir

    expect(registry.getAllSkillNames()).toHaveLength(0);
    expect(registry.getAllSkills()).toHaveLength(0);
    expect(registry.buildSkillsMap().size).toBe(0);

    const cmdRegistry = new CommandRegistry();
    registerAllCommands(cmdRegistry);

    const ctx = buildCommandContext({ skillRegistry: registry });
    const resolved = cmdRegistry.resolve("/skills");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("No skills registered.");
  });
});
