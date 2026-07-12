import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    globalSetup: ["./src/global-setup.ts"],
    // Fixture synthesis, browser launches, and 20 seeks x 8 rates need room;
    // individual assertions fail fast regardless.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Serial files: two concurrent browser+ffmpeg workloads thrash small CI
    // runners and interleave the skip logs.
    fileParallelism: false,
    passWithNoTests: true,
  },
});
