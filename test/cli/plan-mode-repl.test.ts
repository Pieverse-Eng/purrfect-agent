import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";
import { buildAgentContext } from "../../src/cli/runtime.js";

describe("--plan CLI flag", () => {
  it("parses --plan as repl command with planMode true", () => {
    const result = parseArgs(["node", "purrfect", "--plan"]);
    expect(result.command).toBe("repl");
    if (result.command === "repl") {
      expect(result.planMode).toBe(true);
    }
  });

  it("parses bare invocation as repl without planMode", () => {
    const result = parseArgs(["node", "purrfect"]);
    expect(result.command).toBe("repl");
    if (result.command === "repl") {
      expect(result.planMode).toBeUndefined();
    }
  });

  it("does not confuse --plan with oneshot prompt", () => {
    // Only "--plan" alone triggers plan mode; "hello --plan" is oneshot
    const result = parseArgs(["node", "purrfect", "hello", "--plan"]);
    expect(result.command).toBe("oneshot");
  });
});

describe("plan mode system prompt hint", () => {
  const baseConfig = {
    model: "gpt-4o",
    identity: "test-agent",
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    providerType: "openai",
    permissionMode: "allow-all" as const,
  };

  it("includes plan mode guidance when planMode is true", () => {
    const prompt = buildAgentContext({ config: baseConfig, planMode: true });
    expect(prompt).toContain("Plan Mode Active");
    expect(prompt).toContain("exit_plan_mode");
    expect(prompt).toContain("read-only tools");
  });

  it("does not include plan mode guidance when planMode is false", () => {
    const prompt = buildAgentContext({ config: baseConfig, planMode: false });
    expect(prompt).not.toContain("Plan Mode Active");
  });

  it("does not include plan mode guidance when planMode is undefined", () => {
    const prompt = buildAgentContext({ config: baseConfig });
    expect(prompt).not.toContain("Plan Mode Active");
  });
});
