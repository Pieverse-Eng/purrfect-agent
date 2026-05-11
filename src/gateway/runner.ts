/**
 * GatewayRunner — starts and stops platform adapters based on config.
 *
 * Adapters are injected (not created internally) to allow testing
 * without real platform connections.
 */

import type { BaseAdapter } from "./adapter.js";
import type { GatewayConfig } from "./config.js";

// ---------------------------------------------------------------------------
// GatewayRunner
// ---------------------------------------------------------------------------

export class GatewayRunner {
  readonly config: GatewayConfig;
  private readonly adapters = new Map<string, BaseAdapter>();
  private running = false;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Register an adapter for a platform name.
   * Must be called before `start()`.
   */
  addAdapter(platform: string, adapter: BaseAdapter): void {
    this.adapters.set(platform, adapter);
  }

  /**
   * Connect all registered adapters.
   */
  async start(): Promise<void> {
    if (this.running) return;

    const connectPromises: Promise<void>[] = [];
    for (const [, adapter] of this.adapters) {
      connectPromises.push(adapter.connect());
    }
    await Promise.all(connectPromises);
    this.running = true;
  }

  /**
   * Disconnect all registered adapters.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    const disconnectPromises: Promise<void>[] = [];
    for (const [, adapter] of this.adapters) {
      disconnectPromises.push(adapter.disconnect());
    }
    await Promise.all(disconnectPromises);
    this.running = false;
  }

  /** Whether the runner is currently connected. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Get a registered adapter by platform name. */
  getAdapter(platform: string): BaseAdapter | undefined {
    return this.adapters.get(platform);
  }
}
