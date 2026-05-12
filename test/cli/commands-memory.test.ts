import { describe, it, expect, afterEach } from "vitest";
import { createTempDir } from "../helpers/fixtures.js";
import { CommandRegistry, type CommandContext } from "../../src/cli/commands/registry.js";
import { memoryCommand } from "../../src/cli/commands/memory-commands.js";
import { MemoryStore } from "../../src/core/memory/store.js";

function createMockContext(memoriesDir?: string): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    config: {},
    memoriesDir,
    output: (text: string) => lines.push(text),
  };
}

describe("Memory commands", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("/memory with no args shows snapshot content", async () => {
    const tmp = createTempDir("mem-test-");
    cleanup = tmp.cleanup;

    const store = new MemoryStore(tmp.path);
    store.add("project", "purrfect is a CLI agent");
    store.add("style", "Use TypeScript strict mode");

    const ctx = createMockContext(tmp.path);
    await memoryCommand.handler("", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("2 entries");
    expect(output).toContain("project");
    expect(output).toContain("purrfect is a CLI agent");
  });

  it("/memory add tag content adds entry", async () => {
    const tmp = createTempDir("mem-test-");
    cleanup = tmp.cleanup;

    const ctx = createMockContext(tmp.path);
    await memoryCommand.handler("add myTag some important content", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("Added memory entry: myTag");

    // Verify it was actually persisted
    const store = new MemoryStore(tmp.path);
    const snapshot = store.getSnapshot();
    expect(snapshot).toContain("myTag");
    expect(snapshot).toContain("some important content");
  });

  it("/memory remove tag removes entry", async () => {
    const tmp = createTempDir("mem-test-");
    cleanup = tmp.cleanup;

    const store = new MemoryStore(tmp.path);
    store.add("keep", "staying");
    store.add("drop", "going away");

    const ctx = createMockContext(tmp.path);
    await memoryCommand.handler("remove drop", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("Removed memory entry: drop");

    const snapshot = store.getSnapshot();
    expect(snapshot).toContain("keep");
    expect(snapshot).not.toContain("drop");
  });

  it("/memory list shows tags only", async () => {
    const tmp = createTempDir("mem-test-");
    cleanup = tmp.cleanup;

    const store = new MemoryStore(tmp.path);
    store.add("alpha", "first entry content");
    store.add("beta", "second entry content");

    const ctx = createMockContext(tmp.path);
    await memoryCommand.handler("list", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("2");
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    // Content should NOT appear in list view
    expect(output).not.toContain("first entry content");
    expect(output).not.toContain("second entry content");
  });

  it("/memory with empty memory shows 'No memory entries'", async () => {
    const tmp = createTempDir("mem-test-");
    cleanup = tmp.cleanup;

    const ctx = createMockContext(tmp.path);
    await memoryCommand.handler("", ctx);

    const output = ctx.lines.join("\n");
    expect(output).toContain("No memory entries");
  });
});
