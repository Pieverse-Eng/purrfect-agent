import cron from "node-cron";
import { randomUUID } from "node:crypto";
import { CronStore } from "./store.js";
import type { CronJob } from "./store.js";

export type JobFireCallback = (job: CronJob) => void;

/**
 * Wraps node-cron to schedule persisted cron jobs.
 */
export class CronScheduler {
  private readonly store: CronStore;
  private readonly onJobFire: JobFireCallback;
  private readonly tasks = new Map<string, cron.ScheduledTask>();
  private running = false;

  constructor(storePath: string, onJobFire: JobFireCallback) {
    this.store = new CronStore(storePath);
    this.onJobFire = onJobFire;
  }

  /** Load persisted jobs and schedule them. Paused jobs are persisted but not scheduled. */
  start(): void {
    this.running = true;
    for (const job of this.store.listJobs()) {
      if (job.enabled && !job.paused) {
        this.schedule(job);
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  createJob(cronExpr: string, prompt: string): CronJob {
    if (!cron.validate(cronExpr)) {
      throw new Error(`Invalid cron expression: "${cronExpr}"`);
    }

    const job: CronJob = {
      id: randomUUID(),
      cron: cronExpr,
      prompt,
      enabled: true,
      paused: false,
      createdAt: new Date().toISOString(),
    };

    this.store.saveJob(job);
    if (this.running) {
      this.schedule(job);
    }
    return job;
  }

  deleteJob(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    this.store.deleteJob(id);
  }

  getJob(id: string): CronJob | null {
    return this.store.getJob(id);
  }

  pauseJob(id: string): CronJob | null {
    const updated = this.store.setPaused(id, true);
    if (!updated) return null;
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    return updated;
  }

  resumeJob(id: string): CronJob | null {
    const updated = this.store.setPaused(id, false);
    if (!updated) return null;
    if (this.running && updated.enabled && !this.tasks.has(id)) {
      this.schedule(updated);
    }
    return updated;
  }

  /** Update a job's cron expression and/or prompt. Re-schedules if currently scheduled. */
  editJob(
    id: string,
    patch: { cron?: string; prompt?: string },
  ): CronJob | null {
    if (patch.cron !== undefined && !cron.validate(patch.cron)) {
      throw new Error(`Invalid cron expression: "${patch.cron}"`);
    }
    const updated = this.store.updateJob(id, patch);
    if (!updated) return null;

    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    if (this.running && updated.enabled && !updated.paused) {
      this.schedule(updated);
    }
    return updated;
  }

  /** Trigger a job immediately, regardless of schedule or pause state. */
  runJob(id: string): CronJob | null {
    const job = this.store.getJob(id);
    if (!job) return null;
    this.onJobFire(job);
    return job;
  }

  /** Run every enabled, non-paused job once. Used for manual tick / debugging. */
  tick(): CronJob[] {
    const fired: CronJob[] = [];
    for (const job of this.store.listJobs()) {
      if (job.enabled && !job.paused) {
        this.onJobFire(job);
        fired.push(job);
      }
    }
    return fired;
  }

  listJobs(): CronJob[] {
    return this.store.listJobs();
  }

  /** Stop all scheduled tasks. */
  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
    this.running = false;
  }

  private schedule(job: CronJob): void {
    const task = cron.schedule(job.cron, () => {
      // Re-check pause state at fire time so a pause issued between scheduling
      // and the next tick is honored even before stop() lands.
      const current = this.store.getJob(job.id);
      if (current && (current.paused || !current.enabled)) {
        return;
      }
      this.onJobFire(current ?? job);
    });
    this.tasks.set(job.id, task);
  }
}
