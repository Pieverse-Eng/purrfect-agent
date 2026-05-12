/**
 * Configuration commands: /model, /config
 */

import type { CommandDef } from "./registry.js";

function redactApiKey(key: string): string {
  if (!key || key.length < 8) return "****";
  return `sk-...${key.slice(-4)}`;
}

export const modelCommand: CommandDef = {
  name: "model",
  description: "Show or switch the current model",
  category: "Configuration",
  aliases: [],
  argsHint: "[model-name]",
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      const current = ctx.router
        ? ctx.router.currentModel()
        : ctx.config?.model ?? "unknown";
      ctx.output(`Current model: ${current}`);
      return;
    }
    if (ctx.router) {
      ctx.router.switchModel(trimmed);
    }
    ctx.output(`Model switched to ${trimmed}`);
  },
};

export const configCommand: CommandDef = {
  name: "config",
  description: "Show current configuration",
  category: "Configuration",
  aliases: [],
  handler: async (_args, ctx) => {
    const cfg = ctx.config ?? {};
    const display: Record<string, string> = {};
    for (const [key, value] of Object.entries(cfg)) {
      if (key === "apiKey" || key === "api_key") {
        display[key] = redactApiKey(String(value));
      } else {
        display[key] = String(value);
      }
    }
    ctx.output("Configuration:\n");
    for (const [key, value] of Object.entries(display)) {
      ctx.output(`  ${key}: ${value}`);
    }
  },
};
