import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskStore } from "./store.js";
import type { TaskRecord } from "./store.js";
import type { WorkerResult } from "./worker.js";

export type SpawnFn = (taskId: string, prompt: string, outputDir: string) => { pid: number };

/**
 * Default spawnFn that forks the worker.ts script as a detached child process.
 * Sends task config via IPC and listens for completion/failure messages.
 */
function createDefaultSpawnFn(store: TaskStore, configDir: string): SpawnFn {
  return (taskId: string, prompt: string, _outputDir: string) => {
    const workerPath = join(
      fileURLToPath(import.meta.url),
      "..",
      "worker.js",
    );

    const child: ChildProcess = fork(workerPath, [], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    child.send({ prompt, configDir, taskId });

    child.on("message", (msg: WorkerResult) => {
      try {
        if (msg.status === "completed") {
          store.update(taskId, {
            status: "completed",
            completedAt: new Date().toISOString(),
          });
        } else if (msg.status === "failed") {
          store.update(taskId, {
            status: "failed",
            completedAt: new Date().toISOString(),
          });
        }
      } catch {
        // Store update may fail if process is shutting down — ignore
      }
    });

    child.on("error", () => {
      try {
        store.update(taskId, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
      } catch {
        // Best-effort
      }
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        try {
          const current = store.get(taskId);
          if (current && current.status === "running") {
            store.update(taskId, {
              status: "failed",
              completedAt: new Date().toISOString(),
            });
          }
        } catch {
          // Best-effort
        }
      }
      // Unref so parent can exit independently
      child.unref();
    });

    // Allow parent to exit while child continues
    child.unref();

    return { pid: child.pid ?? 0 };
  };
}

/**
 * Manages background task lifecycle: create, spawn, complete, fail, cancel.
 *
 * Accepts a `spawnFn` for testability — defaults to forking worker.ts
 * as a detached child process that runs a real agent loop.
 */
export class TaskRunner {
  private readonly spawnFn: SpawnFn;

  constructor(
    private readonly store: TaskStore,
    private readonly outputBaseDir: string,
    spawnFn?: SpawnFn,
    configDir?: string,
  ) {
    this.spawnFn = spawnFn ?? createDefaultSpawnFn(store, configDir ?? outputBaseDir);
  }

  /** Create a new task in pending state. */
  create(prompt: string): TaskRecord {
    return this.store.create({ prompt });
  }

  /** Spawn a pending task — transitions to running and invokes spawnFn. */
  spawn(taskId: string): void {
    const taskOutputDir = join(this.outputBaseDir, taskId);
    if (!existsSync(taskOutputDir)) {
      mkdirSync(taskOutputDir, { recursive: true });
    }

    this.store.update(taskId, { status: "running" });

    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.spawnFn(taskId, task.prompt, taskOutputDir);
  }

  /** Mark a running task as completed. */
  complete(taskId: string): TaskRecord {
    return this.store.update(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

  /** Mark a running task as failed. */
  fail(taskId: string): TaskRecord {
    return this.store.update(taskId, {
      status: "failed",
      completedAt: new Date().toISOString(),
    });
  }

  /** Cancel a running task (sets status to failed). */
  cancel(taskId: string): TaskRecord {
    return this.fail(taskId);
  }

  /** Get a task by id. */
  get(taskId: string): TaskRecord | undefined {
    return this.store.get(taskId);
  }

  /** List all tasks. */
  list(): TaskRecord[] {
    return this.store.list();
  }
}
