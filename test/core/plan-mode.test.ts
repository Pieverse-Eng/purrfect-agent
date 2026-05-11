import { describe, it, expect } from "vitest";
import {
  PLAN_MODE_BLOCKED_TOOLS,
  PLAN_MODE_ALLOWED_TOOLS,
  PLAN_MODE_HIDDEN_WHEN_ACTIVE,
  PLAN_MODE_HIDDEN_WHEN_INACTIVE,
  planModeAllowedToolList,
  planModeBlockedToolList,
} from "../../src/core/plan-mode.js";

describe("PLAN_MODE_BLOCKED_TOOLS", () => {
  it("contains all mutating tools", () => {
    expect(PLAN_MODE_BLOCKED_TOOLS.has("shell_exec")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("file_write")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("file_edit")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("delegate")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("skill_manage")).toBe(true);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("checkpoint_create")).toBe(true);
  });

  it("does not contain read-only tools", () => {
    expect(PLAN_MODE_BLOCKED_TOOLS.has("file_read")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("web_fetch")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("memory")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("session_search")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("todo_write")).toBe(false);
  });

  it("does not contain plan mode tools themselves", () => {
    expect(PLAN_MODE_BLOCKED_TOOLS.has("enter_plan_mode")).toBe(false);
    expect(PLAN_MODE_BLOCKED_TOOLS.has("exit_plan_mode")).toBe(false);
  });
});

describe("PLAN_MODE_ALLOWED_TOOLS", () => {
  it("lists exactly the read-only tool names", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS).toEqual([
      "file_read",
      "web_fetch",
      "memory",
      "session_search",
      "todo_write",
    ]);
  });

  it("never overlaps with PLAN_MODE_BLOCKED_TOOLS", () => {
    for (const name of PLAN_MODE_ALLOWED_TOOLS) {
      expect(PLAN_MODE_BLOCKED_TOOLS.has(name)).toBe(false);
    }
  });
});

describe("PLAN_MODE_HIDDEN_WHEN_ACTIVE", () => {
  it("includes every blocked tool plus enter_plan_mode", () => {
    for (const name of PLAN_MODE_BLOCKED_TOOLS) {
      expect(PLAN_MODE_HIDDEN_WHEN_ACTIVE.has(name)).toBe(true);
    }
    expect(PLAN_MODE_HIDDEN_WHEN_ACTIVE.has("enter_plan_mode")).toBe(true);
  });

  it("does not hide exit_plan_mode (still callable to exit)", () => {
    expect(PLAN_MODE_HIDDEN_WHEN_ACTIVE.has("exit_plan_mode")).toBe(false);
  });
});

describe("PLAN_MODE_HIDDEN_WHEN_INACTIVE", () => {
  it("hides exit_plan_mode only", () => {
    expect(PLAN_MODE_HIDDEN_WHEN_INACTIVE.has("exit_plan_mode")).toBe(true);
    expect(PLAN_MODE_HIDDEN_WHEN_INACTIVE.has("enter_plan_mode")).toBe(false);
    expect(PLAN_MODE_HIDDEN_WHEN_INACTIVE.has("shell_exec")).toBe(false);
  });
});

describe("plan-mode tool list formatters", () => {
  it("planModeAllowedToolList joins all allowed tools", () => {
    const list = planModeAllowedToolList();
    for (const name of PLAN_MODE_ALLOWED_TOOLS) {
      expect(list).toContain(name);
    }
  });

  it("planModeBlockedToolList joins all blocked tools", () => {
    const list = planModeBlockedToolList();
    for (const name of PLAN_MODE_BLOCKED_TOOLS) {
      expect(list).toContain(name);
    }
  });
});
