import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parsePairingArgs } from "../../src/cli/pairing-args.js";
import { runPairingCommand } from "../../src/cli/pairing.js";
import { PairingStore } from "../../src/gateway/acl.js";

function tempStore(generate: () => string = () => "ABCDEF") {
  const dir = mkdtempSync(join(tmpdir(), "purrfect-pairing-cli-"));
  const store = new PairingStore({
    path: join(dir, "pairing.json"),
    generateCode: generate,
  });
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("parsePairingArgs", () => {
  it("defaults to list", () => {
    expect(parsePairingArgs([])).toEqual({ kind: "list" });
    expect(parsePairingArgs(["list"])).toEqual({ kind: "list" });
  });

  it("approve with optional --role", () => {
    expect(parsePairingArgs(["approve", "ABC"])).toEqual({ kind: "approve", code: "ABC" });
    expect(parsePairingArgs(["approve", "ABC", "--role", "admin"])).toEqual({
      kind: "approve",
      code: "ABC",
      role: "admin",
    });
  });

  it("rejects bad role", () => {
    expect(() => parsePairingArgs(["approve", "X", "--role", "boss"])).toThrow(
      /Invalid role/,
    );
  });

  it("revoke / promote require platform:userId", () => {
    expect(parsePairingArgs(["revoke", "slack:u1"])).toEqual({
      kind: "revoke",
      platform: "slack",
      userId: "u1",
    });
    expect(parsePairingArgs(["promote", "slack:u1", "admin"])).toEqual({
      kind: "promote",
      platform: "slack",
      userId: "u1",
      role: "admin",
    });
    expect(() => parsePairingArgs(["revoke", "slack"])).toThrow(/platform:userId/);
  });

  it("clear-pending parses as its own kind", () => {
    expect(parsePairingArgs(["clear-pending"])).toEqual({ kind: "clear-pending" });
  });

  it("rejects unknown subcommand", () => {
    expect(() => parsePairingArgs(["bogus"])).toThrow(/Unknown pairing subcommand/);
  });
});

describe("runPairingCommand", () => {
  it("list shows pending + approved sorted, approve flips status", () => {
    const { store, cleanup } = tempStore();
    try {
      const lines: string[] = [];
      const out = (t: string) => lines.push(t);

      store.ensurePending("slack", "u1", "Alice");

      runPairingCommand({ kind: "list" }, { store, output: out });
      expect(lines.join("\n")).toContain("[pending]  slack:u1");

      lines.length = 0;
      runPairingCommand(
        { kind: "approve", code: "ABCDEF", role: "user" },
        { store, output: out },
      );
      expect(lines.join("\n")).toContain("Approved slack:u1 as user");

      lines.length = 0;
      runPairingCommand({ kind: "list" }, { store, output: out });
      expect(lines.join("\n")).toContain("[user");
    } finally {
      cleanup();
    }
  });

  it("revoke marks the entry revoked", () => {
    const { store, cleanup } = tempStore();
    try {
      const lines: string[] = [];
      const out = (t: string) => lines.push(t);
      store.ensurePending("slack", "u1");
      store.approve("ABCDEF");

      runPairingCommand(
        { kind: "revoke", platform: "slack", userId: "u1" },
        { store, output: out },
      );
      expect(lines.join("\n")).toContain("Revoked slack:u1");
      expect(store.find("slack", "u1")?.status).toBe("revoked");
    } finally {
      cleanup();
    }
  });

  it("clear-pending drops codes", () => {
    let i = 0;
    const { store, cleanup } = tempStore(() => `CODE0${i++}`);
    try {
      store.ensurePending("slack", "u1");
      store.ensurePending("slack", "u2");
      const lines: string[] = [];
      runPairingCommand(
        { kind: "clear-pending" },
        { store, output: (t) => lines.push(t) },
      );
      expect(lines.join("\n")).toContain("Cleared 2");
      expect(store.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("promote requires an approved entry", () => {
    const { store, cleanup } = tempStore();
    try {
      store.ensurePending("slack", "u1");
      expect(() =>
        runPairingCommand(
          { kind: "promote", platform: "slack", userId: "u1", role: "admin" },
          { store, output: () => {} },
        ),
      ).toThrow(/Approve it first/);
    } finally {
      cleanup();
    }
  });
});
