import { defineConfig } from "vitest/config";

/**
 * Smoke test config — hits real LLM endpoints. Runs only when invoked via
 * `npm run smoke`, never as part of the default `npm test`.
 */
export default defineConfig({
  test: {
    root: ".",
    include: ["test/smoke/**/*.smoke.ts"],
    testTimeout: 120_000,
  },
});
