import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./apps/cf/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["apps/cf/src/**/*.workers.test.ts"],
    /* D1 through the pool is slow per request; these tests are small on
       purpose, so this only has to cover a stall, not a suite. */
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
