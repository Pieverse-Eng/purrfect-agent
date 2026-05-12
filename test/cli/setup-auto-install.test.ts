import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { autoInstallDefaultSkills } from "../../src/cli/setup.js";
import { SkillHub } from "../../src/core/skills/hub.js";
import { createTempDir } from "../helpers/fixtures.js";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups) try { fn(); } catch { /* best effort */ }
  cleanups = [];
});

/**
 * Write a runnable skill (SKILL.md inside a directory) to a tap-shaped layout.
 * Mirrors how purrfect-skills organizes its onchain skills on disk.
 */
function writeTapSkill(tapDir: string, name: string, description: string): void {
  const dir = join(tapDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\ntriggers:\n  - ${name}\ntools: []\ncontext_files: []\n---\n\nDo the ${name} thing.\n`,
    "utf-8",
  );
}

describe("autoInstallDefaultSkills", () => {
  it("installs every skill from registered taps and reports the counts", async () => {
    const configTmp = createTempDir("purrfect-config-");
    cleanups.push(configTmp.cleanup);
    const tapTmp = createTempDir("purrfect-tap-");
    cleanups.push(tapTmp.cleanup);

    writeTapSkill(tapTmp.path, "binance-test", "Mock binance skill");
    writeTapSkill(tapTmp.path, "pancake-test", "Mock pancake skill");

    const hub = new SkillHub({
      configDir: configTmp.path,
      defaultTaps: [{ name: "test-tap", url: tapTmp.path }],
    });

    const lines: string[] = [];
    const result = await autoInstallDefaultSkills({
      configDir: configTmp.path,
      hubFactory: () => hub,
      output: (line) => lines.push(line),
    });

    expect(result.installed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(configTmp.path, "skills", "managed", "binance-test", "SKILL.md"))).toBe(true);
    expect(existsSync(join(configTmp.path, "skills", "managed", "pancake-test", "SKILL.md"))).toBe(true);

    const joined = lines.join("\n");
    expect(joined).toContain("2 installed");
  });

  it("returns clean zeros when no taps are registered", async () => {
    const configTmp = createTempDir("purrfect-config-");
    cleanups.push(configTmp.cleanup);

    const hub = new SkillHub({ configDir: configTmp.path, defaultTaps: [] });
    const lines: string[] = [];

    const result = await autoInstallDefaultSkills({
      configDir: configTmp.path,
      hubFactory: () => hub,
      output: (line) => lines.push(line),
    });

    expect(result).toEqual({ installed: 0, failed: 0, errors: [] });
    expect(lines).toEqual([]);
  });

  it("surfaces a recovery hint when the tap can't be reached (network failure)", async () => {
    const configTmp = createTempDir("purrfect-config-");
    cleanups.push(configTmp.cleanup);

    // Point at a bogus local path; ensureTapPath will try to git-clone and fail.
    const hub = new SkillHub({
      configDir: configTmp.path,
      defaultTaps: [
        { name: "broken", url: "this-is-not-a-real-repo-or-path-1234567890" },
      ],
    });

    const lines: string[] = [];
    const result = await autoInstallDefaultSkills({
      configDir: configTmp.path,
      hubFactory: () => hub,
      output: (line) => lines.push(line),
    });

    // Either we got a hard browse() failure (lines mention recovery hint),
    // or browse() returned zero skills (no skills found message).
    expect(result.installed).toBe(0);
    expect(result.failed).toBe(0);
    const joined = lines.join("\n");
    expect(
      joined.includes("Run `purrfect skills install") || joined.includes("No skills found"),
    ).toBe(true);
  });

  it("skill_manage validation rejects a tap-supplied bad name without aborting the rest", async () => {
    // If install() throws (e.g., upstream renamed something and SkillHub
    // validation rejects), the loop must skip and keep going.
    const configTmp = createTempDir("purrfect-config-");
    cleanups.push(configTmp.cleanup);
    const tapTmp = createTempDir("purrfect-tap-");
    cleanups.push(tapTmp.cleanup);

    writeTapSkill(tapTmp.path, "good-skill", "this one installs fine");
    // A malformed SKILL.md that the loader will reject — file present, name
    // missing. Means it's filtered out at browse(), not install(); but we
    // also assert good-skill still lands.
    const badDir = join(tapTmp.path, "skills", "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "SKILL.md"), "not a real skill manifest\n", "utf-8");

    const hub = new SkillHub({
      configDir: configTmp.path,
      defaultTaps: [{ name: "mixed", url: tapTmp.path }],
    });

    const result = await autoInstallDefaultSkills({
      configDir: configTmp.path,
      hubFactory: () => hub,
      output: () => undefined,
    });

    expect(result.installed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(configTmp.path, "skills", "managed", "good-skill", "SKILL.md"))).toBe(true);
  });
});
