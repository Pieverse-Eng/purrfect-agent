import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { CronStore } from "../../../src/core/cron/store.js";
import { CronScheduler } from "../../../src/core/cron/scheduler.js";

let tmpDir: { path: string; cleanup: () => void };
let storePath: string;

beforeEach(() => {
  tmpDir = createTempDir("cron-ops-test-");
  storePath = join(tmpDir.path, "cron-jobs.json");
});

afterEach(() => {
  tmpDir.cleanup();
});

describe("CronStore mutation helpers", () => {
  it("setPaused flips the paused flag and bumps updatedAt", () => {
    const store = new CronStore(storePath);
    store.saveJob({
      id: "j1",
      cron: "* * * * *",
      prompt: "hi",
      enabled: true,
      paused: false,
      createdAt: new Date().toISOString(),
    });
    const updated = store.setPaused("j1", true);
    expect(updated?.paused).toBe(true);
    expect(updated?.updatedAt).toBeTypeOf("string");

    const reload = new CronStore(storePath);
    expect(reload.getJob("j1")?.paused).toBe(true);
  });

  it("setPaused returns null when job missing", () => {
    const store = new CronStore(storePath);
    expect(store.setPaused("nope", true)).toBeNull();
  });

  it("updateJob applies patch to cron and prompt", () => {
    const store = new CronStore(storePath);
    store.saveJob({
      id: "j1",
      cron: "* * * * *",
      prompt: "old",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    const updated = store.updateJob("j1", { cron: "0 * * * *", prompt: "new" });
    expect(updated?.cron).toBe("0 * * * *");
    expect(updated?.prompt).toBe("new");
  });
});

describe("CronScheduler ops", () => {
  it("pauseJob stops live task and persists paused=true", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    scheduler.start();
    const job = scheduler.createJob("*/5 * * * *", "x");
    const paused = scheduler.pauseJob(job.id);
    expect(paused?.paused).toBe(true);

    // After pause + restart, scheduler must skip paused job
    scheduler.stop();

    let fired = 0;
    const next = new CronScheduler(storePath, () => { fired++; });
    next.start();
    // Run synchronous tick — paused job must NOT fire
    next.tick();
    expect(fired).toBe(0);
    next.stop();
  });

  it("resumeJob clears paused and re-schedules when running", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    scheduler.start();
    const job = scheduler.createJob("*/5 * * * *", "x");
    scheduler.pauseJob(job.id);
    const resumed = scheduler.resumeJob(job.id);
    expect(resumed?.paused).toBe(false);
    scheduler.stop();
  });

  it("editJob updates cron expression and validates new expression", () => {
    const scheduler = new CronScheduler(storePath, () => {});
    const job = scheduler.createJob("*/5 * * * *", "x");
    const edited = scheduler.editJob(job.id, { cron: "0 9 * * *", prompt: "morning" });
    expect(edited?.cron).toBe("0 9 * * *");
    expect(edited?.prompt).toBe("morning");
    expect(() => scheduler.editJob(job.id, { cron: "not-a-cron" })).toThrow(/invalid cron/i);
    scheduler.stop();
  });

  it("runJob fires the callback with the job, regardless of pause state", () => {
    let fired = 0;
    const scheduler = new CronScheduler(storePath, (j) => {
      fired++;
      expect(j.id).toBeTypeOf("string");
    });
    const job = scheduler.createJob("*/5 * * * *", "x");
    scheduler.pauseJob(job.id);
    scheduler.runJob(job.id);
    expect(fired).toBe(1);
    scheduler.stop();
  });

  it("tick fires each enabled non-paused job exactly once", () => {
    let fired = 0;
    const scheduler = new CronScheduler(storePath, () => { fired++; });
    scheduler.createJob("*/5 * * * *", "a");
    scheduler.createJob("*/5 * * * *", "b");
    const c = scheduler.createJob("*/5 * * * *", "c");
    scheduler.pauseJob(c.id);
    const ticked = scheduler.tick();
    expect(ticked).toHaveLength(2);
    expect(fired).toBe(2);
    scheduler.stop();
  });
});
