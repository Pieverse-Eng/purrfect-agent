import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../../src/core/tool-registry.js";
import { registerBuiltins } from "../../../src/core/tools/index.js";

describe("registerBuiltins with platform filtering", () => {
  it("purrfect-cli registers all tools (default)", () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);

    const names = registry.getAllToolNames();
    expect(names).toContain("file_read");
    expect(names).toContain("file_write");
    expect(names).toContain("file_edit");
    expect(names).toContain("shell_exec");
    expect(names).toContain("memory");
    expect(names).toContain("web_fetch");
  });

  it("purrfect-api excludes interactive tools", () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, { platform: "purrfect-api" });

    const names = registry.getAllToolNames();
    expect(names).toContain("file_read");
    expect(names).toContain("file_edit");
    expect(names).toContain("shell_exec");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("memory");
    expect(names).not.toContain("session_search");
    expect(names).not.toContain("delegate");
  });

  it("purrfect-editor is coding-focused with memory support", () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, { platform: "purrfect-editor" });

    const names = registry.getAllToolNames();
    expect(names).toContain("file_read");
    expect(names).toContain("file_edit");
    expect(names).toContain("shell_exec");
    expect(names).toContain("web_fetch");
    expect(names).toContain("memory");
    // session_search requires a sessionStore to register; its platform
    // allowance is verified in toolsets.test.ts
    expect(names).not.toContain("delegate");
  });

  it("explicit purrfect-cli matches default behavior", () => {
    const defaultRegistry = new ToolRegistry();
    registerBuiltins(defaultRegistry);

    const explicitRegistry = new ToolRegistry();
    registerBuiltins(explicitRegistry, { platform: "purrfect-cli" });

    expect(defaultRegistry.getAllToolNames()).toEqual(explicitRegistry.getAllToolNames());
  });
});
