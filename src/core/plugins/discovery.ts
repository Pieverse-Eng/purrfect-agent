import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema } from "./manifest.js";
import type { PluginManifest } from "./manifest.js";

export class PluginDiscovery {
  /**
   * Scan one or more directories for plugin subdirectories containing a
   * valid plugin.json manifest.  Invalid or malformed manifests are logged
   * and silently skipped.
   */
  static async scan(dirs: string[]): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        continue;
      }

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const subdir = join(dir, entry);
        try {
          if (!statSync(subdir).isDirectory()) {
            continue;
          }
        } catch {
          continue;
        }

        const manifestPath = join(subdir, "plugin.json");
        if (!existsSync(manifestPath)) {
          continue;
        }

        try {
          const raw = readFileSync(manifestPath, "utf-8");
          const json: unknown = JSON.parse(raw);
          const result = PluginManifestSchema.safeParse(json);

          if (result.success) {
            manifests.push(result.data);
          } else {
            console.warn(
              `Invalid plugin manifest at ${manifestPath}: ${result.error.message}`,
            );
          }
        } catch (err) {
          console.warn(`Failed to read plugin manifest at ${manifestPath}: ${err}`);
        }
      }
    }

    return manifests;
  }
}
