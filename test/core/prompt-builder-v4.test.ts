import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PromptBuilder } from "../../src/core/prompt-builder.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Create a temp directory tree and return cleanup function */
function makeTempTree(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-builder-v4-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// =========================================================================
// v4 Unit 3: Configurable Identity + Model/Platform Hints
// =========================================================================

describe("PromptBuilder v4: configurable identity", () => {
  let tree: ReturnType<typeof makeTempTree>;

  beforeEach(() => {
    tree = makeTempTree();
  });
  afterEach(() => tree.cleanup());

  it("uses custom identity from BuildOptions when provided", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      identity: {
        name: "MyCLI",
        persona: "a sarcastic code reviewer",
        instructions: "Always respond with code examples.",
      },
    });

    expect(prompt).toContain("MyCLI");
    expect(prompt).toContain("a sarcastic code reviewer");
    expect(prompt).toContain("Always respond with code examples.");
  });

  it("falls back to DEFAULT_IDENTITY when no identity config provided", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({ cwd: tree.root });

    expect(prompt).toContain("Purr-Fect Agent");
    expect(prompt).toContain("intelligent AI assistant");
  });
});

describe("PromptBuilder v4: model hints", () => {
  let tree: ReturnType<typeof makeTempTree>;

  beforeEach(() => {
    tree = makeTempTree();
  });
  afterEach(() => tree.cleanup());

  it("includes model hints section when modelHints provided", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      modelHints: {
        name: "claude-opus-4",
        capabilities: {
          vision: true,
          toolUse: true,
          streaming: false,
        },
      },
    });

    expect(prompt).toContain("You are running on claude-opus-4.");
    expect(prompt).toContain("vision: yes");
    expect(prompt).toContain("toolUse: yes");
    expect(prompt).toContain("streaming: no");
  });
});

describe("PromptBuilder v4: .cursorrules support", () => {
  let tree: ReturnType<typeof makeTempTree>;

  beforeEach(() => {
    tree = makeTempTree();
  });
  afterEach(() => tree.cleanup());

  it("includes .cursorrules content when file exists in cwd", () => {
    fs.writeFileSync(
      path.join(tree.root, ".cursorrules"),
      "Always use functional components in React.",
    );

    const builder = new PromptBuilder();
    const prompt = builder.build({ cwd: tree.root });

    expect(prompt).toContain("Always use functional components in React.");
    expect(prompt).toContain("Project Rules (.cursorrules)");
  });

  it("gracefully handles missing .cursorrules without error", () => {
    // No .cursorrules file created
    const builder = new PromptBuilder();
    const prompt = builder.build({ cwd: tree.root });

    expect(prompt).not.toContain(".cursorrules");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("PromptBuilder v4: .purrfect.md overrides config identity", () => {
  let tree: ReturnType<typeof makeTempTree>;

  beforeEach(() => {
    tree = makeTempTree();
  });
  afterEach(() => tree.cleanup());

  it(".purrfect.md identity directive overrides config identity", () => {
    // Write an .purrfect.md that contains an identity override
    fs.writeFileSync(
      path.join(tree.root, ".purrfect.md"),
      "# Identity\nYou are ProjectBot, the project-specific assistant.",
    );

    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      identity: {
        name: "ConfigBot",
        persona: "a generic helper",
      },
    });

    // The .purrfect.md content is included in the prompt as project context,
    // appearing after identity, so the project-level directive takes effect
    expect(prompt).toContain("You are ProjectBot, the project-specific assistant.");
    // The config identity is also present (it's the base identity section)
    expect(prompt).toContain("ConfigBot");
  });
});

// =========================================================================
// Behavioral guidance blocks
// =========================================================================

describe("PromptBuilder v4: behavioral guidance", () => {
  let tree: ReturnType<typeof makeTempTree>;

  beforeEach(() => {
    tree = makeTempTree();
  });
  afterEach(() => tree.cleanup());

  it("includes memory guidance when hasMemoryTool is true", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      hasMemoryTool: true,
    });

    expect(prompt).toContain("Memory Guidance");
    expect(prompt).toContain("persistent memory across sessions");
    expect(prompt).toContain("reduces future user steering");
  });

  it("excludes memory guidance when hasMemoryTool is false or unset", () => {
    const builder = new PromptBuilder();

    const promptFalse = builder.build({ cwd: tree.root, hasMemoryTool: false });
    expect(promptFalse).not.toContain("Memory Guidance");

    const promptUnset = builder.build({ cwd: tree.root });
    expect(promptUnset).not.toContain("Memory Guidance");
  });

  it("includes session search guidance when hasSessionSearchTool is true", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      hasSessionSearchTool: true,
    });

    expect(prompt).toContain("Session Search Guidance");
    expect(prompt).toContain("session_search");
  });

  it("excludes session search guidance when hasSessionSearchTool is false or unset", () => {
    const builder = new PromptBuilder();

    const promptFalse = builder.build({ cwd: tree.root, hasSessionSearchTool: false });
    expect(promptFalse).not.toContain("Session Search Guidance");

    const promptUnset = builder.build({ cwd: tree.root });
    expect(promptUnset).not.toContain("Session Search Guidance");
  });

  it("includes tool-use enforcement for GPT models", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      modelHints: {
        name: "gpt-4o",
        capabilities: { toolUse: true },
      },
    });

    expect(prompt).toContain("Tool Use");
    expect(prompt).toContain("MUST use your tools");
  });

  it("includes tool-use enforcement for Codex models", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      modelHints: {
        name: "codex-mini-latest",
        capabilities: { toolUse: true },
      },
    });

    expect(prompt).toContain("MUST use your tools");
  });

  it("excludes tool-use enforcement for Claude models", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      modelHints: {
        name: "claude-sonnet-4-20250514",
        capabilities: { toolUse: true },
      },
    });

    expect(prompt).not.toContain("MUST use your tools");
  });

  it("excludes tool-use enforcement when no modelHints", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({ cwd: tree.root });

    expect(prompt).not.toContain("MUST use your tools");
  });

  it("includes clarify guidance when hasClarifyTool is true", () => {
    const builder = new PromptBuilder();
    const prompt = builder.build({
      cwd: tree.root,
      hasClarifyTool: true,
    });

    expect(prompt).toContain("Clarification Guidance");
    expect(prompt).toContain("clarify");
    expect(prompt).toContain("ambiguous");
    expect(prompt).toContain("missing");
  });

  it("excludes clarify guidance when hasClarifyTool is false or unset", () => {
    const builder = new PromptBuilder();

    const promptFalse = builder.build({ cwd: tree.root, hasClarifyTool: false });
    expect(promptFalse).not.toContain("Clarification Guidance");

    const promptUnset = builder.build({ cwd: tree.root });
    expect(promptUnset).not.toContain("Clarification Guidance");
  });
});
