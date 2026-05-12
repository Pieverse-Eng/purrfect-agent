import { z } from "zod";

export const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  main: z.string(),
  capabilities: z.object({
    tools: z.array(z.string()).optional(),
    hooks: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    providers: z.array(z.string()).optional(),
    contextEngines: z.array(z.string()).optional(),
  }),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
