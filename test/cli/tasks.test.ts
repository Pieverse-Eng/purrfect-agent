import { describe, it, expect } from "vitest";
import { formatTaskList, formatTaskOutput } from "../../src/cli/tasks.js";
import { parseArgs } from "../../src/cli/index.js";
import type { TaskRecord } from "../../src/core/tasks/store.js";

describe("formatTaskList: renders tasks with status", () => {
  it("renders tasks with id, status, and prompt", () => {
    const tasks: TaskRecord[] = [
      {
        id: "aaaa-1111",
        status: "running",
        prompt: "Build the frontend",
        createdAt: "2026-04-01T10:00:00.000Z",
      },
      {
        id: "bbbb-2222",
        status: "completed",
        prompt: "Fix the login bug",
        createdAt: "2026-04-01T11:00:00.000Z",
        completedAt: "2026-04-01T11:30:00.000Z",
      },
    ];

    const output = formatTaskList(tasks);

    expect(output).toContain("aaaa-1111");
    expect(output).toContain("running");
    expect(output).toContain("Build the frontend");
    expect(output).toContain("bbbb-2222");
    expect(output).toContain("completed");
    expect(output).toContain("Fix the login bug");
  });

  it("returns 'No tasks' message for empty list", () => {
    const output = formatTaskList([]);
    expect(output).toMatch(/no tasks/i);
  });
});

describe("formatTaskOutput: renders task output lines", () => {
  it("renders task output with header and lines", () => {
    const task: TaskRecord = {
      id: "cccc-3333",
      status: "completed",
      prompt: "Run tests",
      createdAt: "2026-04-01T12:00:00.000Z",
      completedAt: "2026-04-01T12:05:00.000Z",
    };
    const lines = ["line 1: starting tests", "line 2: all passed"];

    const output = formatTaskOutput(task, lines);

    expect(output).toContain("cccc-3333");
    expect(output).toContain("completed");
    expect(output).toContain("line 1: starting tests");
    expect(output).toContain("line 2: all passed");
  });

  it("renders output with no lines", () => {
    const task: TaskRecord = {
      id: "dddd-4444",
      status: "running",
      prompt: "Deploy",
      createdAt: "2026-04-01T13:00:00.000Z",
    };

    const output = formatTaskOutput(task, []);
    expect(output).toContain("dddd-4444");
    expect(output).toMatch(/no output/i);
  });
});

describe("parseArgs: tasks subcommand", () => {
  it("'tasks' returns {command: 'tasks'}", () => {
    const result = parseArgs(["node", "purrfect", "tasks"]);
    expect(result).toEqual({ command: "tasks", action: "list", rest: "" });
  });
});
