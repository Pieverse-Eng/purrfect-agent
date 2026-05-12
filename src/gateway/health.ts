/**
 * HealthMonitor — tracks per-adapter connection state and metrics.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdapterHealth {
  platform: string;
  connected: boolean;
  uptime: number;
  messageCount: number;
  lastError?: string;
  reconnectAttempts: number;
}

// ---------------------------------------------------------------------------
// HealthMonitor
// ---------------------------------------------------------------------------

export class HealthMonitor {
  private readonly states = new Map<string, AdapterHealth>();
  private readonly connectTimes = new Map<string, number>();

  /** Ensure an entry exists for `platform`. */
  private ensure(platform: string): AdapterHealth {
    let state = this.states.get(platform);
    if (!state) {
      state = {
        platform,
        connected: false,
        uptime: 0,
        messageCount: 0,
        reconnectAttempts: 0,
      };
      this.states.set(platform, state);
    }
    return state;
  }

  /** Record a successful connection. */
  recordConnect(platform: string): void {
    const state = this.ensure(platform);
    state.connected = true;
    state.reconnectAttempts = 0;
    this.connectTimes.set(platform, Date.now());
  }

  /** Record a disconnection. */
  recordDisconnect(platform: string): void {
    const state = this.ensure(platform);
    state.connected = false;
    const connectTime = this.connectTimes.get(platform);
    if (connectTime) {
      state.uptime += Date.now() - connectTime;
      this.connectTimes.delete(platform);
    }
  }

  /** Record an inbound message. */
  recordMessage(platform: string): void {
    const state = this.ensure(platform);
    state.messageCount += 1;
  }

  /** Record an error. */
  recordError(platform: string, error: string): void {
    const state = this.ensure(platform);
    state.lastError = error;
    state.reconnectAttempts += 1;
  }

  /** Return a snapshot of all adapter states. */
  getSnapshot(): AdapterHealth[] {
    // Update uptime for currently-connected adapters
    const now = Date.now();
    for (const [platform, state] of this.states) {
      if (state.connected) {
        const connectTime = this.connectTimes.get(platform);
        if (connectTime) {
          state.uptime += now - connectTime;
          this.connectTimes.set(platform, now);
        }
      }
    }
    return Array.from(this.states.values()).map((s) => ({ ...s }));
  }

  /**
   * Calculate exponential backoff delay for reconnection.
   * @param attempts   Number of consecutive failed attempts.
   * @param baseMs     Base delay in ms (default 5 000).
   * @param maxMs      Maximum delay in ms (default 300 000).
   * @param factor     Exponential factor (default 2).
   */
  static calculateBackoff(
    attempts: number,
    baseMs: number = 5000,
    maxMs: number = 300000,
    factor: number = 2,
  ): number {
    const delay = baseMs * Math.pow(factor, attempts);
    return Math.min(delay, maxMs);
  }
}
