import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createTempDir } from "../../helpers/fixtures.js";
import { TaskStore } from "../../../src/core/tasks/store.js";
import { TaskRunner } from "../../../src/core/tasks/runner.js";

let tmpDir: { path: string; cleanup: () => void };
let storePath: string;
let outputDir: string;

beforeEach(() => {
  tmpDir = createTempDir("worker-test-");
  storePath = join(tmpDir.path, "tasks.json");
  outputDir = join(tmpDir.path, "task-output");
});

afterEach(() => {
  tmpDir.cleanup();
});

describe("TaskRunner with mock spawnFn", () => {
  it("calls spawnFn with correct taskId, prompt, and outputDir", () => {
    const store = new TaskStore(storePath);
    const calls: Array<{ taskId: string; prompt: string; outputDir: string }> = [];

    const mockSpawn = (taskId: string, prompt: string, outDir: string) => {
      calls.push({ taskId, prompt, outputDir: outDir });
      return { pid: 42 };
    };

    const runner = new TaskRunner(store, outputDir, mockSpawn);
    const task = runner.create("analyze the logs");
    runner.spawn(task.id);

    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe(task.id);
    expect(calls[0].prompt).toBe("analyze the logs");
    expect(calls[0].outputDir).toBe(join(outputDir, task.id));
  });
});

describe("Task status transitions", () => {
  it("transitions from pending to running to completed", () => {
    const store = new TaskStore(storePath);
    const runner = new TaskRunner(store, outputDir, () => ({ pid: 1 }));

    const task = runner.create("summarize code");
    expect(task.status).toBe("pending");

    runner.spawn(task.id);
    const running = store.get(task.id);
    expect(running!.status).toBe("running");

    runner.complete(task.id);
    const completed = store.get(task.id);
    expect(completed!.status).toBe("completed");
    expect(completed!.completedAt).toBeTruthy();
  });

  it("transitions from pending to running to failed", () => {
    const store = new TaskStore(storePath);
    const runner = new TaskRunner(store, outputDir, () => ({ pid: 1 }));

    const task = runner.create("risky task");
    expect(task.status).toBe("pending");

    runner.spawn(task.id);
    expect(store.get(task.id)!.status).toBe("running");

    runner.fail(task.id);
    const failed = store.get(task.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.completedAt).toBeTruthy();
  });
});

describe("Task output directory", () => {
  it("creates output directory for the task on spawn", () => {
    const store = new TaskStore(storePath);
    const runner = new TaskRunner(store, outputDir, () => ({ pid: 1 }));

    const task = runner.create("generate report");
    runner.spawn(task.id);

    const taskDir = join(outputDir, task.id);
    expect(existsSync(taskDir)).toBe(true);
  });
});
