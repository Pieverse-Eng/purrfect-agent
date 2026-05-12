import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { AwesomeCliError } from "../../src/core/errors.js";
import type { ToolDefinition } from "../../src/core/types.js";

function makeTool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `A ${name} tool`,
    schema: {
      type: "function",
      function: {
        name,
        description: `A ${name} tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async () => JSON.stringify({ ok: true }),
    ...overrides,
  };
}

describe("ToolRegistry: register and dispatch", () => {
  it("registers a tool and dispatches it", async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("alpha"));
    const result = JSON.parse(await reg.dispatch("alpha", {}));
    expect(result).toEqual({ ok: true });
  });

  it("dispatch passes args to handler", async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool("echo", {
        handler: async (args) => JSON.stringify(args),
      }),
    );
    const result = JSON.parse(await reg.dispatch("echo", { msg: "hi" }));
    expect(result).toEqual({ msg: "hi" });
  });

  it("dispatch with unknown tool returns error JSON", async () => {
    const reg = new ToolRegistry();
    const result = JSON.parse(await reg.dispatch("nonexistent", {}));
    expect(result.error).toContain("Unknown tool");
  });

  it("handler exception returns error JSON", async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool("bad", {
        handler: async () => {
          throw new Error("boom");
        },
      }),
    );
    const result = JSON.parse(await reg.dispatch("bad", {}));
    expect(result.error).toContain("boom");
  });
});

describe("ToolRegistry: getDefinitions", () => {
  it("returns OpenAI function format", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("t1"));
    reg.register(makeTool("t2"));

    const defs = reg.getDefinitions(["t1", "t2"]);
    expect(defs).toHaveLength(2);
    expect(defs.every((d) => d.type === "function")).toBe(true);
    const names = new Set(defs.map((d) => d.function.name));
    expect(names).toEqual(new Set(["t1", "t2"]));
  });

  it("skips tools where checkFn returns false", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("available", { checkFn: () => true }));
    reg.register(makeTool("unavailable", { checkFn: () => false }));

    const defs = reg.getDefinitions(["available", "unavailable"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("available");
  });

  it("caches shared checkFn results within single getDefinitions call", () => {
    const reg = new ToolRegistry();
    let callCount = 0;
    const sharedCheck = () => {
      callCount++;
      return true;
    };

    reg.register(makeTool("first", { checkFn: sharedCheck }));
    reg.register(makeTool("second", { checkFn: sharedCheck }));

    const defs = reg.getDefinitions(["first", "second"]);
    expect(defs).toHaveLength(2);
    expect(callCount).toBe(1);
  });

  it("skips tools where checkFn throws (does not crash)", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("ok_tool", { checkFn: () => true }));
    reg.register(
      makeTool("bad_tool", {
        checkFn: () => {
          throw new Error("network down");
        },
      }),
    );

    const defs = reg.getDefinitions(["ok_tool", "bad_tool"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("ok_tool");
  });

  it("returns all tools when no filter provided", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("a"));
    reg.register(makeTool("b"));

    const defs = reg.getDefinitions();
    expect(defs).toHaveLength(2);
  });
});

describe("ToolRegistry: deregister", () => {
  it("removes a tool from the registry", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("temp"));
    expect(reg.getDefinitions(["temp"])).toHaveLength(1);

    reg.deregister("temp");
    expect(reg.getDefinitions(["temp"])).toHaveLength(0);
  });

  it("deregister of unknown tool does not throw", () => {
    const reg = new ToolRegistry();
    expect(() => reg.deregister("ghost")).not.toThrow();
  });
});

describe("ToolRegistry: toolset composition", () => {
  it("defineToolset and resolveToolset groups tools", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("file_read", { toolset: "files" }));
    reg.register(makeTool("file_write", { toolset: "files" }));
    reg.register(makeTool("shell_exec", { toolset: "terminal" }));

    reg.defineToolset("coding", ["files", "terminal"]);
    const resolved = reg.resolveToolset("coding");
    expect(new Set(resolved)).toEqual(
      new Set(["file_read", "file_write", "shell_exec"]),
    );
  });

  it("resolveToolset with unknown name returns empty array", () => {
    const reg = new ToolRegistry();
    expect(reg.resolveToolset("nonexistent")).toEqual([]);
  });
});

describe("ToolRegistry: toolset availability", () => {
  it("toolset with no checkFn is available", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("t", { toolset: "free" }));
    expect(reg.isToolsetAvailable("free")).toBe(true);
  });

  it("toolset with failing checkFn is unavailable", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("t", { toolset: "locked", checkFn: () => false }));
    expect(reg.isToolsetAvailable("locked")).toBe(false);
  });

  it("toolset checkFn exception treated as unavailable", () => {
    const reg = new ToolRegistry();
    reg.register(
      makeTool("t", {
        toolset: "broken",
        checkFn: () => {
          throw new Error("fail");
        },
      }),
    );
    expect(reg.isToolsetAvailable("broken")).toBe(false);
  });
});

describe("ToolRegistry: getAllToolNames", () => {
  it("returns sorted tool names", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("z_tool"));
    reg.register(makeTool("a_tool"));
    expect(reg.getAllToolNames()).toEqual(["a_tool", "z_tool"]);
  });
});

describe("ToolRegistry: built-in tool protection", () => {
  it("registerBuiltin marks tool as reserved", () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(makeTool("shell_exec"));
    expect(reg.isReserved("shell_exec")).toBe(true);
    // Non-builtin tools are not reserved
    expect(reg.isReserved("custom_tool")).toBe(false);
  });

  it("registerBuiltin tool is dispatchable", async () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(makeTool("file_read"));
    const result = JSON.parse(await reg.dispatch("file_read", {}));
    expect(result).toEqual({ ok: true });
  });

  it("register() with reserved name throws AwesomeCliError", () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(makeTool("shell_exec"));
    expect(() => reg.register(makeTool("shell_exec"))).toThrowError(
      AwesomeCliError,
    );
    expect(() => reg.register(makeTool("shell_exec"))).toThrow(
      "Cannot overwrite built-in tool: shell_exec",
    );
  });

  it("register() allows non-reserved names", () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(makeTool("shell_exec"));
    expect(() => reg.register(makeTool("my_custom_tool"))).not.toThrow();
  });
});
