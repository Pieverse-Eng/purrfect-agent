/**
 * Inline completion dropdown rendered via ANSI escape sequences.
 *
 * Shows a box-drawn menu below the cursor when the user types "/" in the REPL,
 * filtering commands as they type.
 */

import type { CommandDef } from "./commands/registry.js";
import { ansiColor } from "./formatter.js";

const MAX_VISIBLE = 6;
const MIN_WIDTH = 40;

export interface DropdownItem {
  name: string;
  description: string;
}

export class InlineDropdown {
  private commands: DropdownItem[];
  private filtered: DropdownItem[] = [];
  private selectedIndex = 0;
  private visible = false;
  /** Number of terminal lines occupied by the last render. */
  private renderedLines = 0;

  constructor(commands: CommandDef[]) {
    this.commands = commands.map((c) => ({
      name: c.name,
      description: c.description,
    }));
  }

  /**
   * Filter commands matching `partial` (without the leading "/") and show the menu.
   * If no matches, hides the menu instead.
   */
  show(partial: string): void {
    const lower = partial.toLowerCase();
    this.filtered = this.commands.filter((c) =>
      c.name.toLowerCase().startsWith(lower),
    );
    if (this.filtered.length === 0) {
      this.hide();
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.filtered.length - 1);
    this.visible = true;
    this.render();
  }

  /** Clear the rendered menu lines and reset visibility. */
  hide(): void {
    this.eraseMenu();
    this.visible = false;
    this.filtered = [];
    this.selectedIndex = 0;
    this.renderedLines = 0;
  }

  /** Move selection up. Wraps within visible range. */
  moveUp(): void {
    if (!this.visible || this.filtered.length === 0) return;
    const visibleCount = Math.min(this.filtered.length, MAX_VISIBLE);
    this.selectedIndex =
      (this.selectedIndex - 1 + visibleCount) % visibleCount;
    this.render();
  }

  /** Move selection down. Wraps within visible range. */
  moveDown(): void {
    if (!this.visible || this.filtered.length === 0) return;
    const visibleCount = Math.min(this.filtered.length, MAX_VISIBLE);
    this.selectedIndex = (this.selectedIndex + 1) % visibleCount;
    this.render();
  }

  /** Return the name of the currently highlighted command, or null. */
  getSelected(): string | null {
    if (!this.visible || this.filtered.length === 0) return null;
    return this.filtered[this.selectedIndex].name;
  }

  /** Whether the menu is currently displayed. */
  isVisible(): boolean {
    return this.visible;
  }

  // ── Internal rendering ───────────────────────────────────────────

  /** Render the dropdown box below the current cursor position. */
  private render(): void {
    // First erase any previously rendered menu
    this.eraseMenu();

    const items = this.filtered.slice(0, MAX_VISIBLE);

    // Compute box width
    const longestEntry = items.reduce((max, item) => {
      const len = item.name.length + item.description.length + 8;
      return Math.max(max, len);
    }, 0);
    const innerWidth = Math.max(MIN_WIDTH - 2, longestEntry);
    const horizontal = "─".repeat(innerWidth);
    const topBorder = `  ┌${horizontal}┐`;
    const bottomBorder = `  └${horizontal}┘`;

    const rows: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSelected = i === this.selectedIndex;
      const marker = isSelected ? "▸" : " ";
      const nameStr = `/${item.name}`;
      const descStr = item.description;

      const prefix = ` ${marker} `;
      const gap = "   ";
      const contentLen = prefix.length + nameStr.length + gap.length + descStr.length;
      const padding = Math.max(1, innerWidth - contentLen);

      const nameColored = isSelected
        ? ansiColor(nameStr, "cyan")
        : ansiColor(nameStr, "white");
      const descColored = ansiColor(descStr, "gray");
      const markerColored = isSelected
        ? ansiColor(marker, "cyan")
        : " ";

      const rowContent = ` ${markerColored} ${nameColored}${gap}${descColored}${" ".repeat(padding)}`;
      rows.push(`  │${rowContent}│`);
    }

    // Write menu below cursor, then move cursor back up to the input line
    const totalLines = rows.length + 2; // top + rows + bottom
    let output = "\n" + topBorder;
    for (const row of rows) {
      output += "\n" + row;
    }
    output += "\n" + bottomBorder;
    // Move cursor back up to the input line
    output += `\x1b[${totalLines}A`;
    // Move cursor to end of current input line (column restore)
    output += "\r";

    this.renderedLines = totalLines;
    process.stdout.write(output);
  }

  /** Erase previously rendered menu lines below the cursor. */
  private eraseMenu(): void {
    if (this.renderedLines <= 0) return;
    // Move to next line, erase everything below, move back up
    process.stdout.write(`\n\x1b[J\x1b[1A\r`);
    this.renderedLines = 0;
  }
}
