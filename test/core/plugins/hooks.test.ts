import { describe, it, expect, vi } from "vitest";
import { HookRegistry } from "../../../src/core/plugins/hooks.js";
import { PluginLoader } from "../../../src/core/plugins/loader.js";
import { ToolRegistry } from "../../../src/core/tool-registry.js";
import type { PluginManifest } from "../../../src/core/plugins/manifest.js";

describe("HookRegistry", () => {
  it("register hook → fire event → handler called with correct data", async () => {
    const registry = new HookRegistry();
    const handler = vi.fn();

    registry.register("before_tool_call", handler);
    await registry.fire("before_tool_call", { tool: "grep", args: {} });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ tool: "grep", args: {} });
  });

  it("multiple hooks for same event → all fire in registration order", async () => {
    const registry = new HookRegistry();
    const order: number[] = [];

    registry.register("after_response", () => order.push(1));
    registry.register("after_response", () => order.push(2));
    registry.register("after_response", () => order.push(3));

    await registry.fire("after_response", {});

    expect(order).toEqual([1, 2, 3]);
  });

  it("hook throws → error caught, other hooks still fire", async () => {
    const registry = new HookRegistry();
    const results: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.register("on_error", () => results.push("first"));
    registry.register("on_error", () => {
      throw new Error("boom");
    });
    registry.register("on_error", () => results.push("third"));

    await registry.fire("on_error", { error: "something" });

    expect(results).toEqual(["first", "third"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("boom");

    warnSpy.mockRestore();
  });

  it("fire event with no registered hooks → no error", async () => {
    const registry = new HookRegistry();

    // Should not throw
    await registry.fire("before_prompt", { prompt: "hello" });
  });
});

describe("PluginLoader", () => {
  it("load plugin with tools → tools registered in ToolRegistry", async () => {
    const toolRegistry = new ToolRegistry();
    const hookRegistry = new HookRegistry();

    const fakeModule = {
      tools: [
        {
          name: "my-tool",
          description: "A plugin tool",
          schema: {
            type: "function" as const,
            function: {
              name: "my-tool",
              description: "A plugin tool",
              parameters: { type: "object", properties: {} },
            },
          },
          handler: async () => "ok",
        },
      ],
    };

    const manifest: PluginManifest = {
      name: "test-plugin",
      version: "1.0.0",
      description: "Test",
      main: "index.js",
      capabilities: { tools: ["my-tool"] },
    };

    const loader = new PluginLoader((/* _path */) => Promise.resolve(fakeModule));
    await loader.load(manifest, toolRegistry, hookRegistry);

    expect(toolRegistry.getAllToolNames()).toContain("my-tool");
    // Tool should have the plugin name as toolset
    const defs = toolRegistry.getDefinitions(["my-tool"]);
    expect(defs).toHaveLength(1);
  });

  it("plugin with no hooks → loads fine, tools registered", async () => {
    const toolRegistry = new ToolRegistry();
    const hookRegistry = new HookRegistry();

    const fakeModule = {
      tools: [
        {
          name: "another-tool",
          description: "Another tool",
          schema: {
            type: "function" as const,
            function: {
              name: "another-tool",
              description: "Another tool",
              parameters: { type: "object", properties: {} },
            },
          },
          handler: async () => "result",
        },
      ],
      // no hooks property at all
    };

    const manifest: PluginManifest = {
      name: "no-hooks-plugin",
      version: "0.1.0",
      description: "Plugin without hooks",
      main: "index.js",
      capabilities: { tools: ["another-tool"] },
    };

    const loader = new PluginLoader(() => Promise.resolve(fakeModule));
    await loader.load(manifest, toolRegistry, hookRegistry);

    expect(toolRegistry.getAllToolNames()).toContain("another-tool");
  });
});
