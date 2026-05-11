import { describe, it, expect, vi } from "vitest";
import {
  ContextCompressor,
  SUMMARY_PREFIX,
  pruneToolResults,
  createProviderSummarizer,
} from "../../src/core/compressor.js";
import type { Message } from "../../src/core/types.js";

/** Helper: build alternating user/assistant messages. */
function makeMessages(n: number, startRole: "user" | "assistant" = "user"): Message[] {
  const roles: Array<"user" | "assistant"> = ["user", "assistant"];
  const startIdx = startRole === "user" ? 0 : 1;
  return Array.from({ length: n }, (_, i) => ({
    role: roles[(i + startIdx) % 2],
    content: `msg ${i}`,
  }));
}

/** Helper: build a long message with ~tokenCount tokens (rough: 4 chars/token). */
function longContent(tokenCount: number): string {
  return "x".repeat(tokenCount * 4);
}

describe("ContextCompressor: shouldCompress", () => {
  it("returns true when estimated tokens exceed threshold", () => {
    const compressor = new ContextCompressor({ contextLength: 1000, thresholdPercent: 0.5 });
    // Use a large enough content to definitely exceed 500 token threshold
    // gpt-tokenizer tokenizes repeated chars efficiently, so use varied text
    const bigContent = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const msgs: Message[] = [{ role: "user", content: bigContent }];
    expect(compressor.shouldCompress(msgs, 1000)).toBe(true);
  });

  it("returns false when estimated tokens are under threshold", () => {
    const compressor = new ContextCompressor({ contextLength: 1000, thresholdPercent: 0.5 });
    const msgs: Message[] = [{ role: "user", content: "short" }];
    expect(compressor.shouldCompress(msgs, 1000)).toBe(false);
  });
});

describe("ContextCompressor: compress — truncation", () => {
  it("prunes old tool results first", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      thresholdPercent: 0.5,
      protectFirstN: 2,
      protectLastN: 2,
    });

    // Build enough messages so the old tool result at index 2 falls before
    // the prune boundary (len - protectLastN*3). We need > 8 messages.
    const msgs: Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }] },
      { role: "tool", content: "x".repeat(500), tool_call_id: "call_1" },
      { role: "assistant", content: "middle response" },
      { role: "user", content: "more 1" },
      { role: "assistant", content: "more resp 1" },
      { role: "user", content: "more 2" },
      { role: "assistant", content: "more resp 2" },
      { role: "user", content: "more 3" },
      { role: "assistant", content: "more resp 3" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ];

    const result = await compressor.compress(msgs);
    // The old tool result (index 2) should have been pruned or removed
    const toolMsg = result.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_1",
    );
    // Tool result should either be pruned to placeholder or removed entirely
    if (toolMsg) {
      expect(toolMsg.content).not.toBe("x".repeat(500));
    }
  });

  it("protects head messages (system + first exchange)", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      thresholdPercent: 0.5,
      protectFirstN: 3,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      ...makeMessages(10),
      { role: "user", content: "final question" },
      { role: "assistant", content: "final answer" },
    ];

    const result = await compressor.compress(msgs);
    // System, first user, first assistant should remain unchanged
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("You are helpful.");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("Hello");
    expect(result[2].role).toBe("assistant");
    expect(result[2].content).toBe("Hi there!");
  });

  it("protects tail messages from compression", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      thresholdPercent: 0.5,
      protectFirstN: 2,
      protectLastN: 3,
    });

    const msgs: Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "start resp" },
      ...makeMessages(10),
      { role: "user", content: "tail 1" },
      { role: "assistant", content: "tail 2" },
      { role: "user", content: "tail 3" },
    ];

    const result = await compressor.compress(msgs);
    // Last 3 messages should be preserved
    expect(result[result.length - 1].content).toBe("tail 3");
    expect(result[result.length - 2].content).toBe("tail 2");
    expect(result[result.length - 3].content).toBe("tail 1");
  });
});

