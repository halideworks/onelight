import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.workers.test.ts"],
    passWithNoTests: true,
    // The contract suite drives rate-limit windows and webhook backoff
    // through many sequential HTTP calls per test.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
