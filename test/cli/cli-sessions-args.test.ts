import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";

describe("parseArgs: sessions extra subcommands", () => {
  it("'sessions rename <id> <title>'", () => {
    expect(
      parseArgs(["node", "purrfect", "sessions", "rename", "abc", "Daily", "Standup"]),
    ).toEqual({
      command: "sessions",
      action: { kind: "rename", id: "abc", title: "Daily Standup" },
    });
  });

  it("'sessions delete <id>'", () => {
    expect(parseArgs(["node", "purrfect", "sessions", "delete", "abc"])).toEqual({
      command: "sessions",
      action: { kind: "delete", id: "abc" },
    });
  });

  it("'sessions prune --older-than 30d'", () => {
    expect(
      parseArgs(["node", "purrfect", "sessions", "prune", "--older-than", "30d"]),
    ).toEqual({
      command: "sessions",
      action: { kind: "prune", olderThan: "30d", empty: false },
    });
  });

  it("'sessions prune --empty'", () => {
    expect(
      parseArgs(["node", "purrfect", "sessions", "prune", "--empty"]),
    ).toEqual({
      command: "sessions",
      action: { kind: "prune", olderThan: undefined, empty: true },
    });
  });

  it("'sessions export --format md <id>'", () => {
    expect(
      parseArgs(["node", "purrfect", "sessions", "export", "--format", "md", "abc"]),
    ).toEqual({
      command: "sessions",
      action: { kind: "export", id: "abc", format: "md" },
    });
  });

  it("'sessions browse'", () => {
    expect(parseArgs(["node", "purrfect", "sessions", "browse"])).toEqual({
      command: "sessions",
      action: { kind: "browse" },
    });
  });
});