describe("ContextCompressor: compress — summarization via callback", () => {
  it("summarizes middle messages via callback and inserts summary", async () => {
    const summarize = vi.fn().mockResolvedValue("Summary of earlier work.");

    const compressor = new ContextCompressor({
      contextLength: 100_000,
      thresholdPercent: 0.5,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      // middle — to be summarized
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
      // tail
      { role: "user", content: "msg 6" },
      { role: "assistant", content: "msg 7" },
    ];

    const result = await compressor.compress(msgs, { summarize });
    expect(summarize).toHaveBeenCalled();

    // The summary message should contain the SUMMARY_PREFIX
    const summaryMsg = result.find((m) =>
      (m.content ?? "").startsWith(SUMMARY_PREFIX),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain("Summary of earlier work.");

    // Result should be shorter than original
    expect(result.length).toBeLessThan(msgs.length);
  });

  it("summary prefix is present in compressed output", async () => {
    const summarize = vi.fn().mockResolvedValue("Work done.");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
    ];

    const result = await compressor.compress(msgs, { summarize });
    const contents = result.map((m) => m.content ?? "");
    expect(contents.some((c) => c.startsWith(SUMMARY_PREFIX))).toBe(true);
  });
});

describe("ContextCompressor: iterative summary updates", () => {
  function makeMessages(prefix: string): Message[] {
    return [
      { role: "user", content: `${prefix} msg 0` },
      { role: "assistant", content: `${prefix} msg 1` },
      { role: "user", content: `${prefix} msg 2` },
      { role: "assistant", content: `${prefix} msg 3` },
      { role: "user", content: `${prefix} msg 4` },
      { role: "assistant", content: `${prefix} msg 5` },
    ];
  }

  it("does not pass previousSummary to the first compression", async () => {
    const summarize = vi.fn().mockResolvedValue("Goal: build feature");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    await compressor.compress(makeMessages("first"), { summarize });
    expect(summarize).toHaveBeenCalledTimes(1);
    const opts = summarize.mock.calls[0][1];
    expect(opts.previousSummary).toBeUndefined();
  });

  it("forwards the prior summary into the next compression", async () => {
    const summarize = vi
      .fn()
      .mockResolvedValueOnce(
        "Goal: build feature\nProgress:\n- explored API\nNext Steps: write tests",
      )
      .mockResolvedValueOnce("Goal: build feature\nProgress:\n- explored API\n- wrote tests");

    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    await compressor.compress(makeMessages("first"), { summarize });
    expect(compressor.compressions).toBe(1);
    expect(compressor.getPreviousSummary()).toContain("Progress");

    await compressor.compress(makeMessages("second"), { summarize });
    expect(summarize).toHaveBeenCalledTimes(2);
    const secondOpts = summarize.mock.calls[1][1];
    expect(secondOpts.previousSummary).toContain("Goal: build feature");
    expect(secondOpts.previousSummary).toContain("Next Steps");
    expect(compressor.getPreviousSummary()).toContain("- wrote tests");
  });

  it("does not store a previous summary when summarization throws", async () => {
    const summarize = vi.fn().mockRejectedValue(new Error("nope"));
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    await compressor.compress(makeMessages("first"), { summarize });
    expect(compressor.getPreviousSummary()).toBeNull();
  });

  it("resetSummaryHistory clears the iterative state", async () => {
    const summarize = vi.fn().mockResolvedValue("Goal: do thing");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    await compressor.compress(makeMessages("first"), { summarize });
    expect(compressor.getPreviousSummary()).not.toBeNull();
    compressor.resetSummaryHistory();
    expect(compressor.getPreviousSummary()).toBeNull();
  });

  it("createProviderSummarizer switches to the iterative system prompt when given a previous summary", async () => {
    const chat = vi.fn(async () => ({
      choices: [{ message: { content: "Goal: refined" } }],
    }));
    const provider = { chat };
    const summarizer = createProviderSummarizer(provider);

    await summarizer(
      [{ role: "user", content: "fresh turn" }],
      { budget: 1000, previousSummary: "Goal: original\nProgress:\n- did A" },
    );

    const messages = chat.mock.calls[0][0];
    expect(messages[0].content).toContain("REFINING an existing structured summary");
    expect(messages[1].content).toContain("Previous structured summary:");
    expect(messages[1].content).toContain("Goal: original");
    expect(messages[1].content).toContain("New conversation turns to fold in:");
    expect(messages[1].content).toContain("fresh turn");
  });

  it("createProviderSummarizer keeps the default prompt when no previous summary exists", async () => {
    const chat = vi.fn(async () => ({
      choices: [{ message: { content: "Goal: fresh" } }],
    }));
    const provider = { chat };
    const summarizer = createProviderSummarizer(provider);

    await summarizer(
      [{ role: "user", content: "turn" }],
      { budget: 500 },
    );

    const messages = chat.mock.calls[0][0];
    expect(messages[0].content).not.toContain("REFINING");
    expect(messages[1].content).not.toContain("Previous structured summary:");
  });
});

describe("ContextCompressor: role alternation", () => {
  it("avoids consecutive same-role messages after summary insertion", async () => {
    const summarize = vi.fn().mockResolvedValue("summary");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    // Head ends with assistant, tail starts with user — summary should be "user"
    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
    ];

    const result = await compressor.compress(msgs, { summarize });
    // Check no consecutive user-user or assistant-assistant among user/assistant
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1].role;
      const curr = result[i].role;
      if (
        prev !== "system" && prev !== "tool" &&
        curr !== "system" && curr !== "tool"
      ) {
        expect(curr).not.toBe(prev);
      }
    }
  });
});

