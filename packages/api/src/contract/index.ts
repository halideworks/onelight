import { afterAll, beforeAll, describe, it } from "vitest";
import type { ContractCapabilities, ContractHarness } from "./harness.js";
import type { SeedState } from "./seed.js";
import { buildSeed } from "./seed.js";
import type { SuiteContext } from "./context.js";
import { registerAuthDomain } from "./domains/auth.js";
import { registerCommentsDomain } from "./domains/comments.js";
import { registerEndpointInventory } from "./domains/endpoints.js";
import { registerFolderPropertyDomain } from "./domains/folders-property.js";
import { registerMatrixDomain } from "./domains/matrix.js";
import { registerMediaPipelineDomain } from "./domains/media-pipeline.js";
import { registerOidcDomain } from "./domains/oidc.js";
import { registerPasswordResetDomain } from "./domains/password-reset.js";
import { registerProjectsDomain } from "./domains/projects.js";
import { registerSharesDomain } from "./domains/shares.js";
import { registerSystemDomain } from "./domains/system.js";
import { registerVersionsDomain } from "./domains/versions.js";
import { registerWorkspaceUsersDomain } from "./domains/workspace-users.js";

export type { ContractCapabilities, ContractHarness } from "./harness.js";
export { FakeClock, StubMailer } from "./harness.js";
export { MemoryBlobStore } from "./memory-blob-store.js";

/**
 * The Onelight API contract suite. Register it from a vitest test file with
 * a harness factory for the backend under test:
 *
 * - Node leg: packages/api/src/contract.node.test.ts builds the app on
 *   better-sqlite3 :memory: with an in-memory blob store.
 * - Workers leg: apps/cf/src/contract.workers.test.ts builds the same app
 *   on the vitest-pool-workers D1 binding (and R2 when bound).
 *
 * Capabilities gate blob-dependent tests; gated tests are counted and the
 * counts are printed after the run so each leg reports what it skipped.
 */
export const registerContractSuite = (
  makeEnv: () => Promise<ContractHarness>,
  caps: ContractCapabilities = { blob: true, multipartAssembly: true },
): void => {
  let harness: ContractHarness | undefined;
  let seedState: SeedState | undefined;
  const skipped = { blob: 0, multipartAssembly: 0 };

  const gate = (enabled: boolean, counter: keyof typeof skipped): typeof it => {
    if (enabled) return it;
    const skippingIt = (...args: Parameters<typeof it>) => {
      skipped[counter] += 1;
      return it.skip(...args);
    };
    return skippingIt as typeof it;
  };

  const ctx: SuiteContext = {
    h: () => {
      if (!harness) throw new Error("Contract harness is not ready.");
      return harness;
    },
    seed: () => {
      if (!seedState) throw new Error("Contract seed is not ready.");
      return seedState;
    },
    caps,
    itBlob: gate(caps.blob, "blob"),
    itAssembly: gate(caps.blob && caps.multipartAssembly, "multipartAssembly"),
  };

  describe("Onelight API contract suite", () => {
    beforeAll(async () => {
      harness = await makeEnv();
      // The suite drives rate-limit isolation through X-Forwarded-For, and the
      // in-memory app under test exposes no peer socket, so the suite trusts
      // the proxy chain. clientIp then reads the header as it would behind a
      // configured reverse proxy (TRUST_PROXY=true). The default-off behavior
      // is covered explicitly by the spoofing test in the auth domain.
      harness.config.TRUST_PROXY = true;
      seedState = await buildSeed(harness);
    }, 180_000);

    afterAll(async () => {
      const total = skipped.blob + skipped.multipartAssembly;
      if (total > 0)
        console.log(
          `[contract] capability-gated skips: blob=${String(skipped.blob)}, multipart_assembly=${String(skipped.multipartAssembly)} (total ${String(total)})`,
        );
      await harness?.teardown?.();
    });

    registerEndpointInventory(ctx);
    registerAuthDomain(ctx);
    registerPasswordResetDomain(ctx);
    registerWorkspaceUsersDomain(ctx);
    registerProjectsDomain(ctx);
    registerFolderPropertyDomain(ctx);
    registerMatrixDomain(ctx);
    registerOidcDomain(ctx);
    registerMediaPipelineDomain(ctx);
    registerVersionsDomain(ctx);
    registerCommentsDomain(ctx);
    registerSharesDomain(ctx);
    registerSystemDomain(ctx);
  });
};
