/**
 * `purrfect profile` CLI handler.
 */

import {
  DEFAULT_PROFILE_NAME,
  ProfileStore,
  profileAliasSnippet,
  type ProfileInfo,
} from "../core/profiles.js";

export type ProfileAction =
  | { kind: "list" }
  | { kind: "show"; name?: string }
  | { kind: "create"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "use"; name: string }
  | { kind: "alias"; name: string };

const USAGE = `Usage:
  purrfect profile list
  purrfect profile show [name]
  purrfect profile create <name>
  purrfect profile delete <name>
  purrfect profile use <name>
  purrfect profile alias <name>`;

export function parseProfileArgs(args: string[]): ProfileAction {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };
    case "show":
      return { kind: "show", name: args[1] };
    case "create":
    case "delete":
    case "use":
    case "alias": {
      const name = args[1];
      if (!name) throw new Error(`Usage: purrfect profile ${sub} <name>`);
      return { kind: sub, name };
    }
    default:
      throw new Error(`Unknown profile subcommand: ${sub}\n\n${USAGE}`);
  }
}

export interface ProfileCommandDeps {
  baseDir?: string;
  output?: (text: string) => void;
}

export function runProfileCommand(
  action: ProfileAction,
  deps: ProfileCommandDeps = {},
): void {
  const out = deps.output ?? ((t) => console.log(t));
  const store = new ProfileStore({ baseDir: deps.baseDir });

  switch (action.kind) {
    case "list": {
      const profiles = store.list();
      const active = store.getActive();
      out(formatProfileList(profiles, active));
      return;
    }
    case "show": {
      const name = action.name ?? store.getActive();
      if (!store.exists(name)) {
        throw new Error(`Profile "${name}" does not exist`);
      }
      out(`Profile: ${name}`);
      out(`  path:   ${store.pathFor(name)}`);
      out(`  active: ${store.getActive() === name ? "yes" : "no"}`);
      return;
    }
    case "create": {
      const info = store.create(action.name);
      out(`Created profile "${info.name}" at ${info.path}`);
      out(`  Activate with: purrfect profile use ${info.name}`);
      out(`  Or per-invocation: PURRFECT_PROFILE=${info.name} purrfect`);
      return;
    }
    case "delete": {
      store.delete(action.name);
      out(`Deleted profile "${action.name}"`);
      return;
    }
    case "use": {
      store.setActive(action.name === DEFAULT_PROFILE_NAME ? undefined : action.name);
      out(`Active profile: ${action.name}`);
      return;
    }
    case "alias": {
      out(profileAliasSnippet(action.name));
      out("# Add the line above to ~/.zshrc or ~/.bashrc.");
      return;
    }
  }
}

function formatProfileList(profiles: ProfileInfo[], active: string): string {
  const rows = profiles.map((p) => {
    const marker = p.name === active ? "*" : " ";
    return `  ${marker} ${p.name.padEnd(20)} ${p.path}`;
  });
  return ["Profiles:", "", ...rows, ""].join("\n");
}
