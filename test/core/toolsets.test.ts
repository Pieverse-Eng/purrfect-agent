import { describe, it, expect } from "vitest";
import { getToolsForPlatform, isToolAllowed, CORE_TOOLS } from "../../src/core/toolsets.js";
import type { Platform } from "../../src/core/toolsets.js";

describe("Platform Toolsets", () => {
  it("CORE_TOOLS contains file and shell tools", () => {
    expect(CORE_TOOLS).toContain("file_read");
    expect(CORE_TOOLS).toContain("file_write");
    expect(CORE_TOOLS).toContain("file_edit");
    expect(CORE_TOOLS).toContain("shell_exec");
  });

  it("purrfect-cli includes all tools", () => {
    const tools = getToolsForPlatform("purrfect-cli");
    expect(tools).toContain("file_read");
    expect(tools).toContain("clarify");
    expect(tools).toContain("memory");
    expect(tools).toContain("session_search");
    expect(tools).toContain("delegate");
    expect(tools).toContain("web_fetch");
  });

  it("purrfect-api excludes interactive tools", () => {
    const tools = getToolsForPlatform("purrfect-api");
    expect(tools).toContain("file_read");
    expect(tools).toContain("web_fetch");
    expect(tools).not.toContain("clarify");
    expect(tools).not.toContain("memory");
    expect(tools).not.toContain("session_search");
    expect(tools).not.toContain("delegate");
  });

  it("purrfect-editor is coding-focused with memory support", () => {
    const tools = getToolsForPlatform("purrfect-editor");
    expect(tools).toContain("file_read");
    expect(tools).toContain("file_edit");
    expect(tools).toContain("shell_exec");
    expect(tools).toContain("web_fetch");
    expect(tools).toContain("clarify");
    expect(tools).toContain("memory");
    expect(tools).toContain("session_search");
    expect(tools).not.toContain("delegate");
  });

  it("isToolAllowed returns true for allowed tools", () => {
    expect(isToolAllowed("file_read", "purrfect-cli")).toBe(true);
    expect(isToolAllowed("memory", "purrfect-cli")).toBe(true);
  });

  it("isToolAllowed returns false for excluded tools", () => {
    expect(isToolAllowed("memory", "purrfect-api")).toBe(false);
    expect(isToolAllowed("delegate", "purrfect-editor")).toBe(false);
  });

  it("all platforms include CORE_TOOLS", () => {
    const platforms: Platform[] = ["purrfect-cli", "purrfect-api", "purrfect-editor"];
    for (const platform of platforms) {
      const tools = getToolsForPlatform(platform);
      for (const core of CORE_TOOLS) {
        expect(tools).toContain(core);
      }
    }
  });
});
