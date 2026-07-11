import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/cf/src/**/*.workers.test.ts"],
    pool: "@cloudflare/vitest-pool-workers",
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        wrangler: { configPath: "./apps/cf/wrangler.jsonc" },
      },
    },
  },
});
