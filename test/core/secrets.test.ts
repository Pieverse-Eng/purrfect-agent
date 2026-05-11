import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolveSecret, resolveApiKey, SecretRegistry } from "../../src/core/secrets.js";
import type { ProviderType } from "../../src/core/secrets.js";
import { createTempDir } from "../helpers/fixtures.js";

/** Save and clear all well-known API key env vars, restoring them in the returned cleanup function. */
function isolateEnvVars(): () => void {
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PURRFECT_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const [key, val] of Object.entries(saved)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  };
}

describe("resolveSecret", () => {
  it("resolves raw string directly", () => {
    expect(resolveSecret("sk-test-key")).toBe("sk-test-key");
  });

  it("resolves env var reference", () => {
    process.env.TEST_SECRET_KEY = "sk-from-env";
    try {
      expect(resolveSecret({ env: "TEST_SECRET_KEY" })).toBe("sk-from-env");
    } finally {
      delete process.env.TEST_SECRET_KEY;
    }
  });

  it("throws on missing env var", () => {
    delete process.env.NONEXISTENT_VAR;
    expect(() => resolveSecret({ env: "NONEXISTENT_VAR" }))
      .toThrowError("Secret env var 'NONEXISTENT_VAR' is not set");
  });

  it("resolves file reference", () => {
    const tmp = createTempDir("secret-file-test-");
    try {
      const secretPath = join(tmp.path, "api-key");
      writeFileSync(secretPath, "sk-from-file\n");

      expect(resolveSecret({ file: secretPath })).toBe("sk-from-file");
    } finally {
      tmp.cleanup();
    }
  });

  it("throws on missing file", () => {
    expect(() => resolveSecret({ file: "/nonexistent/path/secret" }))
      .toThrowError(/Secret file.*unreadable/);
  });
});

describe("resolveApiKey", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = isolateEnvVars();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("resolves from SecretRef when provided", () => {
    expect(resolveApiKey("sk-direct")).toBe("sk-direct");
  });

  it("falls back to ANTHROPIC_API_KEY env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    expect(resolveApiKey(undefined)).toBe("sk-anthropic");
  });

  it("falls back to OPENAI_API_KEY env var", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(resolveApiKey(undefined)).toBe("sk-openai");
  });

  it("returns undefined when nothing is available", () => {
    expect(resolveApiKey(undefined)).toBeUndefined();
  });

  // ── Provider-aware fallback ────────────────────────────────────────

  it("anthropic provider prefers ANTHROPIC_API_KEY over OPENAI_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(resolveApiKey(undefined, "anthropic")).toBe("sk-anthropic");
  });

  it("openai provider prefers OPENAI_API_KEY over ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(resolveApiKey(undefined, "openai")).toBe("sk-openai");
  });

  it("anthropic provider falls back to OPENAI_API_KEY when ANTHROPIC_API_KEY is absent", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(resolveApiKey(undefined, "anthropic")).toBe("sk-openai");
  });

  it("openai provider falls back to ANTHROPIC_API_KEY when OPENAI_API_KEY is absent", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    expect(resolveApiKey(undefined, "openai")).toBe("sk-anthropic");
  });

  it("explicit SecretRef takes precedence over provider fallback", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(resolveApiKey("sk-explicit", "openai")).toBe("sk-explicit");
  });
});

describe("SecretRegistry", () => {
  it("redacts tracked secrets from text", () => {
    const registry = new SecretRegistry();
    registry.track("sk-secret-key-12345");

    const text = "Error: API call failed with key sk-secret-key-12345";
    expect(registry.redact(text)).toBe("Error: API call failed with key [REDACTED]");
  });

  it("redacts multiple secrets", () => {
    const registry = new SecretRegistry();
    registry.track("secret1");
    registry.track("secret2");

    const text = "Keys: secret1 and secret2";
    expect(registry.redact(text)).toBe("Keys: [REDACTED] and [REDACTED]");
  });

  it("ignores short secrets (< 4 chars)", () => {
    const registry = new SecretRegistry();
    registry.track("sk");

    const text = "short sk value";
    expect(registry.redact(text)).toBe("short sk value");
  });

  it("handles text with no secrets", () => {
    const registry = new SecretRegistry();
    registry.track("sk-tracked");

    const text = "No secrets here";
    expect(registry.redact(text)).toBe("No secrets here");
  });

  it("tracks size correctly", () => {
    const registry = new SecretRegistry();
    expect(registry.size).toBe(0);
    registry.track("secret-value");
    expect(registry.size).toBe(1);
  });
});
