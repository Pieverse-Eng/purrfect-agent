import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../../src/core/tool-registry.js";

/**
 * We mock the MCP SDK so tests never spawn real servers.
 * The McpClient uses dynamic import internally — we intercept that.
 */

function makeMockTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((err: Error) => void) | undefined,
    onmessage: undefined as ((msg: unknown) => void) | undefined,
  };
}

function makeMockClient(tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []) {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"result":"ok"}' }],
    }),
    setNotificationHandler: vi.fn(),
  };
  return client;
}

/** Build a fake SDK module for dynamic import mocking */
function buildSdkModule(
  clientInstance: ReturnType<typeof makeMockClient>,
  transportInstance: ReturnType<typeof makeMockTransport>,
) {
  return {
    Client: vi.fn().mockImplementation(function (this: any) {
      Object.assign(this, clientInstance);
      return this;
    }),
    StdioClientTransport: vi.fn().mockImplementation(function (this: any) {
      Object.assign(this, transportInstance);
      return this;
    }),
  };
}

describe("McpClient", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("connect -> discover tools -> tools appear in registry with correct schemas", async () => {
    const mockTools = [
      {
        name: "mcp_weather",
        description: "Get weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      {
        name: "mcp_calendar",
        description: "List events",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ];

    const mockClient = makeMockClient(mockTools);
    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await mcp.connect();

    const names = registry.getAllToolNames();
    expect(names).toContain("mcp_weather");
    expect(names).toContain("mcp_calendar");
    expect(names).toHaveLength(2);

    // Check schema shape
    const defs = registry.getDefinitions(["mcp_weather"]);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("mcp_weather");
    expect(defs[0].function.description).toBe("Get weather");
    expect(defs[0].function.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  it("tool dispatch -> forwarded to MCP -> result returned as JSON string", async () => {
    const mockTools = [
      {
        name: "mcp_search",
        description: "Search",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ];

    const mockClient = makeMockClient(mockTools);
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: '{"hits":42}' }],
    });

    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await mcp.connect();

    const result = await registry.dispatch("mcp_search", { q: "hello" });
    expect(result).toBe('{"hits":42}');

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "mcp_search",
      arguments: { q: "hello" },
    });
  });

  it("tool list update -> old deregistered, new registered (nuke-and-repave)", async () => {
    const initialTools = [
      {
        name: "mcp_old_tool",
        description: "Old",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const mockClient = makeMockClient(initialTools);
    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await mcp.connect();
    expect(registry.getAllToolNames()).toContain("mcp_old_tool");

    // Simulate tool list change: server now has different tools
    const updatedTools = [
      {
        name: "mcp_new_tool",
        description: "New",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    mockClient.listTools.mockResolvedValue({ tools: updatedTools });

    await mcp.refreshTools();

    expect(registry.getAllToolNames()).not.toContain("mcp_old_tool");
    expect(registry.getAllToolNames()).toContain("mcp_new_tool");
    expect(registry.getAllToolNames()).toHaveLength(1);
  });

  it("MCP SDK not installed -> graceful error, feature disabled", async () => {
    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => {
        throw new Error("Cannot find module '@modelcontextprotocol/sdk/client/index.js'");
      },
    });

    await expect(mcp.connect()).rejects.toThrow(/MCP SDK/);

    // Registry unaffected
    expect(registry.getAllToolNames()).toEqual([]);
  });

  it("server connection failure -> error logged, other tools unaffected", async () => {
    // Pre-register a non-MCP tool
    registry.register({
      name: "builtin_tool",
      description: "A builtin",
      schema: {
        type: "function",
        function: {
          name: "builtin_tool",
          description: "A builtin",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => JSON.stringify({ ok: true }),
    });

    const mockClient = makeMockClient();
    mockClient.connect.mockRejectedValue(new Error("Connection refused"));

    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await expect(mcp.connect()).rejects.toThrow("Connection refused");

    // Builtin tool still works fine
    expect(registry.getAllToolNames()).toEqual(["builtin_tool"]);
    const result = JSON.parse(await registry.dispatch("builtin_tool", {}));
    expect(result).toEqual({ ok: true });
  });

  it("server with no tools -> empty registration, no crash", async () => {
    const mockClient = makeMockClient([]); // no tools
    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await mcp.connect();

    expect(registry.getAllToolNames()).toEqual([]);
    // Disconnect should also work fine
    await mcp.disconnect();
  });

  it("disconnect() closes the transport", async () => {
    const mockClient = makeMockClient([]);
    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await mcp.connect();
    await mcp.disconnect();

    expect(mockTransport.close).toHaveBeenCalled();
    expect(mockClient.close).toHaveBeenCalled();
  });

  it("failed connect() cleans up transport", async () => {
    const mockClient = makeMockClient();
    mockClient.connect.mockRejectedValue(new Error("Connection refused"));

    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await expect(mcp.connect()).rejects.toThrow("Connection refused");

    // Transport should have been closed during cleanup
    expect(mockTransport.close).toHaveBeenCalled();
  });

  it("MCP tool conflicting with built-in is namespaced with mcp: prefix", async () => {
    // Register a built-in tool first
    registry.registerBuiltin({
      name: "file_read",
      description: "Built-in file reader",
      schema: {
        type: "function",
        function: {
          name: "file_read",
          description: "Built-in file reader",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => JSON.stringify({ source: "builtin" }),
    });

    const mockTools = [
      {
        name: "file_read",
        description: "MCP file reader",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "mcp_unique",
        description: "A unique MCP tool",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const mockClient = makeMockClient(mockTools);
    const mockTransport = makeMockTransport();
    const sdkModule = buildSdkModule(mockClient, mockTransport);

    const { McpClient } = await import("../../../src/core/mcp/client.js");
    const mcp = new McpClient(registry, {
      command: "fake-server",
      args: [],
      _importSdk: async () => sdkModule as any,
    });

    await mcp.connect();

    const names = registry.getAllToolNames();
    // Built-in is preserved, conflicting MCP tool is namespaced
    expect(names).toContain("file_read");
    expect(names).toContain("mcp:file_read");
    expect(names).toContain("mcp_unique");

    // Built-in handler is unchanged
    const builtinResult = JSON.parse(await registry.dispatch("file_read", {}));
    expect(builtinResult).toEqual({ source: "builtin" });

    // Namespaced MCP tool dispatches correctly to MCP server
    await registry.dispatch("mcp:file_read", {});
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "file_read",
      arguments: {},
    });
  });
});
