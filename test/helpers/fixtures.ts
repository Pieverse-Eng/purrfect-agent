import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create an isolated temp directory for a test.
 * Returns the path and a cleanup function.
 * Mirrors hermes conftest.py _isolate_hermes_home pattern.
 */
export function createTempDir(prefix = "purrfect-test-"): {
  path: string;
  cleanup: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}
