import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/cf/src/**/*.workers.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    /* D1 through the pool is slow per request; these tests are small on
       purpose, so this only has to cover a stall, not a suite. */
    testTimeout: 20_000,
    hookTimeout: 60_000,
    poolOptions: {
      workers: {
        /* Isolation stays on: these tests are few and short, so the per-test
           storage stack costs little here. It was ruinous when this leg ran
           the whole contract suite -- see the note in conformance.workers.test.ts
           for the measurements that moved that suite to the Node leg. */
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./apps/cf/wrangler.jsonc" },
      },
    },
  },
});
