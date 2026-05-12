import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { SkillRegistry } from "../../../src/core/skills/registry.js";

describe("SkillRegistry", () => {
  let cleanup: () => void;
  let tmpDir: string;

  function setup() {
    const tmp = createTempDir("skill-registry-test-");
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
    return tmpDir;
  }

  afterEach(() => {
    if (cleanup) cleanup();
  });

  function writeSkillFile(dir: string, name: string, content: string): string {
    const filePath = join(dir, name);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
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

  it("discovers skills from directory and indexes by name", () => {
    setup();
    writeSkillFile(tmpDir, "alpha.md", makeSkill("alpha"));
    writeSkillFile(tmpDir, "beta.md", makeSkill("beta"));

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    expect(registry.dispatch("alpha")).not.toBeNull();
    expect(registry.dispatch("beta")).not.toBeNull();
    expect(registry.dispatch("alpha")!.name).toBe("alpha");
    expect(registry.dispatch("beta")!.name).toBe("beta");
  });

  it("dispatches by exact name", () => {
    setup();
    writeSkillFile(tmpDir, "deploy.md", makeSkill("deploy"));

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    const skill = registry.dispatch("deploy");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("deploy");
  });

  it("dispatches by trigger pattern match", () => {
    setup();
    writeSkillFile(
      tmpDir,
      "review.md",
      makeSkill("review-code", { triggers: ["review code", "code review"] }),
    );

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    const skill = registry.dispatch("review code");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("review-code");

    const skill2 = registry.dispatch("code review");
    expect(skill2).not.toBeNull();
    expect(skill2!.name).toBe("review-code");
  });

  it("returns null for unknown name", () => {
    setup();
    writeSkillFile(tmpDir, "alpha.md", makeSkill("alpha"));

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    expect(registry.dispatch("nonexistent")).toBeNull();
  });

  it("stores args on dispatched skill definition", () => {
    setup();
    writeSkillFile(tmpDir, "deploy.md", makeSkill("deploy"));

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    const skill = registry.dispatch("deploy", "production --force");
    expect(skill).not.toBeNull();
    expect(skill!.args).toBe("production --force");
  });

  it("handles empty skills directory without crashing", () => {
    setup();

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    expect(registry.dispatch("anything")).toBeNull();
  });

  it("last-wins for duplicate skill names", () => {
    setup();
    writeSkillFile(
      tmpDir,
      "v1.md",
      makeSkill("deploy", { description: "Deploy v1" }),
    );
    writeSkillFile(
      tmpDir,
      "v2.md",
      makeSkill("deploy", { description: "Deploy v2" }),
    );

    const registry = new SkillRegistry();
    registry.discover(tmpDir);

    const skill = registry.dispatch("deploy");
    expect(skill).not.toBeNull();
    // Last file alphabetically (v2.md) should win
    expect(skill!.description).toBe("Deploy v2");
  });

  it("loads from external directory with local taking precedence", () => {
    setup();
    const localDir = join(tmpDir, "local");
    const externalDir = join(tmpDir, "external");
    mkdirSync(localDir);
    mkdirSync(externalDir);

    writeSkillFile(
      externalDir,
      "shared.md",
      makeSkill("shared", { description: "External shared" }),
    );
    writeSkillFile(
      externalDir,
      "ext-only.md",
      makeSkill("ext-only", { description: "External only" }),
    );
    writeSkillFile(
      localDir,
      "shared.md",
      makeSkill("shared", { description: "Local shared" }),
    );

    const registry = new SkillRegistry();
    // External loaded first, then local overwrites
    registry.discover(externalDir);
    registry.discover(localDir);

    const shared = registry.dispatch("shared");
    expect(shared).not.toBeNull();
    expect(shared!.description).toBe("Local shared");

    const extOnly = registry.dispatch("ext-only");
    expect(extOnly).not.toBeNull();
    expect(extOnly!.description).toBe("External only");
  });
});

describe("serializeSkill YAML safety", () => {
  let cleanup: () => void;
  let tmpDir: string;

  function setup() {
    const tmp = createTempDir("skill-serialize-test-");
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
    return tmpDir;
  }

  afterEach(() => {
    if (cleanup) cleanup();
  });

  it("round-trips a description containing newlines", () => {
    setup();
    const skillsDir = join(tmpDir, "skills");
    const registry = new SkillRegistry();
    const desc = "Line one\nLine two\nLine three";

    registry.create(skillsDir, "multiline", desc, "body text");

    // Re-discover from disk and verify it reloads identically
    const registry2 = new SkillRegistry();
    registry2.discover(skillsDir);
    const reloaded = registry2.dispatch("multiline");

    expect(reloaded).not.toBeNull();
    expect(reloaded!.description).toBe(desc);
  });

  it("round-trips a description containing YAML frontmatter delimiter (---)", () => {
    setup();
    const skillsDir = join(tmpDir, "skills");
    const registry = new SkillRegistry();
    const desc = "before --- after";

    registry.create(skillsDir, "dashes", desc, "body text");

    const registry2 = new SkillRegistry();
    registry2.discover(skillsDir);
    const reloaded = registry2.dispatch("dashes");

    expect(reloaded).not.toBeNull();
    expect(reloaded!.description).toBe(desc);
  });

  it("round-trips triggers containing special YAML characters", () => {
    setup();
    const skillsDir = join(tmpDir, "skills");
    const registry = new SkillRegistry();
    const triggers = ["---", "key: value", "has # comment", "line\nbreak"];

    registry.create(skillsDir, "special-triggers", "desc", "body", { triggers });

    const registry2 = new SkillRegistry();
    registry2.discover(skillsDir);
    const reloaded = registry2.dispatch("special-triggers");

    expect(reloaded).not.toBeNull();
    expect(reloaded!.triggers).toEqual(triggers);
  });

  it("round-trips a description with colons and hash characters", () => {
    setup();
    const skillsDir = join(tmpDir, "skills");
    const registry = new SkillRegistry();
    const desc = "key: value # not a comment";

    registry.create(skillsDir, "colons", desc, "body text");

    const registry2 = new SkillRegistry();
    registry2.discover(skillsDir);
    const reloaded = registry2.dispatch("colons");

    expect(reloaded).not.toBeNull();
    expect(reloaded!.description).toBe(desc);
  });

  it("produces valid frontmatter that does not inject extra metadata fields", () => {
    setup();
    const skillsDir = join(tmpDir, "skills");
    const registry = new SkillRegistry();
    const desc = "innocent\nevil_field: injected";

    registry.create(skillsDir, "injection", desc, "body");

    const content = readFileSync(join(skillsDir, "injection.md"), "utf-8");
    // The file must have exactly two --- delimiters (opening and closing)
    const delimiterCount = content.split("\n").filter((l) => l.trim() === "---").length;
    expect(delimiterCount).toBe(2);

    const registry2 = new SkillRegistry();
    registry2.discover(skillsDir);
    const reloaded = registry2.dispatch("injection");

    expect(reloaded).not.toBeNull();
    expect(reloaded!.description).toBe(desc);
    // evil_field must NOT appear as a top-level YAML key
    expect((reloaded as Record<string, unknown>)["evil_field"]).toBeUndefined();
  });
});
