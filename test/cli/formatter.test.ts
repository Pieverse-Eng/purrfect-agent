import { describe, it, expect } from "vitest";
import { formatTokenDisplay, formatCost, ansiColor, spinner } from "../../src/cli/formatter.js";
import { CacheStats } from "../../src/core/cache-stats.js";

describe("CLI Formatter", () => {
  it("formatTokenDisplay renders correct counts", () => {
    const result = formatTokenDisplay(150, 50);
    expect(result).toBe("[tokens: 150/50]");
  });

  it("formatTokenDisplay with cache stats shows hit rate", () => {
    const stats = new CacheStats();
    stats.recordUsage({ cache_read_input_tokens: 80, cache_creation_input_tokens: 20 });
    const result = formatTokenDisplay(150, 50, stats);
    expect(result).toBe("[tokens: 150/50 | cache: 80%]");
  });

  it("formatCost estimates from model pricing", () => {
    const result = formatCost("claude-sonnet-4-20250514", 1000, 500);
    // Should return a string starting with ~$
    expect(result).toMatch(/^~\$\d+\.\d{2}$/);
    // Cost should be a positive number
    const amount = parseFloat(result.slice(2));
    expect(amount).toBeGreaterThan(0);
  });

  it("ansiColor wraps text with correct ANSI codes", () => {
    const result = ansiColor("hello", "green");
    expect(result).toBe("\x1b[32mhello\x1b[0m");

    const red = ansiColor("error", "red");
    expect(red).toBe("\x1b[31merror\x1b[0m");

    const yellow = ansiColor("warn", "yellow");
    expect(yellow).toBe("\x1b[33mwarn\x1b[0m");
  });

  it("formatTokenDisplay with zero tokens returns 0/0", () => {
    const result = formatTokenDisplay(0, 0);
    expect(result).toBe("[tokens: 0/0]");
  });
});
