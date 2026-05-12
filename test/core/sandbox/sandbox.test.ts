import { describe, it, expect } from "vitest";
import { execSandboxed, checkContainerRuntime } from "../../../src/core/sandbox/index.js";

describe("Sandbox execution", () => {
  describe("mode: none", () => {
    it("executes command with no restrictions", async () => {
      const result = JSON.parse(
        await execSandboxed("echo hello", { mode: "none", timeout: 5000 }),
      );
      expect(result.stdout.trim()).toBe("hello");
    });

    it("returns error on failure", async () => {
      const result = JSON.parse(
        await execSandboxed("exit 42", { mode: "none", timeout: 5000 }),
      );
      expect(result.exit_code).toBeDefined();
    });
  });

  describe("mode: process", () => {
    it("executes command with restricted environment", async () => {
      const result = JSON.parse(
        await execSandboxed("echo sandbox-test", { mode: "process", timeout: 5000 }),
      );
      expect(result.stdout.trim()).toBe("sandbox-test");
    });

    it("restricts PATH to safe directories", async () => {
      const result = JSON.parse(
        await execSandboxed("echo $PATH", { mode: "process", timeout: 5000 }),
      );
      const path = result.stdout.trim();
      expect(path).toContain("/usr/bin");
      expect(path).toContain("/bin");
      // Should NOT include user-specific paths like ~/.local/bin
      expect(path).not.toContain(".local");
    });

    it("does not pass through arbitrary env vars", async () => {
      process.env.TEST_SANDBOX_SECRET = "should-not-see";
      try {
        const result = JSON.parse(
          await execSandboxed("echo $TEST_SANDBOX_SECRET", {
            mode: "process",
            timeout: 5000,
          }),
        );
        expect(result.stdout.trim()).toBe("");
      } finally {
        delete process.env.TEST_SANDBOX_SECRET;
      }
    });

    it("passes through explicitly allowed env vars", async () => {
      process.env.TEST_ALLOWED_VAR = "visible";
      try {
        const result = JSON.parse(
          await execSandboxed("echo $TEST_ALLOWED_VAR", {
            mode: "process",
            timeout: 5000,
            allowedEnvVars: ["TEST_ALLOWED_VAR"],
          }),
        );
        expect(result.stdout.trim()).toBe("visible");
      } finally {
        delete process.env.TEST_ALLOWED_VAR;
      }
    });

    it("returns timeout error when command exceeds limit", async () => {
      const result = JSON.parse(
        await execSandboxed("sleep 10", { mode: "process", timeout: 100 }),
      );
      expect(result.error).toContain("Timeout");
    }, 10_000);
  });

  describe("mode: container", () => {
    it("returns not-implemented error", async () => {
      const result = JSON.parse(
        await execSandboxed("echo test", { mode: "container", timeout: 5000 }),
      );
      expect(result.error).toContain("not yet implemented");
    });
  });

  describe("checkContainerRuntime", () => {
    it("returns availability status", async () => {
      const result = await checkContainerRuntime();
      expect(typeof result.available).toBe("boolean");
      expect(typeof result.message).toBe("string");
    });
  });
});
