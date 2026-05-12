import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { createTempDir } from "../helpers/fixtures.js";
import { SessionStore } from "../../src/core/session-store.js";
import {
  formatApprovalPrompt,
  parseApprovalResponse,
  logApprovalDecision,
} from "../../src/cli/approval.js";

describe("Structured Approval Flow", () => {
  // ── formatApprovalPrompt ─────────────────────────────────────────

  it("prompt shows tool name, args preview, and risk reason", () => {
    const prompt = formatApprovalPrompt(
      "shell_exec",
      { command: "rm -rf /tmp/foo" },
      "recursive delete",
    );

    expect(prompt).toContain("shell_exec");
    expect(prompt).toContain("rm -rf /tmp/foo");
    expect(prompt).toContain("recursive delete");
    // Should list the three options
    expect(prompt).toContain("allow once");
    expect(prompt).toContain("allow session");
    expect(prompt).toContain("deny");
  });

  // ── parseApprovalResponse ────────────────────────────────────────

  it("parses allow_once from various inputs", () => {
    expect(parseApprovalResponse("1")).toBe("allow_once");
    expect(parseApprovalResponse("allow once")).toBe("allow_once");
    expect(parseApprovalResponse("a")).toBe("allow_once");
    expect(parseApprovalResponse("y")).toBe("allow_once");
  });

  it("parses allow_session from various inputs", () => {
    expect(parseApprovalResponse("2")).toBe("allow_session");
    expect(parseApprovalResponse("allow session")).toBe("allow_session");
    expect(parseApprovalResponse("s")).toBe("allow_session");
  });

  it("parses deny from various inputs", () => {
    expect(parseApprovalResponse("3")).toBe("deny");
    expect(parseApprovalResponse("deny")).toBe("deny");
    expect(parseApprovalResponse("d")).toBe("deny");
    expect(parseApprovalResponse("n")).toBe("deny");
    // Unknown input defaults to deny
    expect(parseApprovalResponse("garbage")).toBe("deny");
  });

  // ── logApprovalDecision ──────────────────────────────────────────

  describe("logApprovalDecision", () => {
    let tmpDir: { path: string; cleanup: () => void };
    let store: SessionStore;
    const sessionId = "approval-test-session";

    beforeEach(() => {
      tmpDir = createTempDir("approval-test-");
      store = new SessionStore(join(tmpDir.path, "test.db"));
      store.createSession({ id: sessionId, model: "test", source: "cli" });
    });

    afterEach(() => {
      store.close();
      tmpDir.cleanup();
    });

    it("logs the approval decision as a metadata message in the session store", () => {
      logApprovalDecision(store, sessionId, "shell_exec", "allow_once");

      const messages = store.getMessages(sessionId);
      const meta = messages.find(
        (m) => m.role === "metadata" && m.content !== null,
      );

      expect(meta).toBeDefined();
      const parsed = JSON.parse(meta!.content!);
      expect(parsed.type).toBe("approval_decision");
      expect(parsed.tool).toBe("shell_exec");
      expect(parsed.decision).toBe("allow_once");
    });
  });
});
