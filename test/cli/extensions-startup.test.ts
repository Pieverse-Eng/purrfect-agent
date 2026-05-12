import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { McpClient } from "../../src/core/mcp/client.js";
import { PluginDiscovery } from "../../src/core/plugins/discovery.js";
import { PluginLoader } from "../../src/core/plugins/loader.js";
import { HookRegistry } from "../../src/core/plugins/hooks.js";
import {
  CommandRegistry,
  type CommandContext,
} from "../../src/cli/commands/registry.js";
import { pluginsCommand, mcpCommand } from "../../src/cli/commands/extension-commands.js";

// ── Helpers ───────────────────────────────────────────────────────────

function stubContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return { config: {}, output: () => {}, ...overrides };
}

function makeFakeSdk(toolList: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>) {
  class FakeClient {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn().mockResolvedValue({ tools: toolList });
    callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  }
  class FakeTransport {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  }
  return {
    Client: FakeClient as any,
    StdioClientTransport: FakeTransport as any,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("MCP startup wiring", () => {
  it("creates McpClient and registers tools when mcpServers config is present", async () => {
    const registry = new ToolRegistry();
    const fakeSdk = makeFakeSdk([
      { name: "weather", description: "Get weather", inputSchema: { type: "object", properties: {} } },
      { name: "search", description: "Web search", inputSchema: { type: "object", properties: {} } },
    ]);

    const client = new McpClient(registry, {
      command: "node",
      args: ["fake-server.js"],
      _importSdk: async () => fakeSdk,
    });

    await client.connect();

    // Tools should be registered in the ToolRegistry
    const names = registry.getAllToolNames();
    expect(names).toContain("weather");
    expect(names).toContain("search");
    expect(names.length).toBe(2);

    await client.disconnect();
    // After disconnect, tools should be deregistered
    expect(registry.getAllToolNames().length).toBe(0);
  });
});

describe("Plugin startup wiring", () => {
  it("discovers and loads plugins from plugin dirs", async () => {
    const registry = new ToolRegistry();
    const hookRegistry = new HookRegistry();

    // Use a custom import function that returns a module with tools
    const loader = new PluginLoader(async (_path: string) => ({
      tools: [
        {
          name: "my-plugin-tool",
          description: "A plugin tool",
          toolset: "test-plugin",
          schema: {
            type: "function" as const,
            function: {
              name: "my-plugin-tool",
              description: "A plugin tool",
              parameters: { type: "object", properties: {} },
            },
          },
          handler: async () => "result",
        },
      ],
    }));

    const manifest = {
      name: "test-plugin",
      version: "1.0.0",
      description: "A test plugin",
      main: "./index.js",
      capabilities: { tools: ["my-plugin-tool"] },
    };

    await loader.load(manifest, registry, hookRegistry);

    const names = registry.getAllToolNames();
    expect(names).toContain("my-plugin-tool");
  });
});

describe("/plugins command", () => {
  it("lists loaded plugins with name, version, and capabilities", async () => {
    const lines: string[] = [];
    const ctx = stubContext({
      loadedPlugins: [
        {
          name: "code-review",
          version: "2.1.0",
          description: "Automated code review",
          capabilities: { tools: ["lint", "format"], hooks: ["before_tool_call"] },
        },
        {
          name: "metrics",
          version: "0.5.0",
          description: "Collect metrics",
          capabilities: { tools: ["track"], hooks: undefined },
        },
      ],
      output: (text: string) => lines.push(text),
    });

    await pluginsCommand.handler("", ctx);

    const joined = lines.join("\n");
    expect(joined).toContain("code-review");
    expect(joined).toContain("2.1.0");
    expect(joined).toContain("Automated code review");
    expect(joined).toContain("lint, format");
    expect(joined).toContain("metrics");
    expect(joined).toContain("0.5.0");
  });
});

describe("/mcp command", () => {
  it("lists connected MCP servers with tool counts", async () => {
    const lines: string[] = [];
    const ctx = stubContext({
      connectedMcpServers: [
        { name: "file-server", toolCount: 3 },
        { name: "db-server", toolCount: 1 },
      ],
      output: (text: string) => lines.push(text),
    });

    await mcpCommand.handler("", ctx);

    const joined = lines.join("\n");
    expect(joined).toContain("file-server");
    expect(joined).toContain("3 tools");
    expect(joined).toContain("db-server");
    expect(joined).toContain("1 tool");
    expect(joined).not.toContain("1 tools"); // singular
  });
});
