import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import type { ToolDefinition } from "../../src/core/types.js";

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    schema: {
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {}, required: [] } },
    },
    handler: async () => JSON.stringify({ ran: name }),
  };
}

describe("ToolRegistry enable/disable", () => {
  it("disables tools so dispatch returns an error envelope", async () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("t1"));
    expect(reg.disable("t1")).toBe(true);
    const out = await reg.dispatch("t1", {});
    expect(JSON.parse(out)).toEqual({ error: "Tool disabled: t1" });
  });

  it("disabled tools are filtered out of getDefinitions", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("a"));
    reg.register(fakeTool("b"));
    reg.disable("a");
    const defs = reg.getDefinitions();
    expect(defs.map((d) => d.function.name)).toEqual(["b"]);
  });

  it("enable re-activates a tool", async () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("x"));
    reg.disable("x");
    reg.enable("x");
    const out = await reg.dispatch("x", {});
    expect(JSON.parse(out)).toEqual({ ran: "x" });
  });

  it("applyEnablement rehydrates persisted overrides", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("foo"));
    reg.register(fakeTool("bar"));
    reg.applyEnablement({ foo: false, missing: false });
    expect(reg.isEnabled("foo")).toBe(false);
    expect(reg.isEnabled("bar")).toBe(true);
  });

  it("listEnablement returns sorted name+enabled rows", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("zeta"));
    reg.register(fakeTool("alpha"));
    reg.disable("alpha");
    expect(reg.listEnablement()).toEqual([
      { name: "alpha", enabled: false },
      { name: "zeta", enabled: true },
    ]);
  });
});
