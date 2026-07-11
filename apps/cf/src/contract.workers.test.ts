import { env } from "cloudflare:test";
import { createApp } from "@onelight/api";
import type { ContractHarness } from "@onelight/api/contract";
import { FakeClock, registerContractSuite } from "@onelight/api/contract";
import {
  Pbkdf2PasswordHasher,
  UlidGenerator,
  loadConfig,
} from "@onelight/core";
import { applyD1Migrations, createD1Db } from "@onelight/db/cf";
import { R2BlobStore } from "./r2-store.js";

/**
 * Workers leg of the contract suite, running the exact same suite as
 * packages/api/src/contract.node.test.ts against the vitest-pool-workers
 * D1 binding (and R2 when a BLOBS binding exists).
 *
 * Module resolution: "@onelight/api/contract" maps through the package's
 * exports field to packages/api/dist/contract/index.js. `pnpm typecheck`
 * builds the composite dist (CI runs it before test:workers), so this
 * import works from a clean checkout after typecheck.
 *
 * Storage semantics: vitest-pool-workers isolatedStorage undoes writes made
 * inside a test but keeps beforeAll writes for the file. The suite creates
 * its harness and seed in beforeAll and never relies on state written by an
 * earlier test, so it is correct under both rollback (D1) and accumulation
 * (Node). Do not add SELF-based tests to this file ahead of the suite: a
 * migration applied inside a rolled-back test would leave the runner's
 * per-binding memoization thinking the schema still exists.
 */

// Blob capability is decided synchronously at module load so the suite can
// gate blob-dependent tests at registration time. The production adapter
// from ./r2-store.ts is used directly: it is stateless (the R2 upload key
// rides inside the opaque uploadId), so it works across requests exactly as
// it does in apps/cf/src/index.ts.
const blobBinding = (env as { BLOBS?: R2Bucket }).BLOBS;

const makeEnv = async (): Promise<ContractHarness> => {
  await applyD1Migrations(env.DB);
  const db = createD1Db(env.DB);
  const clock = new FakeClock();
  const ids = new UlidGenerator();
  const hasher = new Pbkdf2PasswordHasher();
  const blobStore = blobBinding ? new R2BlobStore(blobBinding) : null;
  const config = loadConfig({
    PUBLIC_URL: "http://onelight.test",
    SECRET_KEY: "contract-suite-secret-key-with-32-plus-chars",
  });
  const app = createApp({
    db,
    hasher,
    clock,
    ids,
    config,
    version: "contract-workers",
    ...(blobStore ? { blobStore } : {}),
  });
  return {
    app,
    db,
    clock,
    ids,
    hasher,
    config,
    blobStore,
  };
};

registerContractSuite(makeEnv, {
  blob: Boolean(blobBinding),
  // R2 (including the Miniflare simulation) rejects multipart completions
  // whose non-final parts are under 5 MiB, so tiny multi-part assembly is
  // exercised on the Node leg only.
  multipartAssembly: false,
});