describe("ContextCompressor: edge cases", () => {
  it("preserves adjacent tool-call/tool-result pairs as a unit", async () => {
    const summarize = vi.fn().mockResolvedValue("summary");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 4,
    });

    const msgs: Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "ack" },
      // middle
      { role: "user", content: "middle 1" },
      { role: "assistant", content: "middle 2" },
      // tail: tool call pair should stay intact
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_t", type: "function", function: { name: "run", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "tool output", tool_call_id: "call_t" },
      { role: "user", content: "tail user" },
      { role: "assistant", content: "tail assistant" },
    ];

    const result = await compressor.compress(msgs, { summarize });

    // Every tool result's call_id should have a matching assistant tool_call
    const calledIds = new Set<string>();
    for (const m of result) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          calledIds.add(tc.id);
        }
      }
    }
    for (const m of result) {
      if (m.role === "tool" && m.tool_call_id) {
        expect(calledIds.has(m.tool_call_id)).toBe(true);
      }
    }
  });

  it("handles messages with null content without crash", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_n", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "call_n" },
      { role: "assistant", content: null },
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];

    // Should not throw
    const result = await compressor.compress(msgs);
    expect(result.length).toBeGreaterThan(0);
  });

  it("too few messages returns unchanged", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];

    const result = await compressor.compress(msgs);
    expect(result).toEqual(msgs);
  });
});

describe("ContextCompressor: error handling", () => {
  it("falls back to truncation when summarize callback fails", async () => {
    const summarize = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
      { role: "user", content: "msg 6" },
      { role: "assistant", content: "msg 7" },
    ];

    const result = await compressor.compress(msgs, { summarize });
    // Should still compress (truncation-only), not throw
    expect(result.length).toBeLessThan(msgs.length);
    // Head and tail preserved
    expect(result[0].content).toBe("msg 0");
    expect(result[result.length - 1].content).toBe("msg 7");
  });
});

describe("ContextCompressor: instantiation", () => {
  it("instantiable with default options", () => {
    const compressor = new ContextCompressor({ contextLength: 100_000 });
    expect(compressor).toBeInstanceOf(ContextCompressor);
  });

  it("uses 50% threshold by default", () => {
    const compressor = new ContextCompressor({ contextLength: 100_000 });
    // shouldCompress should be false for small messages against 50K threshold
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    expect(compressor.shouldCompress(msgs, 100_000)).toBe(false);
  });

  it("compressor is usable with mock summarize callback (no real LLM calls)", async () => {
    const summarize = vi.fn().mockResolvedValue("Mock summary.");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = makeMessages(8);
    const result = await compressor.compress(msgs, { summarize });
    expect(result.length).toBeLessThan(msgs.length);
    expect(summarize).toHaveBeenCalled();
  });
});

