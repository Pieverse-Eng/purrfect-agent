import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/index.js";

describe("parseArgs: cron subcommands", () => {
  it("'cron list'", () => {
    expect(parseArgs(["node", "purrfect", "cron", "list"])).toEqual({
      command: "cron",
      action: { kind: "list" },
    });
  });

  it("'cron create <expr> <prompt>'", () => {
    expect(
      parseArgs(["node", "purrfect", "cron", "create", "*/5 * * * *", "ping", "site"]),
    ).toEqual({
      command: "cron",
      action: { kind: "create", cronExpr: "*/5 * * * *", prompt: "ping site" },
    });
  });

  it("'cron pause <id>'", () => {
    expect(parseArgs(["node", "purrfect", "cron", "pause", "abc123"])).toEqual({
      command: "cron",
      action: { kind: "pause", id: "abc123" },
    });
  });

  it("'cron edit <id> --cron <expr> --prompt <text>'", () => {
    expect(
      parseArgs([
        "node",
        "purrfect",
        "cron",
        "edit",
        "abc",
        "--cron",
        "0 9 * * *",
        "--prompt",
        "morning standup",
      ]),
    ).toEqual({
      command: "cron",
      action: {
        kind: "edit",
        id: "abc",
        cronExpr: "0 9 * * *",
        prompt: "morning standup",
      },
    });
  });

  it("'cron status'", () => {
    expect(parseArgs(["node", "purrfect", "cron", "status"])).toEqual({
      command: "cron",
      action: { kind: "status" },
    });
  });

});
