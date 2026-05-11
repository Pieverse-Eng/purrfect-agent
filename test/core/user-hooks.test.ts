import { describe, it, expect } from "vitest";
import {
  matchesMatcher,
  renderTemplate,
  runUserHooks,
} from "../../src/core/user-hooks.js";
import type { UserHookConfig } from "../../src/core/config-schema.js";

describe("user hook matchers", () => {
  it("'*' matches anything", () => {
    expect(matchesMatcher("file_read", "*")).toBe(true);
    expect(matchesMatcher("anything", "")).toBe(true);
  });

  it("exact name match", () => {
    expect(matchesMatcher("file_read", "file_read")).toBe(true);
    expect(matchesMatcher("file_write", "file_read")).toBe(false);
  });

  it("glob with single wildcard", () => {
    expect(matchesMatcher("file_read", "file_*")).toBe(true);
    expect(matchesMatcher("file_write", "file_*")).toBe(true);
    expect(matchesMatcher("bash", "file_*")).toBe(false);
  });
});

describe("user hook template", () => {
  it("substitutes tool_name and args_json", () => {
    const result = renderTemplate("echo {{tool_name}} {{args_json}}", {
      toolName: "file_read",
      args: { path: "/etc/passwd" },
    });
    expect(result).toContain("'file_read'");
    expect(result).toContain('{"path":"/etc/passwd"}');
  });

  it("escapes single quotes inside substituted values", () => {
    const result = renderTemplate("echo {{args_json}}", {
      toolName: "x",
      args: { value: "it's nasty" },
    });
    // Single-quote in value must not break the wrapping single-quotes
    expect(result).toMatch(/'\{"value":"it'\\''s nasty"\}'/);
  });

  it("substitutes result_json (null for empty)", () => {
    const result = renderTemplate("echo {{result_json}}", {
      toolName: "x",
      args: {},
    });
    expect(result).toContain("'null'");
  });
});

describe("runUserHooks", () => {
  it("preToolUse hook with onFailure=block sets blocked=true on non-zero exit", async () => {
    const hook: UserHookConfig = {
      matcher: "*",
      command: "exit 7",
      onFailure: "block",
    };
    const outcomes = await runUserHooks(
      { preToolUse: [hook], postToolUse: [], stop: [] },
      "preToolUse",
      { toolName: "file_read", args: {} },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].blocked).toBe(true);
    expect(outcomes[0].exitCode).toBe(7);
  });

  it("non-matching hook is skipped", async () => {
    const hook: UserHookConfig = {
      matcher: "bash",
      command: "echo hi",
      onFailure: "warn",
    };
    const outcomes = await runUserHooks(
      { preToolUse: [hook], postToolUse: [], stop: [] },
      "preToolUse",
      { toolName: "file_read", args: {} },
    );
    expect(outcomes).toHaveLength(0);
  });

  it("warn-mode hook does not block but returns failure outcome", async () => {
    const hook: UserHookConfig = {
      matcher: "*",
      command: "exit 1",
      onFailure: "warn",
    };
    const outcomes = await runUserHooks(
      { preToolUse: [hook], postToolUse: [], stop: [] },
      "preToolUse",
      { toolName: "x", args: {} },
    );
    expect(outcomes[0].blocked).toBe(false);
    expect(outcomes[0].exitCode).toBe(1);
  });

  it("stop hook ignores matcher and runs unconditionally", async () => {
    const hook: UserHookConfig = {
      matcher: "anything",
      command: "echo stop-fired",
      onFailure: "log",
    };
    const outcomes = await runUserHooks(
      { preToolUse: [], postToolUse: [], stop: [hook] },
      "stop",
      { toolName: "", args: {} },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].stdout).toContain("stop-fired");
  });
});
