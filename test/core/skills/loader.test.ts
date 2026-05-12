import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { SkillLoader } from "../../../src/core/skills/loader.js";

describe("SkillLoader", () => {
  let cleanup: () => void;
  let tmpDir: string;

  function setup() {
    const tmp = createTempDir("skill-loader-test-");
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
    return tmpDir;
  }

  afterEach(() => {
    if (cleanup) cleanup();
  });

  function writeSkillFile(name: string, content: string): string {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("loads a skill from markdown with correct name, description, triggers, and body", () => {
    setup();
    const filePath = writeSkillFile(
      "review.md",
      `---
name: review-code
description: Review code for quality
triggers:
  - review code
  - code review
tools:
  - file_read
  - shell_exec
context_files:
  - src/main.ts
---

Review the code in the specified files for quality issues.
`,
    );

    const skill = SkillLoader.load(filePath);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("review-code");
    expect(skill!.description).toBe("Review code for quality");
    expect(skill!.triggers).toEqual(["review code", "code review"]);
    expect(skill!.tools).toEqual(["file_read", "shell_exec"]);
    expect(skill!.contextFiles).toEqual(["src/main.ts"]);
  });

  it("preserves markdown body after frontmatter", () => {
    setup();
    const body = `# Instructions

Review the code carefully.

- Check for bugs
- Check for style
`;
    const filePath = writeSkillFile(
      "review2.md",
      `---
name: review
description: Review
triggers: []
tools: []
context_files: []
---

${body}`,
    );

    const skill = SkillLoader.load(filePath);
    expect(skill).not.toBeNull();
    // Body should be everything after the closing ---
    expect(skill!.body).toContain("# Instructions");
    expect(skill!.body).toContain("- Check for bugs");
  });

  it("returns null for malformed YAML frontmatter", () => {
    setup();
    const filePath = writeSkillFile(
      "bad.md",
      `---
name: [invalid yaml
  this: is: broken:
---

Body here.
`,
    );

    const skill = SkillLoader.load(filePath);
    expect(skill).toBeNull();
  });

  it("returns null with warning when required field (name) is missing", () => {
    setup();
    const filePath = writeSkillFile(
      "noname.md",
      `---
description: A skill without a name
triggers: []
tools: []
context_files: []
---

Some body.
`,
    );

    const skill = SkillLoader.load(filePath);
    expect(skill).toBeNull();
  });

  it("handles skill file with no body (frontmatter only)", () => {
    setup();
    const filePath = writeSkillFile(
      "empty-body.md",
      `---
name: empty-body
description: Skill with no body
triggers:
  - empty
tools: []
context_files: []
---
`,
    );

    const skill = SkillLoader.load(filePath);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("empty-body");
    expect(skill!.body).toBe("");
  });
});
