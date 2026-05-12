import type { ToolRegistry } from "../tool-registry.js";
import type { HookRegistry } from "./hooks.js";
import type { ToolDefinition } from "../types.js";

export interface CommandDefinition {
  name: string;
  description: string;
  run?: (...args: unknown[]) => unknown;
}

export interface ProviderEntry {
  pluginName: string;
  provider: string;
}

export interface ContextEngineEntry {
  pluginName: string;
  engine: string;
}

export interface PluginCapabilities {
  tools?: ToolDefinition[];
  hooks?: Record<string, (...args: unknown[]) => void | Promise<void>>;
  commands?: CommandDefinition[];
  providers?: string[];
  contextEngines?: string[];
}

/**
 * Unified registry that tracks every capability type a plugin can expose.
 *
 * - **tools** are delegated to the existing ToolRegistry.
 * - **hooks** are delegated to the existing HookRegistry.
 * - **commands** are stored internally as CommandDefinition[].
 * - **providers** and **contextEngines** are stored for future use.
 */
export class CapabilityRegistry {
  private readonly toolRegistry: ToolRegistry;
  private readonly hookRegistry: HookRegistry;
  private readonly commands: CommandDefinition[] = [];
  private readonly providers: ProviderEntry[] = [];
  private readonly contextEngines: ContextEngineEntry[] = [];

  constructor(toolRegistry: ToolRegistry, hookRegistry: HookRegistry) {
    this.toolRegistry = toolRegistry;
    this.hookRegistry = hookRegistry;
  }

  registerCapabilities(pluginName: string, capabilities: PluginCapabilities): void {
    // Tools → delegate to ToolRegistry
    if (capabilities.tools) {
      for (const tool of capabilities.tools) {
        this.toolRegistry.register({ ...tool, toolset: pluginName });
      }
    }

    // Hooks → delegate to HookRegistry
    if (capabilities.hooks) {
      for (const [event, handler] of Object.entries(capabilities.hooks)) {
        this.hookRegistry.register(event, handler);
      }
    }

    // Commands → store internally
    if (capabilities.commands) {
      this.commands.push(...capabilities.commands);
    }

    // Providers → store for future use
    if (capabilities.providers) {
      for (const provider of capabilities.providers) {
        this.providers.push({ pluginName, provider });
      }
    }

    // Context engines → store for future use
    if (capabilities.contextEngines) {
      for (const engine of capabilities.contextEngines) {
        this.contextEngines.push({ pluginName, engine });
      }
    }
  }

  getCommands(): CommandDefinition[] {
    return this.commands;
  }

  getProviders(): ProviderEntry[] {
    return this.providers;
  }

  getContextEngines(): ContextEngineEntry[] {
    return this.contextEngines;
  }
}
