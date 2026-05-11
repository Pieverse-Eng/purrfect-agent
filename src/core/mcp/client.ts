import type { ToolRegistry } from "../tool-registry.js";
import type { ToolDefinition } from "../types.js";
import { VERSION } from "../../version.js";

/**
 * Shape we expect from the dynamically-imported MCP SDK.
 * Keeps the rest of the code decoupled from the SDK's actual types.
 */
interface McpSdk {
  Client: new (info: { name: string; version: string }) => McpSdkClient;
  StdioClientTransport: new (params: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }) => McpTransport;
}

interface McpSdkClient {
  connect(transport: McpTransport): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    toolResult?: unknown;
  }>;
  setNotificationHandler?(schema: unknown, handler: () => void): void;
}

interface McpTransport {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * If provided, only tools whose names appear in this list are registered
   * with the agent's ToolRegistry. Empty array = no tools exposed; absent
   * = expose every tool the server advertises (default behavior).
   */
  enabledTools?: string[];
  /** Override for testing — inject a fake SDK module instead of dynamic import. */
  _importSdk?: () => Promise<McpSdk>;
}

const MCP_TOOLSET = "mcp";

export class McpClient {
  private readonly registry: ToolRegistry;
  private readonly options: McpClientOptions;
  private sdkClient: McpSdkClient | null = null;
  private transport: McpTransport | null = null;
  /** Track tool names we registered so we can nuke-and-repave. */
  private registeredToolNames: string[] = [];

  constructor(registry: ToolRegistry, options: McpClientOptions) {
    this.registry = registry;
    this.options = options;
  }

  async connect(): Promise<void> {
    const sdk = await this.loadSdk();

    const transport = new sdk.StdioClientTransport({
      command: this.options.command,
      args: this.options.args,
      env: this.options.env,
    });
    this.transport = transport;

    const client = new sdk.Client({
      name: "purrfect",
      version: VERSION,
    });
    this.sdkClient = client;

    try {
      await client.connect(transport);
      await this.refreshTools();
    } catch (err) {
      // Clean up transport and client references on failed connect
      await this.transport.close().catch(() => {});
      this.transport = null;
      this.sdkClient = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.deregisterAll();
    if (this.sdkClient) {
      await this.sdkClient.close();
      this.sdkClient = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }

  /**
   * Nuke-and-repave: deregister all previously registered MCP tools,
   * then re-discover and register the current set from the server.
   */
  async refreshTools(): Promise<void> {
    if (!this.sdkClient) {
      throw new Error("McpClient is not connected");
    }

    this.deregisterAll();

    const { tools } = await this.sdkClient.listTools();

    const allowed = this.options.enabledTools
      ? new Set(this.options.enabledTools)
      : null;

    for (const tool of tools) {
      if (allowed && !allowed.has(tool.name)) continue;
      // If the tool name collides with a reserved built-in, prefix with "mcp:"
      const registeredName = this.registry.isReserved(tool.name)
        ? `mcp:${tool.name}`
        : tool.name;

      const definition: ToolDefinition = {
        name: registeredName,
        description: tool.description ?? "",
        toolset: MCP_TOOLSET,
        schema: {
          type: "function",
          function: {
            name: registeredName,
            description: tool.description ?? "",
            parameters: tool.inputSchema,
          },
        },
        handler: async (args: Record<string, unknown>) => {
          // Always call the MCP server with the original tool name
          return this.callTool(tool.name, args);
        },
      };

      this.registry.register(definition);
      this.registeredToolNames.push(registeredName);
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.sdkClient) {
      return JSON.stringify({ error: "MCP client is not connected" });
    }

    const result = await this.sdkClient.callTool({
      name,
      arguments: args,
    });

    // Extract text content from the MCP response
    if (!result.content) {
      return JSON.stringify(result.toolResult ?? result);
    }

    const textParts = result.content
      .filter((c) => c.type === "text" && c.text !== undefined)
      .map((c) => c.text!);

    return textParts.join("\n") || JSON.stringify(result.content);
  }

  private deregisterAll(): void {
    for (const name of this.registeredToolNames) {
      this.registry.deregister(name);
    }
    this.registeredToolNames = [];
  }

  private async loadSdk(): Promise<McpSdk> {
    const importer = this.options._importSdk ?? defaultImportSdk;
    try {
      return await importer();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `MCP SDK not available. Install @modelcontextprotocol/sdk to use MCP features. (${msg})`,
      );
    }
  }
}

async function defaultImportSdk(): Promise<McpSdk> {
  const [clientMod, stdioMod] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  return {
    Client: clientMod.Client,
    StdioClientTransport: stdioMod.StdioClientTransport,
  };
}

// ── Probe (used by `purrfect mcp test` / `mcp configure`) ────────────────

export interface McpProbeOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Override for testing — inject a fake SDK. */
  _importSdk?: () => Promise<McpSdk>;
}

export interface McpProbeTool {
  name: string;
  description: string;
}

export interface McpProbeResult {
  ok: true;
  tools: McpProbeTool[];
  elapsed_ms: number;
}

export interface McpProbeFailure {
  ok: false;
  error: string;
  elapsed_ms: number;
}

/**
 * Diagnostic probe: connect to an MCP server, list its tools, and
 * disconnect. Does NOT register tools into any ToolRegistry. Used by the
 * `purrfect mcp test` CLI to verify a server is reachable and by
 * `mcp configure` to enumerate tools for selection.
 */
export async function probeMcpServer(
  options: McpProbeOptions,
): Promise<McpProbeResult | McpProbeFailure> {
  const start = Date.now();
  const importer = options._importSdk ?? defaultImportSdk;

  let sdk: McpSdk;
  try {
    sdk = await importer();
  } catch (err) {
    return {
      ok: false,
      error: `MCP SDK unavailable: ${err instanceof Error ? err.message : String(err)}`,
      elapsed_ms: Date.now() - start,
    };
  }

  const transport = new sdk.StdioClientTransport({
    command: options.command,
    args: options.args,
    env: options.env,
  });

  const client = new sdk.Client({ name: "purrfect-probe", version: VERSION });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return {
      ok: true,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
      elapsed_ms: Date.now() - start,
    };
  } catch (err) {
    try {
      await transport.close();
    } catch {
      // best-effort
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - start,
    };
  }
}
