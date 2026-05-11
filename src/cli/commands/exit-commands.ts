/**
 * Exit commands: /exit (aliases: quit, q)
 */

import type { CommandDef } from "./registry.js";

export const exitCommand: CommandDef = {
  name: "exit",
  description: "Exit the CLI",
  category: "Exit",
  aliases: ["quit", "q"],
  handler: async (_args, _ctx) => {
    process.exit(0);
  },
};
