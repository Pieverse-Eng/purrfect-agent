import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../../helpers/fixtures.js";
import { PluginDiscovery } from "../../../src/core/plugins/discovery.js";
import type { PluginManifest } from "../../../src/core/plugins/manifest.js";

describe("PluginDiscovery", () => {
  let cleanup: () => void;
  let tmpDir: string;

  function setup() {
    const tmp = createTempDir("plugin-discovery-test-");
    tmpDir = tmp.path;
    cleanup = tmp.cleanup;
    return tmpDir;
  }

  afterEach(() => {
    if (cleanup) cleanup();
  });

  function writePluginJson(subdir: string, content: unknown): string {
    const dir = join(tmpDir, subdir);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "plugin.json");
    writeFileSync(filePath, JSON.stringify(content), "utf-8");
    return filePath;
  }

  it("parses a valid manifest with correct fields", async () => {
    setup();
    const manifest = {
      name: "my-plugin",
      version: "1.0.0",
      description: "A test plugin",
      main: "index.js",
      capabilities: {
        tools: ["tool-a"],
        hooks: ["on-start"],
        commands: ["cmd-x"],
      },
    };
    writePluginJson("my-plugin", manifest);

    const results = await PluginDiscovery.scan([tmpDir]);

    expect(results).toHaveLength(1);
    const p: PluginManifest = results[0];
    expect(p.name).toBe("my-plugin");
    expect(p.version).toBe("1.0.0");
    expect(p.description).toBe("A test plugin");
    expect(p.main).toBe("index.js");
    expect(p.capabilities.tools).toEqual(["tool-a"]);
    expect(p.capabilities.hooks).toEqual(["on-start"]);
    expect(p.capabilities.commands).toEqual(["cmd-x"]);
  });

  it("discovers multiple plugins across subdirectories", async () => {
    setup();
    writePluginJson("plugin-a", {
      name: "plugin-a",
      version: "0.1.0",
      description: "First",
      main: "a.js",
      capabilities: {},
    });
    writePluginJson("plugin-b", {
      name: "plugin-b",
      version: "0.2.0",
      description: "Second",
      main: "b.js",
      capabilities: { tools: ["t1"] },
    });

    const results = await PluginDiscovery.scan([tmpDir]);

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(["plugin-a", "plugin-b"]);
  });

  it("skips invalid manifest missing required name field", async () => {
    setup();
    writePluginJson("bad-plugin", {
      // name is missing
      version: "1.0.0",
      description: "No name",
      main: "index.js",
      capabilities: {},
    });

    const results = await PluginDiscovery.scan([tmpDir]);

    expect(results).toHaveLength(0);
  });

  it("returns empty array for empty plugin directory", async () => {
    setup();
    // tmpDir exists but has no subdirectories with plugin.json

    const results = await PluginDiscovery.scan([tmpDir]);

    expect(results).toHaveLength(0);
  });

  it("returns empty array when directory does not exist", async () => {
    const results = await PluginDiscovery.scan(["/tmp/nonexistent-plugin-dir-abc123"]);

    expect(results).toHaveLength(0);
  });

  it("skips malformed JSON without crashing", async () => {
    setup();
    const dir = join(tmpDir, "broken-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{not valid json!!!", "utf-8");

    const results = await PluginDiscovery.scan([tmpDir]);

    expect(results).toHaveLength(0);
  });
});
