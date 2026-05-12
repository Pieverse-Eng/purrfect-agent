import type { PluginManifest } from "./manifest.js";
import type { HookRegistry } from "./hooks.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { ToolDefinition } from "../types.js";

export interface PluginModule {
  tools?: ToolDefinition[];
  hooks?: Record<string, (...args: unknown[]) => void | Promise<void>>;
  commands?: unknown[];
}

type ImportFn = (path: string) => Promise<PluginModule>;

/**
 * Loads a plugin from its manifest by dynamic-importing its main module.
 * Registers exported tools into ToolRegistry (with the plugin name as
 * toolset) and hooks into HookRegistry.
 */
export class PluginLoader {
  private readonly importFn: ImportFn;

  constructor(importFn?: ImportFn) {
    this.importFn = importFn ?? ((path: string) => import(path) as Promise<PluginModule>);
  }

  async load(
    manifest: PluginManifest,
    toolRegistry: ToolRegistry,
    hookRegistry: HookRegistry,
  ): Promise<void> {
    const mod = await this.importFn(manifest.main);

    // Register tools with plugin name as toolset
    if (mod.tools) {
      for (const tool of mod.tools) {
        // If the tool name collides with a reserved built-in, prefix with "plugin:{pluginName}:"
        const registeredName = toolRegistry.isReserved(tool.name)
          ? `plugin:${manifest.name}:${tool.name}`
          : tool.name;

        toolRegistry.register({
          ...tool,
          name: registeredName,
          toolset: manifest.name,
          schema: {
            ...tool.schema,
            function: {
              ...tool.schema.function,
              name: registeredName,
            },
          },
        });
      }
    }

    // Register hooks
    if (mod.hooks) {
      for (const [event, handler] of Object.entries(mod.hooks)) {
        hookRegistry.register(event, handler);
      }
    }
  }
}
