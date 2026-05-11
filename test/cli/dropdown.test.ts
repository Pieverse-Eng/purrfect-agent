import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CommandDef } from "../../src/cli/commands/registry.js";
import { InlineDropdown } from "../../src/cli/dropdown.js";

function makeDef(overrides: Partial<CommandDef>): CommandDef {
  return {
    name: "test",
    description: "A test command",
    category: "Info",
    aliases: [],
    handler: async () => {},
    ...overrides,
  };
}

function buildCommands(): CommandDef[] {
  return [
    makeDef({ name: "help", description: "Show available commands" }),
    makeDef({ name: "history", description: "Show conversation history" }),
    makeDef({ name: "model", description: "Show or change model" }),
    makeDef({ name: "quit", description: "Exit the CLI" }),
  ];
}

describe("InlineDropdown", () => {
  let dropdown: InlineDropdown;

  beforeEach(() => {
    // Stub process.stdout.write to avoid ANSI output in tests
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    dropdown = new InlineDropdown(buildCommands());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('show("he") filters to help only', () => {
    dropdown.show("he");
    expect(dropdown.isVisible()).toBe(true);
    // "help" starts with "he", "history" starts with "hi" — only help matches
    expect(dropdown.getSelected()).toBe("help");
  });

  it('show("h") filters to help and history', () => {
    dropdown.show("h");
    expect(dropdown.isVisible()).toBe(true);
    expect(dropdown.getSelected()).toBe("help");
  });

  it("moveDown changes selected index", () => {
    dropdown.show("h"); // matches help and history
    expect(dropdown.getSelected()).toBe("help");
    dropdown.moveDown();
    expect(dropdown.getSelected()).toBe("history");
  });

  it("getSelected returns currently highlighted command", () => {
    dropdown.show(""); // show all
    expect(dropdown.getSelected()).toBe("help");
    dropdown.moveDown();
    expect(dropdown.getSelected()).toBe("history");
    dropdown.moveDown();
    expect(dropdown.getSelected()).toBe("model");
    dropdown.moveDown();
    expect(dropdown.getSelected()).toBe("quit");
    // Wraps around
    dropdown.moveDown();
    expect(dropdown.getSelected()).toBe("help");
  });

  it("hide resets state", () => {
    dropdown.show("he");
    expect(dropdown.isVisible()).toBe(true);
    dropdown.hide();
    expect(dropdown.isVisible()).toBe(false);
    expect(dropdown.getSelected()).toBeNull();
  });

  it("show with no matches hides the menu", () => {
    dropdown.show("zzz");
    expect(dropdown.isVisible()).toBe(false);
    expect(dropdown.getSelected()).toBeNull();
  });

  it("moveUp wraps around to last item", () => {
    dropdown.show("h"); // matches help and history
    expect(dropdown.getSelected()).toBe("help");
    dropdown.moveUp();
    expect(dropdown.getSelected()).toBe("history");
  });
});
