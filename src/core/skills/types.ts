/** Definition of a skill loaded from a markdown file with YAML frontmatter. */
export type SkillLayer = "bundled" | "managed" | "personal" | "project" | "workspace";

export interface SkillDefinition {
  name: string;
  description: string;
  triggers: string[];
  tools: string[];
  contextFiles: string[];
  args?: string;
  body: string;
  sourceLayer?: SkillLayer;
  filePath?: string;
}
