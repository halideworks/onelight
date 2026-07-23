import {
  Pbkdf2PasswordHasher,
  UlidGenerator,
  loadConfig,
} from "@onelight/core";
import {
  applyNodeMigrations,
  configureNodeSearch,
  createNodeDb,
} from "@onelight/db";
import { createApp } from "./app.js";
import type { ContractHarness } from "./contract/index.js";
import {
  FakeClock,
  MemoryBlobStore,
  StubMailer,
  registerContractSuite,
} from "./contract/index.js";

/**
 * Node leg of the contract suite: better-sqlite3 in :memory:, the real
 * PBKDF2 hasher, an in-memory MultipartBlobStore, and a fake clock the
 * suite controls. The same suite runs against D1 from
 * apps/cf/src/contract.workers.test.ts.
 */
const makeEnv = (): Promise<ContractHarness> => {
  const { db, sqlite } = createNodeDb(":memory:");
  applyNodeMigrations(sqlite);
  const searchBackend = configureNodeSearch(sqlite);
  const clock = new FakeClock();
  const ids = new UlidGenerator();
  const hasher = new Pbkdf2PasswordHasher();
  const blobStore = new MemoryBlobStore();
  const mailer = new StubMailer();
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
    version: "contract-node",
    searchBackend,
    blobStore,
    mailer,
  });
  return Promise.resolve({
    app,
    db,
    clock,
    ids,
    hasher,
    config,
    blobStore,
    mailer,
    teardown: () => {
      sqlite.close();
    },
  });
};

registerContractSuite(makeEnv, { blob: true, multipartAssembly: true });
