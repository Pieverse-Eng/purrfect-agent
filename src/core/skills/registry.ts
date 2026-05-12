import { readdirSync, writeFileSync, unlinkSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { SkillDefinition, SkillLayer } from "./types.js";
import { SkillLoader } from "./loader.js";

export const SKILL_LAYER_ORDER: SkillLayer[] = [
  "bundled",
  "managed",
  "personal",
  "project",
  "workspace",
];

export interface SkillLayerSource {
  layer: SkillLayer;
  dir: string;
}

/**
 * Discovers and indexes skills from directories.
 * Skills are indexed by name and trigger patterns for dispatch.
 */
export class SkillRegistry {
  private readonly byName = new Map<string, SkillDefinition>();
  private readonly byTrigger = new Map<string, SkillDefinition>();

  /**
   * Discover all .md skill files in the given directory.
   * Files are processed in sorted order; later calls overwrite earlier entries
   * (enabling local-takes-precedence over external).
   */
  discover(dirPath: string, options: { layer?: SkillLayer } = {}): void {
    const layer = options.layer ?? "workspace";
    for (const filePath of collectSkillFiles(dirPath)) {
      const skill = SkillLoader.load(filePath);
      if (!skill) continue;
      this.setSkill({ ...skill, sourceLayer: layer, filePath });
    }
  }

  /** Discover all configured skill layers using canonical precedence. */
  discoverLayers(
    sources:
      | SkillLayerSource[]
      | Partial<Record<SkillLayer, string | string[]>>,
  ): void {
    const normalized = Array.isArray(sources)
      ? sources
      : Object.entries(sources).flatMap(([layer, dirs]) =>
          (Array.isArray(dirs) ? dirs : dirs ? [dirs] : []).map((dir) => ({
            layer: layer as SkillLayer,
            dir,
          })),
        );

    const rank = (layer: SkillLayer) => SKILL_LAYER_ORDER.indexOf(layer);
    for (const source of normalized.sort((a, b) => rank(a.layer) - rank(b.layer))) {
      this.discover(source.dir, { layer: source.layer });
    }
  }

  /**
   * Dispatch by exact skill name or trigger pattern.
   * Returns a copy of the SkillDefinition with optional args attached, or null.
   */
  dispatch(nameOrTrigger: string, args?: string): SkillDefinition | null {
    const skill = this.byName.get(nameOrTrigger) ?? this.byTrigger.get(nameOrTrigger) ?? null;
    if (!skill) return null;

    return { ...skill, args };
  }

  /** Return all registered skill names. */
  getAllSkillNames(): string[] {
    return this.getAllSkills().map((skill) => skill.name);
  }

  /** Return all registered skill definitions. */
  getAllSkills(): SkillDefinition[] {
    return [...this.byName.values()].sort(compareSkillPriority);
  }

  /** Build a Map<trigger, body> suitable for AgentLoop's skillRegistry option. */
  buildSkillsMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const skill of this.getAllSkills()) {
      // Index by name
      map.set(skill.name, skill.body);
      // Index by each trigger
      for (const trigger of skill.triggers) {
        map.set(trigger, skill.body);
      }
    }
    return map;
  }

  /** Build a concise skill index (name + description) for system prompt. */
  buildSkillIndex(): string {
    const skills = this.getAllSkills();
    if (skills.length === 0) return "";
    const lines = skills.map((s) => {
      const layer = s.sourceLayer ? ` [${s.sourceLayer}]` : "";
      return `- ${s.name}: ${s.description || "(no description)"}${layer}`;
    });
    return `Available skills:\n${lines.join("\n")}`;
  }

  // ── Runtime CRUD ────────────────────────────────────────────────────

  /**
   * Validate that a skill name does not contain path separators or traversal sequences.
   * This prevents names like `../foo`, `subdir/bar`, or `..\\foo` from escaping the skills directory.
   */
  private validateNameSafe(name: string): void {
    if (/[/\\]/.test(name) || name === ".." || name.startsWith("..")) {
      throw new Error(
        `Skill name must not contain path separators or '..' (got '${name}')`,
      );
    }
  }

  /**
   * Create a new skill and write it to disk.
   * Returns the created SkillDefinition.
   */
  create(
    skillsDir: string,
    name: string,
    description: string,
    body: string,
    options?: { triggers?: string[] },
  ): SkillDefinition {
    this.validateNameSafe(name);
    if (name.length > 64) {
      throw new Error(`Skill name must be ≤64 characters (got ${name.length})`);
    }
    if (description.length > 1024) {
      throw new Error(`Skill description must be ≤1024 characters (got ${description.length})`);
    }
    if (this.byName.has(name)) {
      throw new Error(`Skill '${name}' already exists`);
    }

    const triggers = options?.triggers ?? [];
    const content = this.serializeSkill({ name, description, triggers, body });

    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
    const filePath = join(skillsDir, `${name}.md`);
    writeFileSync(filePath, content, "utf-8");

    const skill: SkillDefinition = {
      name,
      description,
      triggers,
      tools: [],
      contextFiles: [],
      body,
      sourceLayer: "personal",
      filePath,
    };

    this.setSkill(skill);

    return skill;
  }

  /**
   * Update an existing skill's body, description, or triggers.
   * Rebuilds the trigger index from all skills so that shared triggers
   * remain correctly mapped after the update.
   */
  update(
    skillsDir: string,
    name: string,
    updates: { body?: string; description?: string; triggers?: string[] },
  ): SkillDefinition {
    this.validateNameSafe(name);
    const existing = this.byName.get(name);
    if (!existing) {
      throw new Error(`Skill '${name}' not found`);
    }

    const updated: SkillDefinition = {
      ...existing,
      body: updates.body ?? existing.body,
      description: updates.description ?? existing.description,
      triggers: updates.triggers ?? existing.triggers,
    };

    const content = this.serializeSkill(updated);
    const filePath = join(skillsDir, `${name}.md`);
    writeFileSync(filePath, content, "utf-8");

    this.setSkill(updated);

    return updated;
  }

  /**
   * Remove a skill by name.
   * Rebuilds the trigger index from remaining skills so that shared triggers
   * are not accidentally removed from a different skill that still owns them.
   */
  remove(skillsDir: string, name: string): void {
    this.validateNameSafe(name);
    const existing = this.byName.get(name);
    if (!existing) {
      throw new Error(`Skill '${name}' not found`);
    }

    const filePath = join(skillsDir, `${name}.md`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    this.byName.delete(name);
    this.rebuildTriggerIndex();
  }

  /**
   * Rebuild the trigger index from all currently registered skills.
   * This ensures shared triggers always point to the correct (last-registered) owner
   * after any mutation (update, remove).
   */
  private rebuildTriggerIndex(): void {
    this.byTrigger.clear();
    for (const skill of this.getAllSkills().reverse()) {
      for (const trigger of skill.triggers) {
        this.byTrigger.set(trigger, skill);
      }
    }
  }

  private setSkill(skill: SkillDefinition): void {
    this.byName.set(skill.name, skill);
    this.rebuildTriggerIndex();
  }

  private serializeSkill(skill: { name: string; description: string; triggers: string[]; body: string }): string {
    const metadata: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    };
    if (skill.triggers.length > 0) {
      metadata.triggers = skill.triggers;
    }
    const yamlStr = YAML.stringify(metadata).trimEnd();
    return `---\n${yamlStr}\n---\n\n${skill.body}\n`;
  }
}

function collectSkillFiles(dirPath: string): string[] {
  const result: string[] = [];

  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile() && entry.endsWith(".md")) {
        result.push(fullPath);
      }
    }
  };

  visit(dirPath);
  return result;
}

function compareSkillPriority(a: SkillDefinition, b: SkillDefinition): number {
  const aRank = a.sourceLayer ? SKILL_LAYER_ORDER.indexOf(a.sourceLayer) : SKILL_LAYER_ORDER.length - 1;
  const bRank = b.sourceLayer ? SKILL_LAYER_ORDER.indexOf(b.sourceLayer) : SKILL_LAYER_ORDER.length - 1;
  if (aRank !== bRank) return bRank - aRank;
  return a.name.localeCompare(b.name);
}