// =========================================================================
// [hermes parity] Compressor edge cases
// =========================================================================

describe("[hermes parity] Compressor edge cases", () => {
  it("handles messages with null content (tool-call-only assistant messages) without crash", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_tc1", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "call_tc1" },
      { role: "assistant", content: null },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "you're welcome" },
      { role: "user", content: "more" },
      { role: "assistant", content: "more reply" },
    ];

    // Should not throw
    const result = await compressor.compress(msgs);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles messages with object content (vision/multimodal format) without crash", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    // Simulate object content (cast to any to bypass TS type checks)
    const msgs: Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "ack" },
      { role: "user", content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:..." } }] as any },
      { role: "assistant", content: "I see an image" },
      { role: "user", content: "more question" },
      { role: "assistant", content: "more answer" },
      { role: "user", content: "final" },
      { role: "assistant", content: "done" },
    ];

    // Should not throw
    const result = await compressor.compress(msgs);
    expect(result.length).toBeGreaterThan(0);
  });

  it("deduplicates summary prefix — does not double-prefix", async () => {
    const summarize = vi.fn().mockResolvedValue(`${SUMMARY_PREFIX}\nSome work was done.`);
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
    ];

    const result = await compressor.compress(msgs, { summarize });
    const summaryMsgs = result.filter((m) =>
      (m.content ?? "").includes(SUMMARY_PREFIX),
    );
    // Should have exactly one summary prefix occurrence
    for (const sm of summaryMsgs) {
      const occurrences = (sm.content ?? "").split(SUMMARY_PREFIX).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("tracks compression count — increments on successive compressions", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = makeMessages(10);
    expect(compressor.compressions).toBe(0);

    await compressor.compress(msgs);
    expect(compressor.compressions).toBe(1);

    await compressor.compress(msgs);
    expect(compressor.compressions).toBe(2);
  });

  it("handles orphaned tool results after compression", async () => {
    const summarize = vi.fn().mockResolvedValue("summary of middle work");
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    // The tool result at index 4 references call_orphan which is in the
    // compressed-away middle section
    const msgs: Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "ack" },
      // middle — will be summarized
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_orphan", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "orphan result", tool_call_id: "call_orphan" },
      { role: "user", content: "mid question" },
      { role: "assistant", content: "mid answer" },
      // tail
      { role: "user", content: "final q" },
      { role: "assistant", content: "final a" },
    ];

    const result = await compressor.compress(msgs, { summarize });

    // Every tool result in the output should have a matching tool_call
    const calledIds = new Set<string>();
    for (const m of result) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) calledIds.add(tc.id);
      }
    }
    for (const m of result) {
      if (m.role === "tool" && m.tool_call_id) {
        expect(calledIds.has(m.tool_call_id)).toBe(true);
      }
    }
  });

  it("returns unchanged for very short conversation (2 messages)", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = await compressor.compress(msgs);
    expect(result).toEqual(msgs);
  });

  it("handles all-system-messages conversation gracefully", async () => {
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = [
      { role: "system", content: "system 1" },
      { role: "system", content: "system 2" },
      { role: "system", content: "system 3" },
    ];

    // Should not throw and should return something reasonable
    const result = await compressor.compress(msgs);
    expect(result.length).toBeGreaterThan(0);
  });
});

// =========================================================================
// pruneToolResults — standalone function
// =========================================================================

