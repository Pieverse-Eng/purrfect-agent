import type { ToolDefinition } from "../types.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface SkillManageToolOptions {
  skillRegistry: SkillRegistry;
  skillsDir: string;
}

export function createSkillManageTool(options: SkillManageToolOptions): ToolDefinition {
  const { skillRegistry, skillsDir } = options;

  return {
    name: "skill_manage",
    description: "Create, update, remove, list, or view skills at runtime.",
    schema: {
      type: "function",
      function: {
        name: "skill_manage",
        description: "Create, update, remove, list, or view skills at runtime.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "patch", "remove", "list", "view"],
              description: "Action to perform.",
            },
            name: {
              type: "string",
              description: "Skill name (required for create/patch/remove/view).",
            },
            description: {
              type: "string",
              description: "Skill description (required for create, optional for patch).",
            },
            body: {
              type: "string",
              description: "Skill markdown body (required for create, optional for patch).",
            },
            triggers: {
              type: "array",
              items: { type: "string" },
              description: "Trigger phrases (optional).",
            },
          },
          required: ["action"],
        },
      },
    },
    toolset: "skills",
    async handler(args) {
      const action = args.action as string;

      try {
        switch (action) {
          case "list": {
            const skills = skillRegistry.getAllSkills();
            const items = skills.map((s) => ({
              name: s.name,
              description: s.description,
              triggers: s.triggers,
            }));
            return JSON.stringify({ skills: items });
          }

          case "view": {
            const name = args.name as string;
            if (!name) return JSON.stringify({ error: "name is required for view" });
            const skill = skillRegistry.dispatch(name);
            if (!skill) return JSON.stringify({ error: `Skill '${name}' not found` });
            return JSON.stringify({
              name: skill.name,
              description: skill.description,
              triggers: skill.triggers,
              body: skill.body,
            });
          }

          case "create": {
            const name = args.name as string;
            const description = args.description as string;
            const body = args.body as string;
            if (!name || !description || !body) {
              return JSON.stringify({
                error: "name, description, and body are required for create",
              });
            }
            const triggers = (args.triggers as string[] | undefined) ?? [];
            const skill = skillRegistry.create(skillsDir, name, description, body, { triggers });
            return JSON.stringify({ success: true, skill: { name: skill.name, description: skill.description } });
          }

          case "patch": {
            const name = args.name as string;
            if (!name) return JSON.stringify({ error: "name is required for patch" });
            const updates: { body?: string; description?: string; triggers?: string[] } = {};
            if (args.body) updates.body = args.body as string;
            if (args.description) updates.description = args.description as string;
            if (args.triggers) updates.triggers = args.triggers as string[];
            const skill = skillRegistry.update(skillsDir, name, updates);
            return JSON.stringify({ success: true, skill: { name: skill.name, description: skill.description } });
          }

          case "remove": {
            const name = args.name as string;
            if (!name) return JSON.stringify({ error: "name is required for remove" });
            skillRegistry.remove(skillsDir, name);
            return JSON.stringify({ success: true });
          }

          default:
            return JSON.stringify({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: message });
      }
    },
  };
}
