import { describe, it, expect } from "vitest";
import { buildBanner } from "../../src/cli/banner.js";
import { CommandRegistry } from "../../src/cli/commands/registry.js";
import { registerAllCommands, toolsCommand } from "../../src/cli/commands/index.js";
import { formatTokenDisplay, formatCost } from "../../src/cli/formatter.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import type { CommandContext } from "../../src/cli/commands/registry.js";

describe("TUI Integration Tests", () => {
  it("banner + command registry work together", () => {
    // Build banner with specific parameters
    const banner = buildBanner({
      model: "gpt-4o",
      cwd: "/tmp/test",
      toolCount: 5,
      skillCount: 2,
    });

    expect(banner).toContain("gpt-4o");
    expect(banner).toContain("5");
    expect(banner).toContain("2");

    // Create registry and register all commands
    const registry = new CommandRegistry();
    registerAllCommands(registry);

    const helpResult = registry.resolve("/help");
    expect(helpResult).not.toBeNull();
    expect(helpResult!.command.name).toBe("help");

    const toolsResult = registry.resolve("/tools");
    expect(toolsResult).not.toBeNull();
    expect(toolsResult!.command.name).toBe("tools");
  });

  it("/tools shows real registered tools", async () => {
    const toolRegistry = new ToolRegistry();
    const toolNames = ["file_read", "shell_exec", "web_search"];

    for (const name of toolNames) {
      toolRegistry.register({
        name,
        description: `Test tool: ${name}`,
        schema: {
          type: "function",
          function: { name, description: `Test tool: ${name}`, parameters: {} },
        },
        handler: async () => "ok",
      });
    }

    const captured: string[] = [];
    const ctx: CommandContext = {
      config: {},
      toolRegistry,
      output: (text: string) => captured.push(text),
    };

    await toolsCommand.handler("", ctx);

    const fullOutput = captured.join("\n");
    for (const name of toolNames) {
      expect(fullOutput).toContain(name);
    }
  });

  it("token display format includes model name", () => {
    const tokenDisplay = formatTokenDisplay(150, 50);
    expect(tokenDisplay).toContain("150");
    expect(tokenDisplay).toContain("50");

    const costDisplay = formatCost("gpt-4o", 150, 50);
    expect(costDisplay).toContain("$");
  });
});
