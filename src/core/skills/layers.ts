import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config-schema.js";
import { SkillRegistry, type SkillLayerSource } from "./registry.js";

export interface SkillLayerOptions {
  configDir: string;
  config: Pick<Config, "skillsDir">;
  cwd?: string;
}

export interface RuntimeSkillRegistry {
  registry: SkillRegistry;
  skillsMap?: Map<string, string>;
  skillIndex?: string;
  personalDir: string;
  managedDir: string;
}

export function defaultSkillLayerSources(options: SkillLayerOptions): {
  sources: SkillLayerSource[];
  personalDir: string;
  managedDir: string;
} {
  const cwd = resolve(options.cwd ?? process.cwd());
  const projectRoot = findGitRoot(cwd) ?? cwd;
  const managedDir = join(options.configDir, "skills", "managed");
  const personalDir = options.config.skillsDir ?? join(options.configDir, "skills", "personal");

  return {
    managedDir,
    personalDir,
    sources: [
      { layer: "bundled", dir: join(options.configDir, "skills", "bundled") },
      { layer: "managed", dir: managedDir },
      { layer: "personal", dir: personalDir },
      { layer: "project", dir: join(projectRoot, ".purrfect", "skills") },
      { layer: "workspace", dir: join(cwd, ".purrfect", "skills") },
    ],
  };
}

export function loadRuntimeSkills(options: SkillLayerOptions): RuntimeSkillRegistry {
  const { sources, personalDir, managedDir } = defaultSkillLayerSources(options);
  const registry = new SkillRegistry();
  registry.discoverLayers(sources);
  const skillsMap = registry.buildSkillsMap();
  const skillIndex = registry.buildSkillIndex();
  return {
    registry,
    skillsMap: skillsMap.size > 0 ? skillsMap : undefined,
    skillIndex: skillIndex || undefined,
    personalDir,
    managedDir,
  };
}

function findGitRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
