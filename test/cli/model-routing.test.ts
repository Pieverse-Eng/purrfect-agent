import { describe, it, expect, vi } from "vitest";
import { ModelRouter, type ModelRouterConfig } from "../../src/core/router.js";
import {
  CommandRegistry,
  type CommandContext,
} from "../../src/cli/commands/registry.js";
import { modelCommand } from "../../src/cli/commands/config-commands.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** Minimal mock fetch that never gets called (tests don't make requests). */
const noopFetch = vi.fn() as unknown as typeof fetch;

function makeRouterWithFallbacks(): ModelRouter {
  const cfg: ModelRouterConfig = {
    models: [
      {
        name: "gpt-4o",
        provider: "openai",
        config: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4o" },
      },
      {
        name: "claude-opus-4-20250514",
        provider: "anthropic",
        config: {
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "sk-ant-test",
          model: "claude-opus-4-20250514",
        },
      },
    ],
  };
  return new ModelRouter(cfg, noopFetch);
}

function createMockContext(
  router?: ModelRouter,
): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    config: { model: "gpt-4o" },
    router,
    output: (text: string) => lines.push(text),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Model routing integration", () => {
  it("ModelRouter created with primary + fallback returns primary as currentModel", () => {
    const router = makeRouterWithFallbacks();
    expect(router.currentModel()).toBe("gpt-4o");
  });

  it("switchModel changes the active model", () => {
    const router = makeRouterWithFallbacks();
    expect(router.currentModel()).toBe("gpt-4o");

    router.switchModel("claude-opus-4-20250514");
    expect(router.currentModel()).toBe("claude-opus-4-20250514");
  });

  it("/model with no args shows current model from router", async () => {
    const router = makeRouterWithFallbacks();
    router.switchModel("claude-opus-4-20250514");
    const ctx = createMockContext(router);

    await modelCommand.handler("", ctx);

    expect(ctx.lines).toHaveLength(1);
    expect(ctx.lines[0]).toContain("claude-opus-4-20250514");
  });

  it("/model with arg calls switchModel on router", async () => {
    const router = makeRouterWithFallbacks();
    const ctx = createMockContext(router);

    expect(router.currentModel()).toBe("gpt-4o");
    await modelCommand.handler("claude-opus-4-20250514", ctx);

    expect(router.currentModel()).toBe("claude-opus-4-20250514");
    expect(ctx.lines).toHaveLength(1);
    expect(ctx.lines[0]).toContain("Model switched to claude-opus-4-20250514");
  });
});
