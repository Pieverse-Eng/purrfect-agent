import { describe, it, expect, vi } from "vitest";
import { PluginLoader } from "../../../src/core/plugins/loader.js";
import { ToolRegistry } from "../../../src/core/tool-registry.js";
import { HookRegistry } from "../../../src/core/plugins/hooks.js";
import type { PluginManifest } from "../../../src/core/plugins/manifest.js";
import type { ToolDefinition } from "../../../src/core/types.js";

function makeTool(name: string): ToolDefinition {
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
  };
}

const manifest: PluginManifest = {
  name: "my-plugin",
  version: "1.0.0",
  description: "Test plugin",
  main: "./plugin.js",
  capabilities: { tools: ["file_read", "custom_tool"] },
};

describe("PluginLoader: built-in tool protection", () => {
  it("plugin tool conflicting with built-in is namespaced with plugin:{name}: prefix", async () => {
    const toolRegistry = new ToolRegistry();
    const hookRegistry = new HookRegistry();

    // Register a built-in tool
    toolRegistry.registerBuiltin(makeTool("file_read"));

    const pluginTools = [makeTool("file_read"), makeTool("custom_tool")];

    const importFn = vi.fn().mockResolvedValue({ tools: pluginTools });
    const loader = new PluginLoader(importFn);

    await loader.load(manifest, toolRegistry, hookRegistry);

    const names = toolRegistry.getAllToolNames();
    // Built-in is preserved, conflicting plugin tool is namespaced
    expect(names).toContain("file_read");
    expect(names).toContain("plugin:my-plugin:file_read");
    expect(names).toContain("custom_tool");
  });

  it("plugin tool with no conflict registers with original name", async () => {
    const toolRegistry = new ToolRegistry();
    const hookRegistry = new HookRegistry();

    const pluginTools = [makeTool("unique_tool")];

    const importFn = vi.fn().mockResolvedValue({ tools: pluginTools });
    const loader = new PluginLoader(importFn);

    await loader.load(manifest, toolRegistry, hookRegistry);

    const names = toolRegistry.getAllToolNames();
    expect(names).toContain("unique_tool");
    expect(names).not.toContain("plugin:my-plugin:unique_tool");
  });
});
