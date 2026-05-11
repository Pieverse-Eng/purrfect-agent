/**
 * Command registration — registers all 12 built-in commands.
 */

import type { CommandRegistry } from "./registry.js";

import { newSessionCommand, clearCommand, historyCommand } from "./session-commands.js";
import { helpCommand, toolsCommand, skillsCommand, sessionsCommand, doctorCommand, infoCommand } from "./info-commands.js";
import { modelCommand, configCommand } from "./config-commands.js";
import { exitCommand } from "./exit-commands.js";
import { memoryCommand } from "./memory-commands.js";
import { todosCommand } from "./todo-commands.js";
import { pluginsCommand, mcpCommand } from "./extension-commands.js";
import { costCommand } from "./cost-commands.js";

export function registerAllCommands(registry: CommandRegistry): void {
  // Session
  registry.register(newSessionCommand);
  registry.register(clearCommand);
  registry.register(historyCommand);
  registry.register(todosCommand);

  // Info
  registry.register(helpCommand);
  registry.register(toolsCommand);
  registry.register(skillsCommand);
  registry.register(sessionsCommand);
  registry.register(doctorCommand);
  registry.register(infoCommand);
  registry.register(costCommand);

  // Configuration
  registry.register(modelCommand);
  registry.register(configCommand);

  // Tools & Skills
  registry.register(memoryCommand);
  registry.register(pluginsCommand);
  registry.register(mcpCommand);

  // Exit
  registry.register(exitCommand);
}

export { newSessionCommand, clearCommand, historyCommand } from "./session-commands.js";
export { helpCommand, toolsCommand, skillsCommand, sessionsCommand, doctorCommand, infoCommand } from "./info-commands.js";
export { modelCommand, configCommand } from "./config-commands.js";
export { exitCommand } from "./exit-commands.js";
export { memoryCommand } from "./memory-commands.js";
export { todosCommand } from "./todo-commands.js";
export { pluginsCommand, mcpCommand } from "./extension-commands.js";
export { costCommand } from "./cost-commands.js";
