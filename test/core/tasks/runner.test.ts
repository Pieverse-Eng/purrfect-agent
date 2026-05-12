import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createTempDir } from "../../helpers/fixtures.js";
import { TaskStore } from "../../../src/core/tasks/store.js";
import { TaskRunner } from "../../../src/core/tasks/runner.js";
import type { TaskRecord } from "../../../src/core/tasks/store.js";

let tmpDir: { path: string; cleanup: () => void };
let storePath: string;
let outputDir: string;

beforeEach(() => {
  tmpDir = createTempDir("task-runner-test-");
  storePath = join(tmpDir.path, "tasks.json");
  outputDir = join(tmpDir.path, "task-output");
});

afterEach(() => {
  tmpDir.cleanup();
});

describe("TaskStore", () => {
  it("creates a task persisted with pending status", () => {
    const store = new TaskStore(storePath);
    const task = store.create({ prompt: "summarize the codebase" });

    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.prompt).toBe("summarize the codebase");
    expect(task.createdAt).toBeTruthy();
    expect(task.completedAt).toBeUndefined();

    // Survives reload
    const store2 = new TaskStore(storePath);
    const loaded = store2.get(task.id);
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("pending");
    expect(loaded!.prompt).toBe("summarize the codebase");
  });

  it("lists all tasks with current statuses", () => {
    const store = new TaskStore(storePath);
    store.create({ prompt: "task A" });
    store.create({ prompt: "task B" });
    store.create({ prompt: "task C" });

    const all = store.list();
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.prompt).sort()).toEqual([
      "task A",
      "task B",
      "task C",
    ]);
    expect(all.every((t) => t.status === "pending")).toBe(true);
  });
});

describe("TaskRunner", () => {
  it("spawns a task and transitions status to running", () => {
    const store = new TaskStore(storePath);
    const spawned: string[] = [];

    const mockSpawn = (taskId: string, prompt: string, outDir: string) => {
      spawned.push(taskId);
      // simulate: return a mock handle
      return { pid: 12345 };
    };

    const runner = new TaskRunner(store, outputDir, mockSpawn);
    const task = runner.create("do something");
    expect(task.status).toBe("pending");

    runner.spawn(task.id);

    const updated = store.get(task.id);
    expect(updated!.status).toBe("running");
    expect(spawned).toEqual([task.id]);
  });

  it("completes a task with completed status and completedAt", () => {
    const store = new TaskStore(storePath);
    const runner = new TaskRunner(store, outputDir, () => ({ pid: 1 }));

    const task = runner.create("build feature");
    runner.spawn(task.id);
    runner.complete(task.id);

    const updated = store.get(task.id);
    expect(updated!.status).toBe("completed");
    expect(updated!.completedAt).toBeTruthy();
  });

  it("fails a task with failed status", () => {
    const store = new TaskStore(storePath);
    const runner = new TaskRunner(store, outputDir, () => ({ pid: 1 }));

    const task = runner.create("risky operation");
    runner.spawn(task.id);
    runner.fail(task.id);

    const updated = store.get(task.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.completedAt).toBeTruthy();
  });

  it("cancels a task by setting status to failed", () => {
    const store = new TaskStore(storePath);
    const runner = new TaskRunner(store, outputDir, () => ({ pid: 1 }));

    const task = runner.create("long running job");
    runner.spawn(task.id);
    runner.cancel(task.id);

    const updated = store.get(task.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.completedAt).toBeTruthy();
  });

  it("creates a task output directory for each task", () => {
    const store = new TaskStore(storePath);

    let capturedOutDir = "";
    const mockSpawn = (_id: string, _prompt: string, outDir: string) => {
      capturedOutDir = outDir;
      return { pid: 99 };
    };

    const runner = new TaskRunner(store, outputDir, mockSpawn);
    const task = runner.create("generate report");
    runner.spawn(task.id);

    // The output dir should be <outputDir>/<taskId>
    expect(capturedOutDir).toBe(join(outputDir, task.id));
    expect(existsSync(capturedOutDir)).toBe(true);
  });
});
