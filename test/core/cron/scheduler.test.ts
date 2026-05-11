import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { CronStore } from "../../../src/core/cron/store.js";
import { CronScheduler } from "../../../src/core/cron/scheduler.js";

let tmpDir: { path: string; cleanup: () => void };
let storePath: string;

beforeEach(() => {
  tmpDir = createTempDir("cron-test-");
  storePath = join(tmpDir.path, "cron-jobs.json");
});

afterEach(() => {
  tmpDir.cleanup();
});

describe("CronStore", () => {
  it("returns empty array for empty / missing store", () => {
    const store = new CronStore(storePath);
    expect(store.listJobs()).toEqual([]);
  });

  it("creates store file on first write when missing", () => {
    const store = new CronStore(storePath);
    store.saveJob({
      id: "j1",
      cron: "* * * * *",
      prompt: "hello",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    // file now exists — a fresh store instance can read it
    const store2 = new CronStore(storePath);
    expect(store2.listJobs()).toHaveLength(1);
  });

  it("jobs survive store reload", () => {
    const store = new CronStore(storePath);
    store.saveJob({
      id: "persist-1",
      cron: "0 9 * * *",
      prompt: "daily standup",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    // new instance, same file
    const store2 = new CronStore(storePath);
    const jobs = store2.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("persist-1");
    expect(jobs[0].prompt).toBe("daily standup");
  });

  it("deleteJob removes the job", () => {
    const store = new CronStore(storePath);
    store.saveJob({
      id: "del-1",
      cron: "* * * * *",
      prompt: "to delete",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    expect(store.listJobs()).toHaveLength(1);
    store.deleteJob("del-1");
    expect(store.listJobs()).toHaveLength(0);
  });
});

describe("CronScheduler", () => {
  it("createJob persists and appears in listJobs", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    const job = scheduler.createJob("*/5 * * * *", "run tests");
    const jobs = scheduler.listJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(job.id);
    expect(jobs[0].prompt).toBe("run tests");
    scheduler.stop();
  });

  it("deleteJob removes a scheduled job", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    const job = scheduler.createJob("*/5 * * * *", "run tests");
    expect(scheduler.listJobs()).toHaveLength(1);

    scheduler.deleteJob(job.id);
    expect(scheduler.listJobs()).toHaveLength(0);
    scheduler.stop();
  });

  it("throws on invalid cron expression", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    expect(() => scheduler.createJob("not-a-cron", "bad")).toThrow(
      /invalid cron/i,
    );
    scheduler.stop();
  });

  it("job has correct fields", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    const before = new Date().toISOString();
    const job = scheduler.createJob("0 */2 * * *", "check status");
    const after = new Date().toISOString();

    expect(job.id).toBeTypeOf("string");
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.cron).toBe("0 */2 * * *");
    expect(job.prompt).toBe("check status");
    expect(job.enabled).toBe(true);
    expect(job.createdAt >= before).toBe(true);
    expect(job.createdAt <= after).toBe(true);
    scheduler.stop();
  });
});
