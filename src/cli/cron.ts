/**
 * Cron CLI command set: list / create / edit / pause / resume / remove / status.
 *
 * Operates on the on-disk store via CronStore so commands work even when no
 * gateway/scheduler process is running. Live status reads the gateway PID
 * file to report whether tick processing is active.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "./config.js";
import { CronStore } from "../core/cron/store.js";
import { CronScheduler } from "../core/cron/scheduler.js";
import type { CronJob } from "../core/cron/store.js";

export interface CronCommandOptions {
  configDir?: string;
  output?: (text: string) => void;
}

function getStorePath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "cron-jobs.json");
}

function getGatewayPidPath(configDir?: string): string {
  return join(configDir ?? defaultConfigDir(), "gateway.pid");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function out(opts: CronCommandOptions): (text: string) => void {
  return opts.output ?? ((text: string) => console.log(text));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function clipPrompt(prompt: string, max = 60): string {
  const single = prompt.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 1) + "…";
}

function formatJobLine(job: CronJob): string {
  const status = job.paused ? "paused" : job.enabled ? "active" : "disabled";
  return `  ${shortId(job.id)}  ${job.cron.padEnd(15)} [${status}]  ${clipPrompt(job.prompt)}`;
}

export function cronList(opts: CronCommandOptions = {}): void {
  const print = out(opts);
  const store = new CronStore(getStorePath(opts.configDir));
  const jobs = store.listJobs();
  if (jobs.length === 0) {
    print("No cron jobs.");
    return;
  }
  print(`\nCron jobs (${jobs.length}):\n`);
  for (const job of jobs) {
    print(formatJobLine(job));
  }
  print("");
}

export function cronCreate(
  cronExpr: string,
  prompt: string,
  opts: CronCommandOptions = {},
): CronJob {
  const print = out(opts);
  // Use scheduler.createJob for validation but stop() afterwards so we don't leak timers.
  const scheduler = new CronScheduler(getStorePath(opts.configDir), () => {});
  try {
    const job = scheduler.createJob(cronExpr, prompt);
    print(`Created cron job ${shortId(job.id)}: ${cronExpr} → ${clipPrompt(prompt)}`);
    return job;
  } finally {
    scheduler.stop();
  }
}

function resolveJobId(store: CronStore, idPrefix: string): CronJob | null {
  const jobs = store.listJobs();
  const match = jobs.find((j) => j.id === idPrefix || j.id.startsWith(idPrefix));
  return match ?? null;
}

export function cronEdit(
  idPrefix: string,
  patch: { cron?: string; prompt?: string },
  opts: CronCommandOptions = {},
): CronJob | null {
  const print = out(opts);
  const store = new CronStore(getStorePath(opts.configDir));
  const job = resolveJobId(store, idPrefix);
  if (!job) {
    print(`No cron job matching "${idPrefix}".`);
    return null;
  }
  // Validate cron via scheduler so we get a single source of validation truth.
  const scheduler = new CronScheduler(getStorePath(opts.configDir), () => {});
  try {
    const updated = scheduler.editJob(job.id, patch);
    if (!updated) {
      print(`Failed to edit cron job ${shortId(job.id)}.`);
      return null;
    }
    print(`Edited cron job ${shortId(updated.id)}: ${updated.cron} → ${clipPrompt(updated.prompt)}`);
    return updated;
  } finally {
    scheduler.stop();
  }
}

export function cronPause(
  idPrefix: string,
  opts: CronCommandOptions = {},
): CronJob | null {
  const print = out(opts);
  const store = new CronStore(getStorePath(opts.configDir));
  const job = resolveJobId(store, idPrefix);
  if (!job) {
    print(`No cron job matching "${idPrefix}".`);
    return null;
  }
  const updated = store.setPaused(job.id, true);
  if (updated) {
    print(`Paused cron job ${shortId(updated.id)}.`);
  }
  return updated;
}

export function cronResume(
  idPrefix: string,
  opts: CronCommandOptions = {},
): CronJob | null {
  const print = out(opts);
  const store = new CronStore(getStorePath(opts.configDir));
  const job = resolveJobId(store, idPrefix);
  if (!job) {
    print(`No cron job matching "${idPrefix}".`);
    return null;
  }
  const updated = store.setPaused(job.id, false);
  if (updated) {
    print(`Resumed cron job ${shortId(updated.id)}.`);
  }
  return updated;
}

export function cronRemove(
  idPrefix: string,
  opts: CronCommandOptions = {},
): boolean {
  const print = out(opts);
  const store = new CronStore(getStorePath(opts.configDir));
  const job = resolveJobId(store, idPrefix);
  if (!job) {
    print(`No cron job matching "${idPrefix}".`);
    return false;
  }
  store.deleteJob(job.id);
  print(`Removed cron job ${shortId(job.id)}.`);
  return true;
}

export function cronStatus(opts: CronCommandOptions = {}): {
  running: boolean;
  pid: number | null;
  jobCount: number;
  pausedCount: number;
} {
  const print = out(opts);
  const pidPath = getGatewayPidPath(opts.configDir);
  let pid: number | null = null;
  let running = false;
  if (existsSync(pidPath)) {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      pid = parsed;
      running = isProcessAlive(parsed);
    }
  }
  const store = new CronStore(getStorePath(opts.configDir));
  const jobs = store.listJobs();
  const pausedCount = jobs.filter((j) => j.paused).length;

  if (running) {
    print(`Cron scheduler: running (PID ${pid})`);
  } else if (pid !== null) {
    print(`Cron scheduler: not running (stale PID ${pid})`);
  } else {
    print("Cron scheduler: not running");
  }
  print(`  jobs=${jobs.length} paused=${pausedCount}`);
  return { running, pid, jobCount: jobs.length, pausedCount };
}
