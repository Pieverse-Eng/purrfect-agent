import { describe, it, expect, vi } from "vitest";
import {
  CommandRegistry,
  type CommandContext,
} from "../../src/cli/commands/registry.js";
import { registerAllCommands } from "../../src/cli/commands/index.js";

// ── Test helper ────────────────────────────────────────────────────────

function createMockContext(overrides: Partial<CommandContext> = {}): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    config: {
      apiKey: "sk-proj-abcdef1234567890WXYZ",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    },
    output: (text: string) => lines.push(text),
    toolRegistry: { getAllToolNames: () => ["read_file", "write_file", "bash"] },
    skillRegistry: {
      getAllSkillNames: () => ["commit", "review-pr"],
      getAllSkills: () => [
        { name: "commit", description: "Create a commit", triggers: ["commit"], tools: [], contextFiles: [], body: "" },
        { name: "review-pr", description: "Review a PR", triggers: ["review-pr"], tools: [], contextFiles: [], body: "" },
      ],
    },
    sessionId: "test-session-001",
    ...overrides,
  };
}

function buildRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  registerAllCommands(reg);
  return reg;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Command Handlers", () => {
  it("/help renders all categories", async () => {
    const reg = buildRegistry();
    const ctx = createMockContext();
    ctx.commandRegistry = reg;

    const resolved = reg.resolve("/help");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("", ctx);

    const output = ctx.lines.join("\n");
    // Should contain every category heading
    expect(output).toContain("Session");
    expect(output).toContain("Configuration");
    expect(output).toContain("Info");
    expect(output).toContain("Exit");
  });

  it("/help <cmd> shows detail for a specific command", async () => {
    const reg = buildRegistry();
    const ctx = createMockContext();
    ctx.commandRegistry = reg;

    const resolved = reg.resolve("/help model");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("model", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("model");
    expect(output).toContain("Configuration");
  });

  it("/tools lists tool names", async () => {
    const reg = buildRegistry();
    const ctx = createMockContext();
    ctx.commandRegistry = reg;

    const resolved = reg.resolve("/tools");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("read_file");
    expect(output).toContain("write_file");
    expect(output).toContain("bash");
  });

  it("/config redacts API key", async () => {
    const reg = buildRegistry();
    const ctx = createMockContext();
    ctx.commandRegistry = reg;

    const resolved = reg.resolve("/config");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("", ctx);

    const output = ctx.lines.join("\n");
    // Full key must NOT appear
    expect(output).not.toContain("sk-proj-abcdef1234567890WXYZ");
    // Redacted form must appear
    expect(output).toContain("sk-...WXYZ");
    // Model should still be visible
    expect(output).toContain("gpt-4o");
  });

  it("/model with no args shows current model", async () => {
    const reg = buildRegistry();
    const ctx = createMockContext();
    ctx.commandRegistry = reg;

    const resolved = reg.resolve("/model");
    expect(resolved).not.toBeNull();
    await resolved!.command.handler("", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("gpt-4o");
  });
});
