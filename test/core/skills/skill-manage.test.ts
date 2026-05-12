import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createTempDir } from "../../helpers/fixtures.js";
import { SkillRegistry } from "../../../src/core/skills/registry.js";
import { createSkillManageTool } from "../../../src/core/tools/skill-manage.js";

let tmpDir: { path: string; cleanup: () => void };
let skillsDir: string;
let registry: SkillRegistry;

beforeEach(() => {
  tmpDir = createTempDir("skill-manage-test-");
  skillsDir = join(tmpDir.path, "skills");
  registry = new SkillRegistry();
});

afterEach(() => {
  tmpDir.cleanup();
});

describe("SkillRegistry CRUD", () => {
  it("create writes skill file to disk", () => {
    const skill = registry.create(skillsDir, "test-skill", "A test skill", "Do the thing.");
    expect(skill.name).toBe("test-skill");
    expect(skill.description).toBe("A test skill");

    const filePath = join(skillsDir, "test-skill.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("name: test-skill");
    expect(content).toContain("description: A test skill");
    expect(content).toContain("Do the thing.");
  });

  it("create rejects name > 64 chars", () => {
    const longName = "a".repeat(65);
    expect(() => registry.create(skillsDir, longName, "desc", "body"))
      .toThrowError(/≤64 characters/);
  });

  it("create rejects description > 1024 chars", () => {
    const longDesc = "a".repeat(1025);
    expect(() => registry.create(skillsDir, "name", longDesc, "body"))
      .toThrowError(/≤1024 characters/);
  });

  it("create rejects duplicate name", () => {
    registry.create(skillsDir, "unique", "desc", "body");
    expect(() => registry.create(skillsDir, "unique", "desc", "body"))
      .toThrowError(/already exists/);
  });

  it("create rejects names with path traversal (../foo)", () => {
    expect(() => registry.create(skillsDir, "../foo", "desc", "body"))
      .toThrowError(/path separators/);
  });

  it("create rejects names with forward slash (subdir/bar)", () => {
    expect(() => registry.create(skillsDir, "subdir/bar", "desc", "body"))
      .toThrowError(/path separators/);
  });

  it("create rejects names with backslash (..\\foo)", () => {
    expect(() => registry.create(skillsDir, "..\\foo", "desc", "body"))
      .toThrowError(/path separators/);
  });

  it("create rejects bare '..' name", () => {
    expect(() => registry.create(skillsDir, "..", "desc", "body"))
      .toThrowError(/path separators/);
  });

  it("update rejects names with path traversal", () => {
    expect(() => registry.update(skillsDir, "../escape", { body: "new" }))
      .toThrowError(/path separators/);
  });

  it("remove rejects names with path traversal", () => {
    expect(() => registry.remove(skillsDir, "../escape"))
      .toThrowError(/path separators/);
  });

  it("create with triggers indexes by trigger", () => {
    registry.create(skillsDir, "deploy", "Deploy flow", "Deploy steps", {
      triggers: ["/deploy"],
    });
    const dispatched = registry.dispatch("/deploy");
    expect(dispatched).not.toBeNull();
    expect(dispatched!.name).toBe("deploy");
  });

  it("update modifies body and writes to disk", () => {
    registry.create(skillsDir, "my-skill", "Original desc", "Original body");
    const updated = registry.update(skillsDir, "my-skill", { body: "Updated body" });

    expect(updated.body).toBe("Updated body");
    expect(updated.description).toBe("Original desc");

    const content = readFileSync(join(skillsDir, "my-skill.md"), "utf-8");
    expect(content).toContain("Updated body");
  });

  it("update throws on nonexistent skill", () => {
    expect(() => registry.update(skillsDir, "nope", { body: "new" }))
      .toThrowError(/not found/);
  });

  it("remove deletes file and deregisters", () => {
    registry.create(skillsDir, "temp", "Temporary", "Temp body");
    expect(registry.getAllSkillNames()).toContain("temp");

    registry.remove(skillsDir, "temp");
    expect(registry.getAllSkillNames()).not.toContain("temp");
    expect(existsSync(join(skillsDir, "temp.md"))).toBe(false);
  });

  it("remove throws on nonexistent skill", () => {
    expect(() => registry.remove(skillsDir, "nope"))
      .toThrowError(/not found/);
  });

  it("buildSkillIndex returns formatted list", () => {
    registry.create(skillsDir, "alpha", "First skill", "body");
    registry.create(skillsDir, "beta", "Second skill", "body");

    const index = registry.buildSkillIndex();
    expect(index).toContain("alpha: First skill");
    expect(index).toContain("beta: Second skill");
  });
});

describe("skill_manage tool", () => {
  it("list returns all skills", async () => {
    registry.create(skillsDir, "test1", "Desc 1", "body");
    registry.create(skillsDir, "test2", "Desc 2", "body");

    const tool = createSkillManageTool({ skillRegistry: registry, skillsDir });
    const result = JSON.parse(await tool.handler({ action: "list" }));

    expect(result.skills).toHaveLength(2);
    expect(result.skills[0].name).toBe("test1");
    // Progressive disclosure: no body in list
    expect(result.skills[0].body).toBeUndefined();
  });

  it("view returns full skill content", async () => {
    registry.create(skillsDir, "my-skill", "Description", "Full body content");

    const tool = createSkillManageTool({ skillRegistry: registry, skillsDir });
    const result = JSON.parse(await tool.handler({ action: "view", name: "my-skill" }));

    expect(result.name).toBe("my-skill");
    expect(result.body).toBe("Full body content");
  });

  it("create returns success", async () => {
    const tool = createSkillManageTool({ skillRegistry: registry, skillsDir });
    const result = JSON.parse(
      await tool.handler({
        action: "create",
        name: "new-skill",
        description: "A new skill",
        body: "Skill instructions here",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.skill.name).toBe("new-skill");
    expect(registry.getAllSkillNames()).toContain("new-skill");
  });

  it("patch updates existing skill", async () => {
    registry.create(skillsDir, "existing", "Old desc", "Old body");

    const tool = createSkillManageTool({ skillRegistry: registry, skillsDir });
    const result = JSON.parse(
      await tool.handler({
        action: "patch",
        name: "existing",
        body: "New body",
      }),
    );

    expect(result.success).toBe(true);
    const skill = registry.dispatch("existing");
    expect(skill!.body).toBe("New body");
  });

  it("remove deletes skill", async () => {
    registry.create(skillsDir, "to-delete", "Desc", "Body");

    const tool = createSkillManageTool({ skillRegistry: registry, skillsDir });
    const result = JSON.parse(
      await tool.handler({ action: "remove", name: "to-delete" }),
    );

    expect(result.success).toBe(true);
    expect(registry.getAllSkillNames()).not.toContain("to-delete");
  });

  it("returns error for unknown action", async () => {
    const tool = createSkillManageTool({ skillRegistry: registry, skillsDir });
    const result = JSON.parse(await tool.handler({ action: "nope" }));
    expect(result.error).toContain("Unknown action");
  });
});
