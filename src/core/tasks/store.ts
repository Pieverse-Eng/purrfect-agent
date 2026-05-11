import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  prompt: string;
  createdAt: string;
  completedAt?: string;
}

export interface CreateTaskOptions {
  prompt: string;
}

/**
 * Persists background task metadata to a JSON file on disk.
 */
export class TaskStore {
  constructor(private readonly filePath: string) {}

  create(options: CreateTaskOptions): TaskRecord {
    const task: TaskRecord = {
      id: randomUUID(),
      status: "pending",
      prompt: options.prompt,
      createdAt: new Date().toISOString(),
    };
    const tasks = this.load();
    tasks.push(task);
    this.persist(tasks);
    return task;
  }

  get(id: string): TaskRecord | undefined {
    return this.load().find((t) => t.id === id);
  }

  update(id: string, patch: Partial<Pick<TaskRecord, "status" | "completedAt">>): TaskRecord {
    const tasks = this.load();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) {
      throw new Error(`Task not found: ${id}`);
    }
    tasks[idx] = { ...tasks[idx], ...patch };
    this.persist(tasks);
    return tasks[idx];
  }

  list(): TaskRecord[] {
    return this.load();
  }

  private load(): TaskRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as TaskRecord[];
  }

  private persist(tasks: TaskRecord[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), "utf-8");
  }
}
