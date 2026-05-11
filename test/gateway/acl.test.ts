import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  PairingStore,
  evaluatePairing,
  formatPairingPrompt,
  generatePairingCode,
} from "../../src/gateway/acl.js";

function tempStore(opts: {
  generateCode?: () => string;
  now?: () => number;
} = {}): { store: PairingStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "purrfect-acl-"));
  const path = join(dir, "pairing.json");
  return {
    store: new PairingStore({ path, ...opts }),
    dir,
    path,
  };
}

describe("generatePairingCode", () => {
  it("emits 6 characters from a no-ambiguity alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });
});

describe("PairingStore", () => {
  it("ensurePending creates a pending entry the first time, idempotent after", () => {
    const codes = ["CODE01", "CODE02"];
    const { store, dir, path } = tempStore({
      generateCode: () => codes.shift() ?? "FALLBK",
    });
    try {
      const first = store.ensurePending("telegram", "u1", "Alice");
      expect(first.status).toBe("pending");
      expect(first.code).toBe("CODE01");
      expect(first.userName).toBe("Alice");

      const again = store.ensurePending("telegram", "u1");
      expect(again.code).toBe("CODE01"); // same code returned
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      expect(onDisk.entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("approve flips status, clears the code, and sets role", () => {
    const { store, dir } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      store.ensurePending("slack", "U99");
      const approved = store.approve("abcdef", "admin"); // case-insensitive
      expect(approved.status).toBe("approved");
      expect(approved.role).toBe("admin");
      expect(approved.code).toBeUndefined();
      expect(approved.approvedAt).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("approve throws on unknown code", () => {
    const { store, dir } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      store.ensurePending("slack", "U99");
      expect(() => store.approve("zzzzzz")).toThrow(/No pending pairing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("revoke marks an entry revoked", () => {
    const { store, dir } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      store.ensurePending("slack", "U99");
      store.approve("ABCDEF");
      const revoked = store.revoke("slack", "U99");
      expect(revoked.status).toBe("revoked");
      expect(revoked.code).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clearPending drops only pending entries", () => {
    let i = 0;
    const { store, dir } = tempStore({
      generateCode: () => `CODE0${i++}`,
    });
    try {
      store.ensurePending("slack", "u1");
      store.ensurePending("slack", "u2");
      store.approve("CODE00");
      const dropped = store.clearPending();
      expect(dropped).toBe(1);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].userId).toBe("u1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setRole only works on approved entries", () => {
    const { store, dir } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      store.ensurePending("slack", "u1");
      expect(() => store.setRole("slack", "u1", "admin")).toThrow(/Approve it first/);
      store.approve("ABCDEF");
      const promoted = store.setRole("slack", "u1", "admin");
      expect(promoted.role).toBe("admin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a corrupt pairing.json file", () => {
    const { store, dir, path } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      store.ensurePending("slack", "u1");
      // Corrupt the file
      require("node:fs").writeFileSync(path, "{ not json", "utf-8");
      // New store reads it and starts clean
      const fresh = new PairingStore({ path });
      expect(fresh.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluatePairing", () => {
  it("requireApproval=false always allows", () => {
    const { store, dir } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      const decision = evaluatePairing(store, "slack", "u1", {
        requireApproval: false,
      });
      expect(decision.kind).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("first message → pending; after approve → allow; after revoke → denied", () => {
    const { store, dir } = tempStore({ generateCode: () => "ABCDEF" });
    try {
      const first = evaluatePairing(store, "slack", "u1", {
        requireApproval: true,
        userName: "Alice",
      });
      expect(first.kind).toBe("pending");

      store.approve("ABCDEF");
      const next = evaluatePairing(store, "slack", "u1", {
        requireApproval: true,
      });
      expect(next.kind).toBe("allow");

      store.revoke("slack", "u1");
      const after = evaluatePairing(store, "slack", "u1", {
        requireApproval: true,
      });
      expect(after.kind).toBe("denied");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatPairingPrompt", () => {
  it("includes the code and the admin command", () => {
    const text = formatPairingPrompt({
      platform: "slack",
      userId: "u1",
      code: "ABCDEF",
      status: "pending",
      role: "user",
      createdAt: 0,
    });
    expect(text).toContain("ABCDEF");
    expect(text).toContain("purrfect pairing approve ABCDEF");
  });
});
