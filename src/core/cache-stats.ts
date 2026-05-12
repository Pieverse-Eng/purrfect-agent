/**
 * Tracks Anthropic prompt-caching token usage across requests.
 */
export interface CacheUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export class CacheStats {
  cacheCreationTokens = 0;
  cacheReadTokens = 0;
  totalRequests = 0;

  /** Record token usage from a single API response. */
  recordUsage(usage: CacheUsage): void {
    this.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    this.totalRequests += 1;
  }

  /**
   * Cache hit rate: cacheRead / (cacheRead + cacheCreation).
   * Returns 0 when no tokens have been tracked.
   */
  hitRate(): number {
    const total = this.cacheReadTokens + this.cacheCreationTokens;
    if (total === 0) return 0;
    return this.cacheReadTokens / total;
  }

  /** Reset all counters to zero. */
  reset(): void {
    this.cacheCreationTokens = 0;
    this.cacheReadTokens = 0;
    this.totalRequests = 0;
  }
}
