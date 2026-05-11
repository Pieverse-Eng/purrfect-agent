import { describe, it, expect } from "vitest";
import { CacheStats } from "../../src/core/cache-stats.js";

describe("CacheStats", () => {
  it("initial state: all zeros, hitRate 0", () => {
    const stats = new CacheStats();
    expect(stats.cacheCreationTokens).toBe(0);
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.totalRequests).toBe(0);
    expect(stats.hitRate()).toBe(0);
  });

  it("record usage with cache_read increases hitRate", () => {
    const stats = new CacheStats();
    stats.recordUsage({ cache_read_input_tokens: 100 });
    expect(stats.cacheReadTokens).toBe(100);
    expect(stats.totalRequests).toBe(1);
    expect(stats.hitRate()).toBe(1); // 100 / (100 + 0) = 1
  });

  it("record usage with cache_creation is tracked correctly", () => {
    const stats = new CacheStats();
    stats.recordUsage({ cache_creation_input_tokens: 50 });
    expect(stats.cacheCreationTokens).toBe(50);
    expect(stats.totalRequests).toBe(1);
    expect(stats.hitRate()).toBe(0); // 0 / (0 + 50) = 0
  });

  it("hitRate calculation: 80 read + 20 creation = 80% hit rate", () => {
    const stats = new CacheStats();
    stats.recordUsage({ cache_read_input_tokens: 80, cache_creation_input_tokens: 20 });
    expect(stats.hitRate()).toBeCloseTo(0.8);
  });

  it("reset clears all counters", () => {
    const stats = new CacheStats();
    stats.recordUsage({ cache_read_input_tokens: 100, cache_creation_input_tokens: 50 });
    stats.recordUsage({ cache_read_input_tokens: 200 });
    expect(stats.totalRequests).toBe(2);

    stats.reset();
    expect(stats.cacheCreationTokens).toBe(0);
    expect(stats.cacheReadTokens).toBe(0);
    expect(stats.totalRequests).toBe(0);
    expect(stats.hitRate()).toBe(0);
  });
});