describe("pruneToolResults (standalone)", () => {
  it("replaces old tool-result bodies exceeding maxBytesPerResult with placeholder", () => {
    const bigBody = "x".repeat(5_000);
    const msgs: Message[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: bigBody, tool_call_id: "c1" },
      ...Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    ];

    const out = pruneToolResults(msgs, { maxAgeTurns: 5, maxBytesPerResult: 100 });
    const tool = out.find((m) => m.tool_call_id === "c1");
    expect(tool).toBeDefined();
    expect(tool!.content).not.toBe(bigBody);
    expect(tool!.content).toContain("Old tool output cleared");
  });

  it("preserves recent tool-result bodies within maxAgeTurns", () => {
    const bigBody = "y".repeat(5_000);
    const msgs: Message[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c_recent", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", content: bigBody, tool_call_id: "c_recent" },
    ];

    const out = pruneToolResults(msgs, { maxAgeTurns: 10, maxBytesPerResult: 100 });
    const tool = out.find((m) => m.tool_call_id === "c_recent");
    expect(tool!.content).toBe(bigBody);
  });

  it("is a no-op on empty input", () => {
    const out = pruneToolResults([]);
    expect(out).toEqual([]);
  });

  it("leaves tool-results shorter than maxBytesPerResult untouched", () => {
    const msgs: Message[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
      { role: "tool", content: "short", tool_call_id: "tiny" },
      ...Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `t${i}` })),
    ];
    const out = pruneToolResults(msgs, { maxAgeTurns: 10, maxBytesPerResult: 100 });
    const tool = out.find((m) => m.tool_call_id === "tiny");
    expect(tool!.content).toBe("short");
  });

  it("returns a fresh array — does not mutate input", () => {
    const msgs: Message[] = [
      { role: "tool", content: "a".repeat(500), tool_call_id: "c1" },
      ...Array.from({ length: 100 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    ];
    const before = msgs[0].content;
    pruneToolResults(msgs, { maxAgeTurns: 10, maxBytesPerResult: 100 });
    expect(msgs[0].content).toBe(before);
  });

  it("accepts a custom placeholder string", () => {
    const msgs: Message[] = [
      { role: "tool", content: "z".repeat(500), tool_call_id: "c1" },
      ...Array.from({ length: 100 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    ];
    const out = pruneToolResults(msgs, {
      maxAgeTurns: 10,
      maxBytesPerResult: 100,
      placeholder: "[REDACTED]",
    });
    expect(out[0].content).toBe("[REDACTED]");
  });
});

// =========================================================================
// shouldCompressPreflight + preflightCompress
// =========================================================================

describe("ContextCompressor: preflight", () => {
  it("shouldCompressPreflight fires before true threshold (with margin)", () => {
    const compressor = new ContextCompressor({
      contextLength: 1000,
      thresholdPercent: 0.5,
      preflightMarginTokens: 100,
    });
    // Build a message whose estimate is just under threshold (500) but
    // once margin (100) is added, exceeds it.
    const text = Array.from({ length: 450 }, (_, i) => `w${i}`).join(" ");
    const msgs: Message[] = [{ role: "user", content: text }];
    expect(compressor.shouldCompressPreflight(msgs)).toBe(true);
  });

  it("default preflightMarginTokens scales down on small context windows", () => {
    // Small 4K window, 0.5 threshold → thresholdTokens = 2000.
    // Default margin should be min(2048, 2000 * 0.1) = 200, not 2048.
    const small = new ContextCompressor({
      contextLength: 4000,
      thresholdPercent: 0.5,
    });
    expect(small.preflightMarginTokens).toBe(200);

    // Large 200K window, 0.5 threshold → thresholdTokens = 100_000.
    // Default margin caps at 2048.
    const big = new ContextCompressor({
      contextLength: 200_000,
      thresholdPercent: 0.5,
    });
    expect(big.preflightMarginTokens).toBe(2048);

    // Explicit override still wins.
    const override = new ContextCompressor({
      contextLength: 4000,
      thresholdPercent: 0.5,
      preflightMarginTokens: 1024,
    });
    expect(override.preflightMarginTokens).toBe(1024);
  });

  it("shouldCompressPreflight accepts explicit promptTokens override", () => {
    const compressor = new ContextCompressor({
      contextLength: 10_000,
      thresholdPercent: 0.5,
      preflightMarginTokens: 1000,
    });
    // Tell it we have 4500 tokens — 4500 + 1000 >= 5000 threshold → true
    expect(compressor.shouldCompressPreflight([], 4500)).toBe(true);
    // 3000 + 1000 < 5000 → false
    expect(compressor.shouldCompressPreflight([], 3000)).toBe(false);
  });

  it("preflightCompress returns unchanged when below threshold", async () => {
    const summarize = vi.fn().mockResolvedValue("summary");
    const compressor = new ContextCompressor({
      contextLength: 1_000_000,
      thresholdPercent: 0.5,
      protectFirstN: 2,
      protectLastN: 2,
    });

    const msgs: Message[] = makeMessages(10);
    const result = await compressor.preflightCompress(msgs, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(result).toBe(msgs);
    expect(compressor.compressions).toBe(0);
  });

  it("preflightCompress triggers full compress when over threshold", async () => {
    const summarize = vi.fn().mockResolvedValue("earlier work summary");
    const compressor = new ContextCompressor({
      contextLength: 100,
      thresholdPercent: 0.5,
      protectFirstN: 2,
      protectLastN: 2,
      preflightMarginTokens: 0,
    });

    // Build a long conversation to definitely exceed 50-token threshold
    const msgs: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message content ${i} with extra filler to push the token count up ${i}`,
    }));

    const result = await compressor.preflightCompress(msgs, { summarize });
    expect(summarize).toHaveBeenCalled();
    expect(result.length).toBeLessThan(msgs.length);
    expect(compressor.compressions).toBe(1);
  });
});

// =========================================================================
// auxiliaryProvider auto-summarization
// =========================================================================

describe("ContextCompressor: auxiliaryProvider", () => {
  it("uses auxiliaryProvider when no summarize callback is provided", async () => {
    const chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "aux summary" } }],
    });
    const auxProvider = { chat };

    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
      auxiliaryProvider: auxProvider,
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
    ];

    const result = await compressor.compress(msgs);
    expect(chat).toHaveBeenCalled();
    const summaryMsg = result.find((m) =>
      (m.content ?? "").startsWith(SUMMARY_PREFIX),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain("aux summary");
  });

  it("explicit summarize callback wins over auxiliaryProvider", async () => {
    const chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "aux summary" } }],
    });
    const callback = vi.fn().mockResolvedValue("callback summary");

    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
      auxiliaryProvider: { chat },
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
    ];

    const result = await compressor.compress(msgs, { summarize: callback });
    expect(callback).toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    const summaryMsg = result.find((m) =>
      (m.content ?? "").startsWith(SUMMARY_PREFIX),
    );
    expect(summaryMsg!.content).toContain("callback summary");
  });

  it("createProviderSummarizer wraps a provider into a SummarizeCallback", async () => {
    const chat = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "wrapped" } }],
    });
    const summarize = createProviderSummarizer({ chat });
    const out = await summarize(
      [{ role: "user", content: "hi" }],
      { budget: 500 },
    );
    expect(chat).toHaveBeenCalledTimes(1);
    const [sentMessages, sentTools, sentOpts] = chat.mock.calls[0];
    expect(Array.isArray(sentMessages)).toBe(true);
    expect(sentTools).toEqual([]);
    expect(sentOpts.maxTokens).toBe(500);
    expect(out).toBe("wrapped");
  });

  it("falls back to truncation-only when auxiliaryProvider throws", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("aux unavailable"));
    const compressor = new ContextCompressor({
      contextLength: 100_000,
      protectFirstN: 2,
      protectLastN: 2,
      auxiliaryProvider: { chat },
    });

    const msgs: Message[] = [
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1" },
      { role: "user", content: "msg 2" },
      { role: "assistant", content: "msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
      { role: "user", content: "msg 6" },
      { role: "assistant", content: "msg 7" },
    ];

    const result = await compressor.compress(msgs);
    expect(chat).toHaveBeenCalled();
    // Compress still ran (truncation-only, no summary), output is shorter
    expect(result.length).toBeLessThan(msgs.length);
    expect(result[0].content).toBe("msg 0");
    expect(result[result.length - 1].content).toBe("msg 7");
  });
});
