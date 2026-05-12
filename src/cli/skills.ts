import { SkillHub } from "../core/skills/hub.js";
import { SkillRegistry } from "../core/skills/registry.js";
import { defaultSkillLayerSources } from "../core/skills/layers.js";
import { loadConfigV2, defaultConfigDir } from "./config.js";

export interface SkillsCommandContext {
  configDir?: string;
  output?: (line: string) => void;
}

export async function skillsCommand(
  args: string,
  context: SkillsCommandContext = {},
): Promise<void> {
  const configDir = context.configDir ?? defaultConfigDir();
  const output = context.output ?? ((line: string) => console.log(line));
  const tokens = tokenize(args);
  const action = tokens[0] ?? "list";
  const config = loadConfigV2(configDir);
  const { managedDir, sources } = defaultSkillLayerSources({ configDir, config });
  const hub = new SkillHub({ configDir, managedDir });

  switch (action) {
    case "tap": {
      const sub = tokens[1] ?? "list";
      if (sub === "add") {
        const name = required(tokens[2], "tap name");
        const url = required(tokens[3], "tap url");
        hub.addTap(name, url);
        output(`Tap added: ${name}`);
      } else if (sub === "remove") {
        const name = required(tokens[2], "tap name");
        output(hub.removeTap(name) ? `Tap removed: ${name}` : `Tap not found: ${name}`);
      } else {
        const taps = hub.listTaps();
        if (taps.length === 0) {
          output("No taps configured.");
        } else {
          for (const tap of taps) output(`${tap.name} ${tap.url}`);
        }
      }
      break;
    }
    case "browse": {
      const skills = hub.browse();
      printTapSkills(skills, output);
      break;
    }
    case "search": {
      const query = required(tokens[1], "query");
      printTapSkills(hub.search(query), output);
      break;
    }
    case "install": {
      if (tokens[1] === "--all") {
        const available = hub.browse();
        if (available.length === 0) {
          output("No skills found in registered taps.");
          break;
        }
        let installed = 0;
        let failed = 0;
        for (const skill of available) {
          try {
            hub.install(skill.name, { tap: skill.tap });
            installed++;
          } catch (err) {
            failed++;
            output(`Skipped ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        output(`Installed ${installed}${failed > 0 ? `, skipped ${failed}` : ""}.`);
        break;
      }
      const name = required(tokens[1], "skill name");
      const skill = hub.install(name, { tap: readOption(tokens, "--tap") });
      output(`Installed: ${skill.name}`);
      break;
    }
    case "inspect": {
      const name = required(tokens[1], "skill name");
      const skill = hub.inspect(name);
      output(`${skill.name}: ${skill.description}`);
      if (skill.triggers.length > 0) output(`Triggers: ${skill.triggers.join(", ")}`);
      output(skill.body);
      break;
    }
    case "list": {
      const registry = new SkillRegistry();
      registry.discoverLayers(sources);
      const skills = registry.getAllSkills();
      if (skills.length === 0) {
        output("No skills installed.");
      } else {
        for (const skill of skills) {
          const layer = skill.sourceLayer ? ` [${skill.sourceLayer}]` : "";
          const desc = skill.description ? ` — ${skill.description}` : "";
          output(`${skill.name}${layer}${desc}`);
        }
      }
      break;
    }
    case "check": {
      const results = hub.check(tokens[1]);
      if (results.length === 0) {
        output("No skills to check.");
      } else {
        for (const result of results) {
          output(result.ok
            ? `OK: ${result.name}`
            : `FAIL: ${result.name} (${result.findings.join(", ")})`);
        }
      }
      break;
    }
    case "update": {
      const name = required(tokens[1], "skill name");
      const skill = hub.update(name);
      output(`Updated: ${skill.name}`);
      break;
    }
    case "audit": {
      const report = hub.audit();
      if (report.changed.length === 0 && report.missing.length === 0 && report.added.length === 0) {
        output("Audit clean");
      } else {
        if (report.changed.length > 0) output(`Changed: ${report.changed.join(", ")}`);
        if (report.missing.length > 0) output(`Missing: ${report.missing.join(", ")}`);
        if (report.added.length > 0) output(`Added: ${report.added.join(", ")}`);
      }
      break;
    }
    case "uninstall": {
      const name = required(tokens[1], "skill name");
      output(hub.uninstall(name) ? `Uninstalled: ${name}` : `Skill not installed: ${name}`);
      break;
    }
    case "publish": {
      const name = required(tokens[1], "skill name");
      output(`Publish source: ${hub.publish(name)}`);
      break;
    }
    case "snapshot": {
      const snapshot = hub.snapshot();
      output(`Snapshot saved: ${Object.keys(snapshot).length} files`);
      break;
    }
    default:
      throw new Error(`Unknown skills command: ${action}`);
  }
}

function printTapSkills(
  skills: Array<{ tap: string; name: string; description: string }>,
  output: (line: string) => void,
): void {
  if (skills.length === 0) {
    output("No skills found.");
    return;
  }
  for (const skill of skills) {
    output(`${skill.name} (${skill.tap}) — ${skill.description}`);
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readOption(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}
