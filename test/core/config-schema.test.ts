import { describe, it, expect } from "vitest";
import { validateConfig, migrateConfig } from "../../src/core/config-schema.js";

describe("ConfigSchema: validateConfig", () => {
  it("happy path: valid config passes validation and returns typed object", () => {
    const raw = {
      apiKey: "sk-test-123",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      providerType: "openai" as const,
      fallbackModels: ["gpt-3.5-turbo"],
      configVersion: 2,
    };
    const result = validateConfig(raw);
    expect(result.apiKey).toBe("sk-test-123");
    expect(result.model).toBe("gpt-4o");
    expect(result.providerType).toBe("openai");
    expect(result.fallbackModels).toEqual(["gpt-3.5-turbo"]);
    expect(result.configVersion).toBe(2);
  });

  it("happy path: default config (empty object) is valid with all defaults filled", () => {
    const result = validateConfig({});
    expect(result.model).toBe("gpt-4o");
    expect(result.baseUrl).toBe("https://api.openai.com/v1");
    expect(result.providerType).toBe("openai");
    expect(result.fallbackModels).toEqual([]);
    expect(result.configVersion).toBe(2);
    expect(result.apiKey).toBeUndefined();
    expect(result.skillsDir).toBeUndefined();
    expect(result.memoriesDir).toBeUndefined();
    expect(result.sessionDbPath).toBeUndefined();
    expect(result.permissions).toBeUndefined();
  });

  it("edge case: missing apiKey passes validation (apiKey is optional)", () => {
    const raw = { model: "gpt-4o", configVersion: 2 };
    const result = validateConfig(raw);
    expect(result.apiKey).toBeUndefined();
    expect(result.model).toBe("gpt-4o");
  });

  it("edge case: invalid providerType 'gemini' produces error listing valid options", () => {
    const raw = { providerType: "gemini", configVersion: 2 };
    expect(() => validateConfig(raw)).toThrow();
    try {
      validateConfig(raw);
    } catch (e: any) {
      const msg = e.message;
      expect(msg).toContain("openai");
      expect(msg).toContain("anthropic");
    }
  });

  it("edge case: extra unknown fields are preserved (passthrough)", () => {
    const raw = {
      model: "gpt-4o",
      configVersion: 2,
      customPlugin: "my-plugin",
    };
    const result = validateConfig(raw) as any;
    expect(result.customPlugin).toBe("my-plugin");
  });

  it("error path: completely invalid input (not an object) produces descriptive error", () => {
    expect(() => validateConfig("not-an-object")).toThrow();
    expect(() => validateConfig(42)).toThrow();
    expect(() => validateConfig(null)).toThrow();
  });
});

describe("ConfigSchema: migrateConfig", () => {
  it("v1 config (no configVersion) auto-migrates with defaults and configVersion set to 2", () => {
    const v1 = {
      apiKey: "sk-old-key",
      model: "gpt-4",
      baseUrl: "https://api.openai.com/v1",
      skillsDir: "/home/user/.purrfect/skills",
    };
    const migrated = migrateConfig(v1);
    expect(migrated.configVersion).toBe(2);
    expect(migrated.apiKey).toBe("sk-old-key");
    expect(migrated.model).toBe("gpt-4");
    expect(migrated.providerType).toBe("openai");
    expect(migrated.fallbackModels).toEqual([]);
    expect(migrated.skillsDir).toBe("/home/user/.purrfect/skills");
  });
});
