import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";
import { estimateCostUsd } from "../../src/core/model-metadata.js";

let tmpDir: { path: string; cleanup: () => void };
let store: SessionStore;

beforeEach(() => {
  tmpDir = createTempDir("session-metadata-test-");
  store = new SessionStore(join(tmpDir.path, "test.db"));
});

afterEach(() => {
  store.close();
  tmpDir.cleanup();
});

describe("estimateCostUsd", () => {
  it("returns null for unknown models or missing input", () => {
    expect(estimateCostUsd(null, { input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(estimateCostUsd("", { input_tokens: 10, output_tokens: 10 })).toBeNull();
    expect(
      estimateCostUsd("totally-fake-model-xyz", {
        input_tokens: 100_000,
        output_tokens: 50_000,
      }),
    ).toBeNull();
  });

  it("computes cost for claude-sonnet-4 using list price", () => {
    // sonnet-4: $3/M input, $15/M output
    const cost = estimateCostUsd("claude-sonnet-4-20250514", {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    });
    // 1*3 + 0.5*15 = 3 + 7.5 = 10.5
    expect(cost).toBeCloseTo(10.5, 5);
  });

  it("includes cache read and cache creation cost when priced", () => {
    // haiku-4: input $0.80/M, output $4/M, cache read $0.08/M, cache write $1/M
    const cost = estimateCostUsd("claude-haiku-4-20250514", {
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 10_000,
    });
    // 0.1*0.80 + 0.05*4 + 0.2*0.08 + 0.01*1 = 0.08 + 0.2 + 0.016 + 0.01 = 0.306
    expect(cost).toBeCloseTo(0.306, 5);
  });

  it("skips cache costs when model has no cache pricing", () => {
    // gpt-4o-mini has cache read but no cache write price
    const cost = estimateCostUsd("gpt-4o-mini", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    // 1*0.15 + 1*0.60 + 0 (no cache write price) = 0.75
    expect(cost).toBeCloseTo(0.75, 5);
  });
});

describe("SessionStore.listSessionSummaries", () => {
  it("returns sessions ordered by created_at desc with message and tool counts", () => {
    store.createSession({ id: "s1", model: "claude-sonnet-4-20250514", source: "cli", title: "first" });
    store.createSession({ id: "s2", model: "gpt-4o-mini", source: "cli", title: "second" });

    store.appendMessage("s1", { role: "user", content: "hello" });
    store.appendMessage("s1", { role: "assistant", content: "hi" });
    store.appendMessage("s1", {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "file_read", arguments: "{}" },
        },
      ],
    });
    store.appendMessage("s1", {
      role: "tool",
      content: "result",
      tool_call_id: "call_1",
      tool_name: "file_read",
    });

    store.appendMessage("s2", { role: "user", content: "another" });

    store.recordTokenUsage("s1", {
      input_tokens: 1200,
      output_tokens: 400,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    });
    store.recordTokenUsage("s2", { input_tokens: 50, output_tokens: 25 });

    const summaries = store.listSessionSummaries();
    expect(summaries.length).toBe(2);

    const s1 = summaries.find((row) => row.id === "s1")!;
    expect(s1.title).toBe("first");
    expect(s1.model).toBe("claude-sonnet-4-20250514");
    expect(s1.message_count).toBe(4);
    expect(s1.tool_call_count).toBe(2);
    expect(s1.input_tokens).toBe(1200);
    expect(s1.output_tokens).toBe(400);
    expect(s1.cache_read_input_tokens).toBe(300);
    expect(s1.cache_creation_input_tokens).toBe(100);
    expect(s1.requests).toBe(1);

    const s2 = summaries.find((row) => row.id === "s2")!;
    expect(s2.message_count).toBe(1);
    expect(s2.tool_call_count).toBe(0);
    expect(s2.input_tokens).toBe(50);
    expect(s2.requests).toBe(1);
  });

  it("returns zeros for sessions with no messages or usage", () => {
    store.createSession({ id: "empty", model: "gpt-4o", source: "cli" });
    const summaries = store.listSessionSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].message_count).toBe(0);
    expect(summaries[0].tool_call_count).toBe(0);
    expect(summaries[0].input_tokens).toBe(0);
    expect(summaries[0].requests).toBe(0);
  });
});
