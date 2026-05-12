import { RateLimitError, NetworkError } from "./errors.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // ms
}

/**
 * Retry policy with exponential backoff.
 * Only retries RateLimitError and NetworkError.
 */
export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelay: number;

  constructor(options: RetryOptions) {
    this.maxRetries = options.maxRetries;
    this.baseDelay = options.baseDelay;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!this.isRetryable(err)) throw err;
        lastError = err as Error;
        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  private isRetryable(err: unknown): boolean {
    return err instanceof RateLimitError || err instanceof NetworkError;
  }
}
