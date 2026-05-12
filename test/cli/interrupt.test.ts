import { describe, it, expect, beforeEach } from "vitest";
import { InterruptController } from "../../src/cli/interrupt.js";

describe("InterruptController", () => {
  let ctrl: InterruptController;

  beforeEach(() => {
    ctrl = new InterruptController();
  });

  it("provides a unique AbortController per run", () => {
    const a = ctrl.start();
    const b = ctrl.start();
    expect(a).not.toBe(b);
    // each should be an AbortSignal
    expect(a).toBeInstanceOf(AbortSignal);
    expect(b).toBeInstanceOf(AbortSignal);
  });

  it("creates a fresh (non-aborted) controller after an interrupt", () => {
    const first = ctrl.start();
    ctrl.interrupt(); // simulate SIGINT
    expect(first.aborted).toBe(true);

    const second = ctrl.start();
    expect(second.aborted).toBe(false);
  });

  it("double SIGINT within 1 s triggers force-exit flag", () => {
    ctrl.start();
    ctrl.interrupt();
    const result = ctrl.interrupt(); // second, within window
    expect(result).toBe("force-exit");
  });

  it("exposes [interrupted] marker after an interrupt", () => {
    ctrl.start();
    expect(ctrl.interrupted).toBe(false);

    ctrl.interrupt();
    expect(ctrl.interrupted).toBe(true);

    // marker resets on next start()
    ctrl.start();
    expect(ctrl.interrupted).toBe(false);
  });
});
