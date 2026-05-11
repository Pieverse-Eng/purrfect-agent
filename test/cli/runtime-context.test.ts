import { describe, it, expect } from "vitest";
import { buildAgentContext } from "../../src/cli/runtime.js";
import type { Config } from "../../src/core/config-schema.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    providerType: "openai",
    fallbackModels: [],
    permissionMode: "allow-all",
    configVersion: 2,
    ...overrides,
  };
}

describe("buildAgentContext", () => {
  it("with config only produces a valid prompt (backward compat)", () => {
    const prompt = buildAgentContext({ config: makeConfig() });

    // Should contain identity and model hints at minimum
    expect(prompt).toContain("You are running on gpt-4o.");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("with memorySnapshot includes a Memory section", () => {
    const prompt = buildAgentContext({
      config: makeConfig(),
      memorySnapshot: "User prefers dark mode.",
    });

    expect(prompt).toContain("Memory Snapshot");
    expect(prompt).toContain("User prefers dark mode.");
  });

  it("with skillIndex includes skills text", () => {
    const prompt = buildAgentContext({
      config: makeConfig(),
      skillIndex: "commit (/commit), review (/review)",
    });

    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("commit (/commit), review (/review)");
  });

  it("with platformHint includes platform text", () => {
    const prompt = buildAgentContext({
      config: makeConfig(),
      platformHint: "telegram dm",
    });

    expect(prompt).toContain("telegram dm");
  });

  it("with resumeRecap includes session continuity section", () => {
    const prompt = buildAgentContext({
      config: makeConfig(),
      resumeRecap: "Last session: discussed deployment pipeline.",
    });

    expect(prompt).toContain("Session Continuity");
    expect(prompt).toContain("Last session: discussed deployment pipeline.");
  });

  it("with all options includes every section", () => {
    const prompt = buildAgentContext({
      config: makeConfig({
        identity: { name: "TestBot", instructions: "Be brief." },
      }),
      memorySnapshot: "Remember: user is admin.",
      skillIndex: "deploy (/deploy)",
      platformHint: "slack channel",
      resumeRecap: "Previously discussed CI config.",
    });

    expect(prompt).toContain("You are TestBot.");
    expect(prompt).toContain("Be brief.");
    expect(prompt).toContain("Memory Snapshot");
    expect(prompt).toContain("Remember: user is admin.");
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("deploy (/deploy)");
    expect(prompt).toContain("slack channel");
    expect(prompt).toContain("Session Continuity");
    expect(prompt).toContain("Previously discussed CI config.");
  });
});
