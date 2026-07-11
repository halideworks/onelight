import type { it } from "vitest";
import type { ContractCapabilities, ContractHarness } from "./harness.js";
import type { SeedState } from "./seed.js";

/**
 * Shared handles for domain registrars. The harness and seed are created in
 * the suite's root beforeAll, so domains access them through getters that
 * are only valid inside test bodies and hooks.
 */
export interface SuiteContext {
  h: () => ContractHarness;
  seed: () => SeedState;
  caps: ContractCapabilities;
  /** it() when a blob store is available, else a counting it.skip(). */
  itBlob: typeof it;
  /** it() when multi-part assembly of small parts works, else it.skip(). */
  itAssembly: typeof it;
}
