import { describe, it, expect, vi } from "vitest";
import { createMemoryTool } from "../../../src/core/tools/memory.js";
import type { MemoryBackend } from "../../../src/core/memory/backend.js";

function makeBackend(initial: Map<string, string> = new Map()): {
  backend: MemoryBackend;
  state: Map<string, string>;
} {
  const state = new Map(initial);
  const snapshotOf = () =>
    [...state.entries()].map(([t, c]) => `§ ${t}\n${c}`).join("\n\n");

  const backend: MemoryBackend = {
    async add(tag, content) {
      state.set(tag, content);
    },
    async replace(tag, content) {
      if (state.has(tag)) state.set(tag, content);
    },
    async remove(tag) {
      state.delete(tag);
    },
    async getSnapshot() {
      return snapshotOf();
    },
    async getLiveSnapshot() {
      return snapshotOf();
    },
  };
  return { backend, state };
}

describe("memory tool with injected backend", () => {
  it("write add path stores new entry", async () => {
    const { backend, state } = makeBackend();
    const tool = createMemoryTool({ backend });
    const result = await tool.handler({ action: "write", key: "note", value: "hi" });
    expect(JSON.parse(result)).toEqual({ success: true });
    expect(state.get("note")).toBe("hi");
  });

  it("write replace path updates existing entry", async () => {
    const { backend, state } = makeBackend(new Map([["note", "old"]]));
    const tool = createMemoryTool({ backend });
    await tool.handler({ action: "write", key: "note", value: "new" });
    expect(state.get("note")).toBe("new");
  });

  it("read returns live snapshot", async () => {
    const { backend } = makeBackend(new Map([["a", "1"], ["b", "2"]]));
    const tool = createMemoryTool({ backend });
    const result = JSON.parse(await tool.handler({ action: "read", key: "ignored" }));
    expect(result.snapshot).toContain("§ a\n1");
    expect(result.snapshot).toContain("§ b\n2");
  });

  it("remove deletes entry", async () => {
    const { backend, state } = makeBackend(new Map([["note", "x"]]));
    const tool = createMemoryTool({ backend });
    await tool.handler({ action: "remove", key: "note" });
    expect(state.has("note")).toBe(false);
  });

  it("returns error JSON when backend throws", async () => {
    const backend: MemoryBackend = {
      add: vi.fn().mockRejectedValue(new Error("upstream down")),
      replace: vi.fn(),
      remove: vi.fn(),
      getSnapshot: vi.fn().mockResolvedValue(""),
      getLiveSnapshot: vi.fn().mockResolvedValue(""),
    };
    const tool = createMemoryTool({ backend });
    const result = JSON.parse(
      await tool.handler({ action: "write", key: "k", value: "v" }),
    );
    expect(result.error).toContain("upstream down");
  });
});
