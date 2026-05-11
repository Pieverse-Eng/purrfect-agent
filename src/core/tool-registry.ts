import type { ToolDefinition, ToolSchema } from "./types.js";
import { AwesomeCliError } from "./errors.js";

interface ToolEntry {
  definition: ToolDefinition;
  enabled: boolean;
}

/**
 * Central tool registry. Mirrors hermes-agent tools/registry.py pattern.
 * Each test should create a fresh instance (not a singleton).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly toolsets = new Map<string, string[]>();
  private readonly reservedNames = new Set<string>();

  /**
   * Register a built-in tool and mark its name as reserved.
   * Reserved names cannot be overwritten by external tools.
   */
  registerBuiltin(definition: ToolDefinition): void {
    this.tools.set(definition.name, { definition, enabled: true });
    this.reservedNames.add(definition.name);
  }

  register(definition: ToolDefinition): void {
    if (this.reservedNames.has(definition.name)) {
      throw new AwesomeCliError(
        `Cannot overwrite built-in tool: ${definition.name}`,
      );
    }
    this.tools.set(definition.name, { definition, enabled: true });
  }

  isReserved(name: string): boolean {
    return this.reservedNames.has(name);
  }

  deregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Apply enablement state to currently-registered tools. Names not present
   * in the registry are ignored. Used at boot to hydrate config-persisted
   * disabled-tool overrides.
   */
  applyEnablement(state: Record<string, boolean>): void {
    for (const [name, enabled] of Object.entries(state)) {
      const entry = this.tools.get(name);
      if (entry) entry.enabled = enabled;
    }
  }

  /** Mark a tool as enabled. Returns false when no such tool exists. */
  enable(name: string): boolean {
    const entry = this.tools.get(name);
    if (!entry) return false;
    entry.enabled = true;
    return true;
  }

  /** Mark a tool as disabled. Returns false when no such tool exists. */
  disable(name: string): boolean {
    const entry = this.tools.get(name);
    if (!entry) return false;
    entry.enabled = false;
    return true;
  }

  isEnabled(name: string): boolean {
    return this.tools.get(name)?.enabled ?? false;
  }

  /** List tool names plus their enablement state. Sorted alphabetically. */
  listEnablement(): Array<{ name: string; enabled: boolean }> {
    return [...this.tools.entries()]
      .map(([name, entry]) => ({ name, enabled: entry.enabled }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const entry = this.tools.get(name);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    if (!entry.enabled) {
      return JSON.stringify({ error: `Tool disabled: ${name}` });
    }
    try {
      return await entry.definition.handler(args);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? `${err.constructor.name}: ${err.message}`
          : String(err);
      return JSON.stringify({ error: message });
    }
  }

  /**
   * Returns OpenAI function-calling format schemas for the given tools.
   * Filters by enablement and checkFn availability. Caches shared checkFn
   * results within a single call (mirrors hermes pattern).
   */
  getDefinitions(toolNames?: string[]): ToolSchema[] {
    const checkCache = new Map<Function, boolean>();
    const results: ToolSchema[] = [];

    for (const [name, entry] of this.tools) {
      if (toolNames && !toolNames.includes(name)) continue;
      if (!entry.enabled) continue;

      const { checkFn } = entry.definition;
      if (checkFn) {
        let available: boolean;
        if (checkCache.has(checkFn)) {
          available = checkCache.get(checkFn)!;
        } else {
          try {
            available = checkFn();
          } catch {
            available = false;
          }
          checkCache.set(checkFn, available);
        }
        if (!available) continue;
      }

      results.push(entry.definition.schema);
    }

    return results;
  }

  defineToolset(name: string, memberToolsets: string[]): void {
    this.toolsets.set(name, memberToolsets);
  }

  /**
   * Resolve a composed toolset to individual tool names.
   * Member toolsets refer to the `toolset` field on registered tools.
   */
  resolveToolset(name: string): string[] {
    const members = this.toolsets.get(name);
    if (!members) return [];

    const result: string[] = [];
    for (const [toolName, entry] of this.tools) {
      if (
        entry.definition.toolset &&
        members.includes(entry.definition.toolset)
      ) {
        result.push(toolName);
      }
    }
    return result;
  }

  isToolsetAvailable(toolsetName: string): boolean {
    for (const [, entry] of this.tools) {
      if (entry.definition.toolset !== toolsetName) continue;
      const { checkFn } = entry.definition;
      if (!checkFn) return true;
      try {
        if (checkFn()) return true;
      } catch {
        // checkFn threw — treat as unavailable
      }
    }
    return false;
  }

  getAllToolNames(): string[] {
    return [...this.tools.keys()].sort();
  }
}
