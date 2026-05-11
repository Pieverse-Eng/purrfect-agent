/**
 * E2E: agent authors its own skill at runtime, then sees it in the next turn.
 *
 * Marketing claim under test: "gets smarter over time by writing its own
 * skills." This proves that when the agent calls skill_manage(create) inside
 * one AgentLoop, a fresh registry started later (or a fresh prompt assembled
 * later) sees the new skill.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { AgentLoop } from "../../src/core/agent-loop.js";
import { HttpProvider } from "../../src/core/provider.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { SessionStore } from "../../src/core/session-store.js";
import { SkillRegistry } from "../../src/core/skills/registry.js";
import { createSkillManageTool } from "../../src/core/tools/skill-manage.js";
import { PromptBuilder } from "../../src/core/prompt-builder.js";
import {
  createMockFetch,
  makeTextResponse,
  makeToolCallResponse,
  makeToolCall,
} from "../helpers/mock-server.js";
import { createTempDir } from "../helpers/fixtures.js";

function makeProvider(fetchFn: typeof fetch): HttpProvider {
  return new HttpProvider(
    { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
    fetchFn,
  );
}

describe("Integration: self-authoring skills", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups) try { fn(); } catch { /* best effort */ }
    cleanups.length = 0;
  });

  it("agent calls skill_manage(create) → file on disk + registry has it + next prompt's skill index includes it", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const skillsDir = join(tmp.path, "skills");

    const skillRegistry = new SkillRegistry();
    const tool = createSkillManageTool({ skillRegistry, skillsDir });
    const registry = new ToolRegistry();
    registry.register(tool);

    const fetchFn = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "skill_manage",
            {
              action: "create",
              name: "summarize-pr",
              description: "Summarize a pull request from its diff and metadata",
              body: "1. Read the PR diff\n2. Identify key changes\n3. Produce a 3-bullet summary",
              triggers: ["summarize pr", "pr summary"],
            },
            "call_create",
          ),
        ]),
      },
      { body: makeTextResponse("Skill created.") },
    ]);

    const sessionStore = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => sessionStore.close());

    const loop = new AgentLoop({
      provider: makeProvider(fetchFn),
      toolRegistry: registry,
      sessionStore,
      sessionId: "s1",
    });
    sessionStore.createSession({ id: "s1", model: "test", source: "test", title: "t" } as any);

    for await (const _ of loop.run("learn how to summarize PRs")) void _;

    // File hit disk with expected frontmatter + body.
    const skillFile = join(skillsDir, "summarize-pr.md");
    expect(existsSync(skillFile)).toBe(true);
    const onDisk = readFileSync(skillFile, "utf-8");
    expect(onDisk).toContain("name: summarize-pr");
    expect(onDisk).toContain("Summarize a pull request");
    expect(onDisk).toContain("triggers:");
    expect(onDisk).toContain("Identify key changes");

    // Registry sees it without reload.
    expect(skillRegistry.getAllSkillNames()).toContain("summarize-pr");

    // A fresh registry loading the same dir picks it up — proves persistence.
    const freshRegistry = new SkillRegistry();
    freshRegistry.discover(skillsDir, { layer: "personal" });
    expect(freshRegistry.getAllSkillNames()).toContain("summarize-pr");

    // The new skill is dispatchable by trigger.
    expect(freshRegistry.dispatch("summarize pr")?.name).toBe("summarize-pr");

    // Next turn's system prompt shows the skill in its index.
    const skillIndex = freshRegistry.buildSkillIndex();
    expect(skillIndex).toContain("summarize-pr");
    const prompt = new PromptBuilder().build({
      skillIndex,
      hasSkillManageTool: true,
    });
    expect(prompt).toContain("# Available Skills");
    expect(prompt).toContain("summarize-pr");
    expect(prompt).toContain("# Skills Guidance");
  });

  it("agent patches an existing skill → updated body shows up in next dispatch", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const skillsDir = join(tmp.path, "skills");

    const skillRegistry = new SkillRegistry();
    // Pre-seed a skill the agent will patch.
    skillRegistry.create(skillsDir, "greeting", "Say hi", "Say hello to the user", {
      triggers: ["greet"],
    });

    const tool = createSkillManageTool({ skillRegistry, skillsDir });
    const registry = new ToolRegistry();
    registry.register(tool);

    const fetchFn = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall(
            "skill_manage",
            {
              action: "patch",
              name: "greeting",
              body: "Say hello warmly and ask how their day is going",
            },
            "call_patch",
          ),
        ]),
      },
      { body: makeTextResponse("Updated.") },
    ]);

    const sessionStore = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => sessionStore.close());

    const loop = new AgentLoop({
      provider: makeProvider(fetchFn),
      toolRegistry: registry,
      sessionStore,
      sessionId: "s1",
    });
    sessionStore.createSession({ id: "s1", model: "test", source: "test", title: "t" } as any);

    for await (const _ of loop.run("make greeting friendlier")) void _;

    // Fresh registry picks up the patched body from disk.
    const fresh = new SkillRegistry();
    fresh.discover(skillsDir, { layer: "personal" });
    const greeting = fresh.dispatch("greet");
    expect(greeting?.body).toContain("warmly");
    expect(greeting?.body).not.toBe("Say hello to the user");
  });

  it("agent removes a skill → not in next registry load", async () => {
    const tmp = createTempDir();
    cleanups.push(tmp.cleanup);
    const skillsDir = join(tmp.path, "skills");

    const skillRegistry = new SkillRegistry();
    skillRegistry.create(skillsDir, "obsolete", "old thing", "Do the old thing", {});
    skillRegistry.create(skillsDir, "keeper", "keep me", "Do the kept thing", {});

    const tool = createSkillManageTool({ skillRegistry, skillsDir });
    const registry = new ToolRegistry();
    registry.register(tool);

    const fetchFn = createMockFetch([
      {
        body: makeToolCallResponse([
          makeToolCall("skill_manage", { action: "remove", name: "obsolete" }, "call_rm"),
        ]),
      },
      { body: makeTextResponse("Removed.") },
    ]);

    const sessionStore = new SessionStore(join(tmp.path, "sessions.db"));
    cleanups.push(() => sessionStore.close());

    const loop = new AgentLoop({
      provider: makeProvider(fetchFn),
      toolRegistry: registry,
      sessionStore,
      sessionId: "s1",
    });
    sessionStore.createSession({ id: "s1", model: "test", source: "test", title: "t" } as any);

    for await (const _ of loop.run("drop the old skill")) void _;

    const fresh = new SkillRegistry();
    fresh.discover(skillsDir, { layer: "personal" });
    const names = fresh.getAllSkillNames();
    expect(names).not.toContain("obsolete");
    expect(names).toContain("keeper");
    expect(existsSync(join(skillsDir, "obsolete.md"))).toBe(false);
    expect(existsSync(join(skillsDir, "keeper.md"))).toBe(true);
  });
});
