import { describe, it, expect, vi, afterEach } from "vitest";
import { buildBanner, buildCompactBanner } from "../../src/cli/banner.js";

const defaultOpts = {
  model: "claude-sonnet-4-20250514",
  cwd: "/home/user/projects/my-app",
  toolCount: 12,
  skillCount: 3,
};

describe("buildBanner", () => {
  it("includes the model name and context length", () => {
    const banner = buildBanner(defaultOpts);
    expect(banner).toContain("claude-sonnet-4-20250514");
    expect(banner).toContain("200K");
  });

  it("includes the tool and skill counts", () => {
    const banner = buildBanner(defaultOpts);
    expect(banner).toContain("12");
    expect(banner).toContain("3");
  });

  it("includes the help reminder", () => {
    const banner = buildBanner(defaultOpts);
    expect(banner).toContain("/help");
  });
});

describe("buildCompactBanner", () => {
  it("returns a single-line compact banner for narrow terminals", () => {
    const compact = buildCompactBanner(defaultOpts);
    expect(compact).toContain("purrfect");
    expect(compact).toContain("claude-sonnet-4-20250514");
    expect(compact).toContain("12 tools");
    expect(compact).toContain("/help");
    // single line — no newlines
    expect(compact).not.toContain("\n");
  });
});
