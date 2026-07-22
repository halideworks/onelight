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
        /* Left on, but know what it costs before you touch it.
           Measured 2026-07-22: this leg takes ~1050s and fails ~40 of 230
           tests on EVERY run with a bare "Network connection lost" whose only
           stack frame is WorkersTestRunner.updateStackedStorage -- the
           isolation machinery itself, never an assertion. A run on the parent
           commit failed 42, so it is the harness, not the code under test.
           Setting this false is tempting and does not work: test execution
           drops to 60s and nothing fails, but the worker's onTaskUpdate RPC
           then stalls, the run reports 217 of 230 tests, and the whole
           r2-store file goes unreported. A quieter reporter does not help. A
           gate that silently drops a file is worse than a slow one, so this
           stays true until the pool fixes the RPC. For iteration, filter with
           -t instead of turning isolation off. */
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./apps/cf/wrangler.jsonc" },
      },
    },
  },
});
