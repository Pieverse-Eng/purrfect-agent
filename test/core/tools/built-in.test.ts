import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { ToolRegistry } from "../../../src/core/tool-registry.js";
import { SessionStore } from "../../../src/core/session-store.js";
import { HttpProvider } from "../../../src/core/provider.js";
import {
  fileReadTool,
  fileWriteTool,
  shellExecTool,
  createShellExecTool,
  webFetchTool,
  memoryTool,
  registerBuiltins,
} from "../../../src/core/tools/index.js";
import { createMockFetch } from "../../helpers/mock-server.js";

/* ------------------------------------------------------------------ */
/*  file_read                                                          */
/* ------------------------------------------------------------------ */
describe("file_read tool", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = createTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("reads an existing file and returns content as JSON", async () => {
    const filePath = join(tmp.path, "hello.txt");
    writeFileSync(filePath, "hello world");

    const result = JSON.parse(await fileReadTool.handler({ path: filePath }));
    expect(result.content).toBe("hello world");
  });

  it("returns error JSON for non-existent file", async () => {
    const result = JSON.parse(
      await fileReadTool.handler({ path: join(tmp.path, "nope.txt") }),
    );
    expect(result.error).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  file_write                                                         */
/* ------------------------------------------------------------------ */
describe("file_write tool", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = createTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("creates a file with correct content", async () => {
    const filePath = join(tmp.path, "out.txt");
    const result = JSON.parse(
      await fileWriteTool.handler({ path: filePath, content: "data" }),
    );
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("data");
  });

  it("creates intermediate directories when needed", async () => {
    const filePath = join(tmp.path, "sub", "deep", "file.txt");
    const result = JSON.parse(
      await fileWriteTool.handler({ path: filePath, content: "nested" }),
    );
    expect(result.success).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("nested");
  });

  it("overwrites an existing file", async () => {
    const filePath = join(tmp.path, "overwrite.txt");
    writeFileSync(filePath, "old");
    await fileWriteTool.handler({ path: filePath, content: "new" });
    expect(readFileSync(filePath, "utf-8")).toBe("new");
  });
});

/* ------------------------------------------------------------------ */
/*  shell_exec                                                         */
/* ------------------------------------------------------------------ */
describe("shell_exec tool", () => {
  it("runs echo and returns stdout as JSON", async () => {
    const result = JSON.parse(
      await shellExecTool.handler({ command: "echo hello" }),
    );
    expect(result.stdout.trim()).toBe("hello");
  });

  it("returns stderr as error JSON when command fails", async () => {
    const result = JSON.parse(
      await shellExecTool.handler({ command: "ls /nonexistent_path_xyz" }),
    );
    expect(result.error).toBeDefined();
  });

  it("returns timeout error when command exceeds timeout", async () => {
    const result = JSON.parse(
      await shellExecTool.handler({
        command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`,
        timeout_ms: 100,
      }),
    );
    expect(result.error).toBeDefined();
    expect(result.error.toLowerCase()).toContain("timeout");
  }, 10_000);

  it("does not leak environment variables in result", async () => {
    const result = JSON.parse(
      await shellExecTool.handler({ command: "echo done" }),
    );
    // Result should contain stdout only, no env leakage
    expect(result.stdout).toBeDefined();
    expect(result).not.toHaveProperty("env");
  });
});

/* ------------------------------------------------------------------ */
/*  web_fetch                                                          */
/* ------------------------------------------------------------------ */
describe("web_fetch tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a URL and returns body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "response body",
        headers: new Headers({ "content-type": "text/plain" }),
      }),
    );

    const result = JSON.parse(
      await webFetchTool.handler({ url: "https://example.com" }),
    );
    expect(result.body).toBe("response body");
    expect(result.status).toBe(200);
  });

  it("returns timeout error when fetch times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new DOMException("aborted", "AbortError")), 50);
          }),
      ),
    );

    const result = JSON.parse(
      await webFetchTool.handler({ url: "https://example.com", timeout_ms: 50 }),
    );
    expect(result.error).toBeDefined();
  });

  it("returns error JSON on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const result = JSON.parse(
      await webFetchTool.handler({ url: "https://example.com" }),
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain("network error");
  });
});

/* ------------------------------------------------------------------ */
/*  memory                                                             */
/* ------------------------------------------------------------------ */
describe("memory tool", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = createTempDir();
  });
  afterEach(() => tmp.cleanup());

  it("write then read returns written content", async () => {
    const writeResult = JSON.parse(
      await memoryTool.handler({
        action: "write",
        key: "note1",
        value: "remember this",
        memory_dir: tmp.path,
      }),
    );
    expect(writeResult.success).toBe(true);

    const readResult = JSON.parse(
      await memoryTool.handler({
        action: "read",
        key: "note1",
        memory_dir: tmp.path,
      }),
    );
    expect(readResult.snapshot).toContain("remember this");
  });

  it("read of non-existent key returns empty snapshot", async () => {
    const result = JSON.parse(
      await memoryTool.handler({
        action: "read",
        key: "missing",
        memory_dir: tmp.path,
      }),
    );
    expect(result.snapshot).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/*  registerBuiltins                                                   */
/* ------------------------------------------------------------------ */
describe("registerBuiltins", () => {
  it("registers all 6 tools in a registry", () => {
    const reg = new ToolRegistry();
    registerBuiltins(reg);
    const names = reg.getAllToolNames();
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("file_edit");
    expect(names).toContain("shell_exec");
    expect(names).toContain("web_fetch");
    expect(names).toContain("memory");
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it("registers clarify when an interactive clarification handler is provided", () => {
    const reg = new ToolRegistry();
    registerBuiltins(reg, {
      onClarify: async () => ({ answer: "ok" }),
    });

    expect(reg.getAllToolNames()).toContain("clarify");
  });

  it("creates per-instance shell_exec tools with isolated sandbox options", async () => {
    // Two registries with different sandbox modes get independent shell_exec instances.
    // Neither registry's sandbox mode leaks to the other.
    const reg1 = new ToolRegistry();
    registerBuiltins(reg1, { sandboxMode: "process" });

    const reg2 = new ToolRegistry();
    registerBuiltins(reg2); // defaults to "none"

    // Both registries have a shell_exec tool registered
    expect(reg1.getAllToolNames()).toContain("shell_exec");
    expect(reg2.getAllToolNames()).toContain("shell_exec");

    // Verify they are independent instances (not the same object)
    const def1 = reg1.getDefinition("shell_exec");
    const def2 = reg2.getDefinition("shell_exec");
    expect(def1).not.toBe(def2);

    // Both should still be able to run basic commands
    const result = JSON.parse(await def2!.handler({ command: "echo isolated" }));
    expect(result.stdout.trim()).toBe("isolated");
  });

  it("createShellExecTool captures sandbox options at creation time", () => {
    // Factory creates a tool with options baked in — no global state
    const tool1 = createShellExecTool({ mode: "process" });
    const tool2 = createShellExecTool({ mode: "none" });

    // They are distinct tool instances
    expect(tool1).not.toBe(tool2);
    expect(tool1.handler).not.toBe(tool2.handler);
  });

  it("registers v4 tools when session search dependencies are available", () => {
    const tmp = createTempDir();
    const store = new SessionStore(join(tmp.path, "sessions.db"));
    const provider = new HttpProvider(
      { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model" },
      createMockFetch([]),
    );

    try {
      const reg = new ToolRegistry();
      registerBuiltins(reg, { sessionStore: store, provider });
      const names = reg.getAllToolNames();
      expect(names).toContain("session_search");
      expect(names).toContain("delegate");
    } finally {
      store.close();
      tmp.cleanup();
    }
  });
});
