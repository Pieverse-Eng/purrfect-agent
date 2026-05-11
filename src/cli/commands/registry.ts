export type CommandCategory =
  | "Session"
  | "Configuration"
  | "Tools & Skills"
  | "Info"
  | "Exit";

export interface LoadedPluginInfo {
  name: string;
  version: string;
  description: string;
  capabilities: Record<string, string[] | undefined>;
}

export interface ConnectedMcpInfo {
  name: string;
  toolCount: number;
}

export interface CommandContext {
  config: any;
  sessionStore?: any;
  sessionId?: string;
  toolRegistry?: any;
  skillRegistry?: any;
  rl?: any;
  commandRegistry?: CommandRegistry;
  memoriesDir?: string;
  router?: import("../../core/router.js").ModelRouter;
  loadedPlugins?: LoadedPluginInfo[];
  connectedMcpServers?: ConnectedMcpInfo[];
  output: (text: string) => void;
}

export interface CommandDef {
  name: string;
  description: string;
  category: CommandCategory;
  aliases: string[];
  argsHint?: string;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
}

export function parseSlashCommand(
  input: string,
): { name: string; args: string } | null {
  if (!input || !input.startsWith("/")) return null;
  const trimmed = input.slice(1);
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { name: trimmed, args: "" };
  return { name: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1) };
}

export class CommandRegistry {
  private commands: Map<string, CommandDef> = new Map();
  private aliasList: Map<string, string> = new Map();

  register(def: CommandDef): void {
    this.commands.set(def.name, def);
    for (const alias of def.aliases) {
      this.aliasList.set(alias, def.name);
    }
  }

  resolve(input: string): { command: CommandDef; args: string } | null {
    const parsed = parseSlashCommand(input);
    if (!parsed) return null;

    const { name, args } = parsed;
    const cmd =
      this.commands.get(name) ??
      (this.aliasList.has(name)
        ? this.commands.get(this.aliasList.get(name)!)
        : undefined);

    return cmd ? { command: cmd, args } : null;
  }

  getAll(): CommandDef[] {
    return [...this.commands.values()];
  }

  getByCategory(): Map<CommandCategory, CommandDef[]> {
    const grouped = new Map<CommandCategory, CommandDef[]>();
    for (const cmd of this.commands.values()) {
      let list = grouped.get(cmd.category);
      if (!list) {
        list = [];
        grouped.set(cmd.category, list);
      }
      list.push(cmd);
    }
    return grouped;
  }
}
