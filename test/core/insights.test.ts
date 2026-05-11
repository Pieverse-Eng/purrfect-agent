import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../src/core/session-store.js";
import {
  aggregateTurns,
  buildInsights,
  parseLastWindowSeconds,
} from "../../src/core/insights.js";

function makeStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "purrfect-insights-"));
  const store = new SessionStore(join(dir, "sessions.db"));
  return { store, dir };
}

describe("parseLastWindowSeconds", () => {
  it("returns undefined for missing/garbage input", () => {
    expect(parseLastWindowSeconds(undefined)).toBeUndefined();
    expect(parseLastWindowSeconds("")).toBeUndefined();
    expect(parseLastWindowSeconds("yesterday")).toBeUndefined();
  });

  it("converts d/h/m/w into a cutoff in the past", () => {
    const before = Date.now() / 1000;
    const sevenDays = parseLastWindowSeconds("7d")!;
    const after = Date.now() / 1000;
    expect(sevenDays).toBeGreaterThanOrEqual(before - 7 * 86_400 - 1);
    expect(sevenDays).toBeLessThanOrEqual(after - 7 * 86_400 + 1);
  });
});

describe("aggregateTurns", () => {
  it("returns zeros for empty input", () => {
    const report = aggregateTurns([]);
    expect(report.totals.turns).toBe(0);
    expect(report.totals.cache_hit_rate).toBe(0);
    expect(report.totals.latency_ms_avg).toBe(0);
    expect(report.by_model).toEqual([]);
    expect(report.by_session).toEqual([]);
  });

  it("rolls up per model and per session, computes hit rate + average latency", () => {
    const now = Date.now() / 1000;
    const turns = [
      {
        id: 1,
        session_id: "s1",
        model: "claude-sonnet-4-20250514",
        model_tier: null,
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        cost_usd: 0.05,
        latency_ms: 1000,
        created_at: now,
      },
      {
        id: 2,
        session_id: "s1",
        model: "claude-sonnet-4-20250514",
        model_tier: null,
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cost_usd: 0.02,
        latency_ms: 2000,
        created_at: now + 1,
      },
      {
        id: 3,
        session_id: "s2",
        model: "gpt-4o",
        model_tier: null,
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 100,
        cost_usd: 0.01,
        latency_ms: 500,
        created_at: now + 2,
      },
    ];

    const report = aggregateTurns(turns);

    expect(report.totals.turns).toBe(3);
    expect(report.totals.input_tokens).toBe(1700);
    expect(report.totals.output_tokens).toBe(350);
    expect(report.totals.cost_usd).toBeCloseTo(0.08);
    expect(report.totals.latency_ms_avg).toBeCloseTo(1166.67, 0);
    // 900 reads / (900 reads + 300 creations) = 0.75
    expect(report.totals.cache_hit_rate).toBeCloseTo(0.75);

    expect(report.by_model).toHaveLength(2);
    const sonnet = report.by_model.find((m) => m.model.includes("sonnet"));
    expect(sonnet?.turns).toBe(2);
    expect(sonnet?.cost_usd).toBeCloseTo(0.07);

    expect(report.by_session).toHaveLength(2);
    const s1 = report.by_session.find((s) => s.session_id === "s1")!;
    expect(s1.turns).toBe(2);
  });

  it("falls back to live pricing when cost_usd is null", () => {
    const turn = {
      id: 1,
      session_id: "s1",
      model: "claude-sonnet-4-20250514",
      model_tier: null,
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_usd: null,
      latency_ms: null,
      created_at: 0,
    };
    const report = aggregateTurns([turn]);
    expect(report.totals.cost_usd).toBeCloseTo(3); // $3/M input for sonnet 4
  });
});

describe("SessionStore.recordTurn + buildInsights", () => {
  it("persists turns and produces a report scoped to a session", () => {
    const { store, dir } = makeStore();
    try {
      store.createSession({ id: "s1", model: "claude-sonnet-4-20250514", source: "test" });
      store.createSession({ id: "s2", model: "gpt-4o-mini", source: "test" });
      store.recordTurn({
        session_id: "s1",
        model: "claude-sonnet-4-20250514",
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
        cost_usd: 0.001,
        latency_ms: 250,
      });
      store.recordTurn({
        session_id: "s2",
        model: "gpt-4o-mini",
        input_tokens: 50,
        output_tokens: 10,
        cost_usd: 0.0001,
        latency_ms: 100,
      });

      const all = buildInsights(store, {});
      expect(all.totals.turns).toBe(2);
      expect(all.by_session).toHaveLength(2);

      const justS1 = buildInsights(store, { sessionId: "s1" });
      expect(justS1.totals.turns).toBe(1);
      expect(justS1.totals.input_tokens).toBe(100);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters by sinceEpochSec window", () => {
    const { store, dir } = makeStore();
    try {
      store.createSession({ id: "s1", model: "claude-sonnet-4-20250514", source: "test" });
      store.recordTurn({
        session_id: "s1",
        model: "claude-sonnet-4-20250514",
        input_tokens: 1,
        output_tokens: 1,
      });
      const futureCutoff = Date.now() / 1000 + 3600;
      const empty = buildInsights(store, { sinceEpochSec: futureCutoff });
      expect(empty.totals.turns).toBe(0);

      const pastCutoff = Date.now() / 1000 - 3600;
      const full = buildInsights(store, { sinceEpochSec: pastCutoff });
      expect(full.totals.turns).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delete session cleans up its turns", () => {
    const { store, dir } = makeStore();
    try {
      store.createSession({ id: "s1", model: "claude-sonnet-4-20250514", source: "test" });
      store.recordTurn({
        session_id: "s1",
        model: "claude-sonnet-4-20250514",
        input_tokens: 1,
        output_tokens: 1,
      });
      expect(store.listTurns("s1")).toHaveLength(1);
      store.deleteSession("s1");
      expect(store.listTurns("s1")).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
