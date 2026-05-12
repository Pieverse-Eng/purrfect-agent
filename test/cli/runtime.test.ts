import { describe, it, expect } from "vitest";
import { createTempDir } from "../helpers/fixtures.js";
import { buildPermissionModel, buildSystemPrompt } from "../../src/cli/runtime.js";
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

describe("cli runtime helpers", () => {
  it("does not turn empty allowTools into an implicit deny-all in allow-all mode", () => {
    const permissions = buildPermissionModel(
      makeConfig({
        permissionMode: "allow-all",
        permissions: {
          allowTools: [],
          denyTools: [],
          denyPatterns: [],
        },
      }),
    );

    expect(permissions.check("shell_exec", { command: "echo hello" }).allowed).toBe(true);
  });

  it("uses allowTools when deny-by-default mode is enabled", () => {
    const permissions = buildPermissionModel(
      makeConfig({
        permissionMode: "deny-by-default",
        permissions: {
          allowTools: ["memory"],
          denyTools: [],
          denyPatterns: [],
        },
      }),
    );

    expect(permissions.check("memory", { action: "read" }).allowed).toBe(true);
    expect(permissions.check("shell_exec", { command: "echo hello" }).allowed).toBe(false);
  });

  it("builds a system prompt with identity and model hints", () => {
    const tmp = createTempDir();

    try {
      const prompt = buildSystemPrompt(
        makeConfig({
          identity: {
            name: "ProjectBot",
            instructions: "Stay concise.",
          },
        }),
        tmp.path,
      );

      expect(prompt).toContain("You are ProjectBot.");
      expect(prompt).toContain("Stay concise.");
      expect(prompt).toContain("You are running on gpt-4o.");
      expect(prompt).toContain("Node.js");
    } finally {
      tmp.cleanup();
    }
  });
});
