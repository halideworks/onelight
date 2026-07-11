import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/cf/src/**/*.workers.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    // D1 plus per-test isolated storage is slower than better-sqlite3;
    // some contract tests issue dozens of sequential requests.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./apps/cf/wrangler.jsonc" },
      },
    },
  },
});
