import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  /** When true, scheduler skips this job until resumed. */
  paused?: boolean;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Persists cron jobs to a JSON file on disk.
 */
export class CronStore {
  constructor(private readonly filePath: string) {}

  loadJobs(): CronJob[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as CronJob[];
  }

  getJob(id: string): CronJob | null {
    return this.loadJobs().find((j) => j.id === id) ?? null;
  }

  saveJob(job: CronJob): void {
    const jobs = this.loadJobs();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      jobs[idx] = job;
    } else {
      jobs.push(job);
    }
    this.persist(jobs);
  }

  deleteJob(id: string): void {
    const jobs = this.loadJobs().filter((j) => j.id !== id);
    this.persist(jobs);
  }

  listJobs(): CronJob[] {
    return this.loadJobs();
  }

  /** Set paused flag on an existing job. Returns the updated job, or null if not found. */
  setPaused(id: string, paused: boolean): CronJob | null {
    const jobs = this.loadJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    const next: CronJob = {
      ...jobs[idx],
      paused,
      updatedAt: new Date().toISOString(),
    };
    jobs[idx] = next;
    this.persist(jobs);
    return next;
  }

  /** Update mutable fields on an existing job. Returns the updated job, or null if not found. */
  updateJob(
    id: string,
    patch: Partial<Pick<CronJob, "cron" | "prompt" | "enabled" | "paused">>,
  ): CronJob | null {
    const jobs = this.loadJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    const next: CronJob = {
      ...jobs[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    jobs[idx] = next;
    this.persist(jobs);
    return next;
  }

  private persist(jobs: CronJob[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(jobs, null, 2), "utf-8");
  }
}
