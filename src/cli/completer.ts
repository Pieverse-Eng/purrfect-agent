/**
 * Slash-command tab-completion for the REPL readline interface.
 */

import type { CommandRegistry } from "./commands/registry.js";
import { ansiColor } from "./formatter.js";

/**
 * Build the list of all completable slash tokens: /name and /alias for every
 * registered command.
 */
function allSlashTokens(registry: CommandRegistry): string[] {
  const tokens: string[] = [];
  for (const cmd of registry.getAll()) {
    tokens.push(`/${cmd.name}`);
    for (const alias of cmd.aliases) {
      tokens.push(`/${alias}`);
    }
  }
  return tokens;
}

/**
 * Create a readline-compatible completer function.
 *
 * Returns `[matches, line]` where `matches` is the array of possible
 * completions and `line` is the original input used for matching.
 */
export function createCompleter(
  registry: CommandRegistry,
): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    // Non-slash input → no completions
    if (!line.startsWith("/")) {
      return [[], line];
    }

    const spaceIdx = line.indexOf(" ");

    // ── Completing the command name (no space yet) ──────────────────
    if (spaceIdx === -1) {
      const partial = line; // e.g. "/he"
      const tokens = allSlashTokens(registry);
      const matches = tokens.filter((t) => t.startsWith(partial));
      return [matches, line];
    }

    // ── Completing arguments (space present) ────────────────────────
    const cmdPart = line.slice(1, spaceIdx); // e.g. "help"
    const argPartial = line.slice(spaceIdx + 1); // e.g. "m"

    // /help <partial> → complete with command names
    if (cmdPart === "help" || cmdPart === "h") {
      const names = registry.getAll().map((c) => c.name);
      const matching = names.filter((n) => n.startsWith(argPartial));
      const completions = matching.map((n) => `/help ${n}`);
      return [completions, line];
    }

    // Other commands: no argument completions (yet)
    return [[], line];
  };
}

/**
 * Format multiple completion matches for display, showing each command
 * with its description.  Used when readline needs to show ambiguous matches.
 */
export function formatCompletionHint(
  matches: string[],
  registry: CommandRegistry,
): string {
  const allCmds = registry.getAll();
  const lines: string[] = [];

  for (const match of matches) {
    const name = match.startsWith("/") ? match.slice(1) : match;
    // Find command by name or alias
    const cmd = allCmds.find(
      (c) => c.name === name || c.aliases.includes(name),
    );
    const desc = cmd?.description ?? "";
    lines.push(
      `  ${ansiColor(`/${name}`, "cyan")}  ${ansiColor(`— ${desc}`, "gray")}`,
    );
  }

  return lines.join("\n");
}
