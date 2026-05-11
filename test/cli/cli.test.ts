import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { loadConfig, saveConfig, defaultConfig } from "../../src/cli/config.js";
import { parseArgs } from "../../src/cli/index.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { SessionStore } from "../../src/core/session-store.js";

// ── Config tests ────────────────────────────────────────────────────────

describe("Config: load/save round-trip", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = createTempDir();
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("happy path: write config, read it back, matches", () => {
    const config = {
      apiKey: "sk-test-123",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      skillsDir: "/home/user/skills",
    };
    saveConfig(config, tmpDir);
    const loaded = loadConfig(tmpDir);
    expect(loaded).toEqual(config);
  });

  it("happy path: returns defaults when config file missing", () => {
    const loaded = loadConfig(tmpDir);
    expect(loaded).toEqual(defaultConfig());
    expect(loaded.apiKey).toBe("");
    expect(loaded.model).toBe("gpt-4o");
    expect(loaded.baseUrl).toBe("https://api.openai.com/v1");
    expect(loaded.skillsDir).toBe("");
  });

  it("preserves SecretRef env object on round-trip", () => {
    const config = {
      apiKey: { env: "MY_API_KEY" } as any,
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      skillsDir: "",
    };
    saveConfig(config, tmpDir);
    const loaded = loadConfig(tmpDir);
    expect(loaded.apiKey).toEqual({ env: "MY_API_KEY" });
  });

  it("preserves SecretRef file object on round-trip", () => {
    const config = {
      apiKey: { file: "/run/secrets/api-key" } as any,
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      skillsDir: "",
    };
    saveConfig(config, tmpDir);
    const loaded = loadConfig(tmpDir);
    expect(loaded.apiKey).toEqual({ file: "/run/secrets/api-key" });
  });
});

// ── Doctor tests ────────────────────────────────────────────────────────

describe("Doctor: status checks", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = createTempDir();
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("happy path: reports all checks pass when config exists with API key", async () => {
    const config = {
      apiKey: "sk-test-123",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      skillsDir: "",
    };
    saveConfig(config, tmpDir);
    const results = await runDoctor(tmpDir);

    const configCheck = results.find((r) => r.name === "config_file");
    expect(configCheck?.status).toBe("ok");

    const apiKeyCheck = results.find((r) => r.name === "api_key");
    // Raw string API key resolves but doctor warns to use env/file ref
    expect(apiKeyCheck?.status).toBe("warn");
    expect(apiKeyCheck?.message).toContain("raw string");

    const sqliteCheck = results.find((r) => r.name === "sqlite");
    expect(sqliteCheck?.status).toBe("ok");
  });

  it("reports prompt cache hit rate when session usage exists", async () => {
    const config = {
      apiKey: "sk-test-123",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      skillsDir: "",
    };
    saveConfig(config, tmpDir);
    const store = new SessionStore(join(tmpDir, "sessions.db"));
    store.createSession({ id: "s1", model: "gpt-4o", source: "test" });
    store.recordTokenUsage("s1", {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    });
    store.close();

    const results = await runDoctor(tmpDir);

    const cacheCheck = results.find((r) => r.name === "prompt_cache");
    expect(cacheCheck?.status).toBe("ok");
    expect(cacheCheck?.message).toContain("80%");
  });

  it("edge case: reports missing API key when not configured", async () => {
    // Save config with empty API key
    saveConfig(defaultConfig(), tmpDir);
    const results = await runDoctor(tmpDir);

    const apiKeyCheck = results.find((r) => r.name === "api_key");
    expect(apiKeyCheck?.status).toBe("fail");
    expect(apiKeyCheck?.message).toMatch(/not set/i);
  });
});

// ── parseArgs tests ─────────────────────────────────────────────────────

describe("parseArgs: argument parsing", () => {
  it("happy path: no args returns {command: 'repl'}", () => {
    const result = parseArgs(["node", "purrfect"]);
    expect(result).toEqual({ command: "repl" });
  });

  it("happy path: string arg returns {command: 'oneshot', prompt: string}", () => {
    const result = parseArgs(["node", "purrfect", "explain this code"]);
    expect(result).toEqual({ command: "oneshot", prompt: "explain this code" });
  });

  it("happy path: 'setup' returns {command: 'setup'}", () => {
    const result = parseArgs(["node", "purrfect", "setup"]);
    expect(result).toEqual({ command: "setup" });
  });

  it("happy path: 'doctor' returns {command: 'doctor'}", () => {
    const result = parseArgs(["node", "purrfect", "doctor"]);
    expect(result).toEqual({ command: "doctor" });
  });

  it("happy path: 'sessions' returns {command: 'sessions', action: list}", () => {
    const result = parseArgs(["node", "purrfect", "sessions"]);
    expect(result).toEqual({ command: "sessions", action: { kind: "list" } });
  });

  it("happy path: 'sessions stats <id>' returns stats command", () => {
    const result = parseArgs(["node", "purrfect", "sessions", "stats", "sess-123"]);
    expect(result).toEqual({
      command: "sessions",
      action: { kind: "stats", sessionId: "sess-123" },
    });
  });

  it("happy path: multiple words joined as oneshot prompt", () => {
    const result = parseArgs(["node", "purrfect", "what", "is", "TypeScript"]);
    expect(result).toEqual({ command: "oneshot", prompt: "what is TypeScript" });
  });

  it("--help returns {command: 'help'}", () => {
    expect(parseArgs(["node", "purrfect", "--help"])).toEqual({ command: "help" });
  });

  it("-h returns {command: 'help'}", () => {
    expect(parseArgs(["node", "purrfect", "-h"])).toEqual({ command: "help" });
  });

  it("'help' returns {command: 'help'}", () => {
    expect(parseArgs(["node", "purrfect", "help"])).toEqual({ command: "help" });
  });
});
