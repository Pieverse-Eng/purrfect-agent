/**
 * InterruptController — manages AbortController lifecycle per agent run.
 *
 * On first SIGINT the current run's AbortController is aborted.
 * A second SIGINT within 1 second signals a force-exit.
 * After an interrupt the `interrupted` flag is set (the "[interrupted]" marker).
 * Calling `start()` resets the flag and returns a fresh AbortSignal.
 */

const FORCE_EXIT_WINDOW_MS = 1_000;

export class InterruptController {
  private controller: AbortController | null = null;
  private lastInterruptAt = 0;

  /** Whether the most recent run was interrupted. */
  interrupted = false;

  /**
   * Begin a new run. Returns the AbortSignal for the caller to pass into
   * fetch / stream helpers so they can be cancelled on SIGINT.
   */
  start(): AbortSignal {
    this.controller = new AbortController();
    this.interrupted = false;
    return this.controller.signal;
  }

  /**
   * Handle a SIGINT.
   *
   * - First call: aborts the current controller and sets the interrupted marker.
   * - Second call within `FORCE_EXIT_WINDOW_MS`: returns `"force-exit"`.
   *
   * @returns `"force-exit"` when a double-SIGINT is detected, `undefined` otherwise.
   */
  interrupt(): "force-exit" | undefined {
    const now = Date.now();

    if (now - this.lastInterruptAt < FORCE_EXIT_WINDOW_MS) {
      return "force-exit";
    }

    this.lastInterruptAt = now;
    this.interrupted = true;

    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
    }

    return undefined;
  }
}
