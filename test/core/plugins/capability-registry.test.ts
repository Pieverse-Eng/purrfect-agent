import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../../../src/core/plugins/capability-registry.js";
import { ToolRegistry } from "../../../src/core/tool-registry.js";
import { HookRegistry } from "../../../src/core/plugins/hooks.js";
import type { ToolDefinition } from "../../../src/core/types.js";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    schema: {
      type: "function" as const,
      function: { name, description: `Tool ${name}`, parameters: { type: "object", properties: {} } },
    },
    handler: async () => "ok",
  };
}

describe("CapabilityRegistry", () => {
  it("plugin with tools+commands → both registered", () => {
    const toolReg = new ToolRegistry();
    const hookReg = new HookRegistry();
    const capReg = new CapabilityRegistry(toolReg, hookReg);

    capReg.registerCapabilities("my-plugin", {
      tools: [makeTool("grep-tool")],
      commands: [{ name: "greet", description: "Say hello", run: () => {} }],
    });

    // Tool delegated to ToolRegistry
    expect(toolReg.getAllToolNames()).toContain("grep-tool");
    // Commands stored internally
    expect(capReg.getCommands()).toHaveLength(1);
    expect(capReg.getCommands()[0]).toMatchObject({ name: "greet" });
  });

  it("commands are queryable across multiple registrations", () => {
    const toolReg = new ToolRegistry();
    const hookReg = new HookRegistry();
    const capReg = new CapabilityRegistry(toolReg, hookReg);

    capReg.registerCapabilities("plugin-a", {
      commands: [{ name: "cmd-a", description: "A" }],
    });
    capReg.registerCapabilities("plugin-b", {
      commands: [{ name: "cmd-b", description: "B" }],
    });

    const cmds = capReg.getCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.name)).toEqual(["cmd-a", "cmd-b"]);
  });

  it("unknown capability type is silently ignored", () => {
    const toolReg = new ToolRegistry();
    const hookReg = new HookRegistry();
    const capReg = new CapabilityRegistry(toolReg, hookReg);

    // Pass an object with an unknown key via type assertion
    capReg.registerCapabilities("odd-plugin", {
      widgets: [{ id: 1 }],
    } as never);

    // Nothing blows up, no commands or providers stored
    expect(capReg.getCommands()).toHaveLength(0);
    expect(capReg.getProviders()).toHaveLength(0);
  });

  it("multiple plugins don't conflict", () => {
    const toolReg = new ToolRegistry();
    const hookReg = new HookRegistry();
    const capReg = new CapabilityRegistry(toolReg, hookReg);

    capReg.registerCapabilities("plugin-x", {
      tools: [makeTool("tool-x")],
      commands: [{ name: "cmd-x", description: "X" }],
      providers: ["openai"],
    });
    capReg.registerCapabilities("plugin-y", {
      tools: [makeTool("tool-y")],
      commands: [{ name: "cmd-y", description: "Y" }],
      providers: ["anthropic"],
    });

    expect(toolReg.getAllToolNames()).toContain("tool-x");
    expect(toolReg.getAllToolNames()).toContain("tool-y");
    expect(capReg.getCommands()).toHaveLength(2);
    expect(capReg.getProviders()).toHaveLength(2);
  });

  it("tracks all capability types (tools, hooks, commands, providers, contextEngines)", async () => {
    const toolReg = new ToolRegistry();
    const hookReg = new HookRegistry();
    const capReg = new CapabilityRegistry(toolReg, hookReg);

    capReg.registerCapabilities("full-plugin", {
      tools: [makeTool("full-tool")],
      hooks: { before_prompt: () => {} },
      commands: [{ name: "full-cmd", description: "cmd" }],
      providers: ["custom-provider"],
      contextEngines: ["git-engine"],
    });

    // Tools delegated
    expect(toolReg.getAllToolNames()).toContain("full-tool");
    // Hooks delegated
    await hookReg.fire("before_prompt", {});
    // Commands stored
    expect(capReg.getCommands()).toHaveLength(1);
    // Providers stored
    expect(capReg.getProviders()).toEqual([
      { pluginName: "full-plugin", provider: "custom-provider" },
    ]);
    // Context engines stored (future use)
    expect(capReg.getContextEngines()).toEqual([
      { pluginName: "full-plugin", engine: "git-engine" },
    ]);
  });
});
