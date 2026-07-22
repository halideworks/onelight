import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "@onelight/api";
import { FakeClock, req, json, forbiddenKeysIn } from "@onelight/api/contract";
import type { ContractHarness } from "@onelight/api/contract";
import {
  Pbkdf2PasswordHasher,
  UlidGenerator,
  loadConfig,
} from "@onelight/core";
import { applyD1Migrations, createD1Db, d1Migrations } from "@onelight/db/cf";

/**
 * The D1 conformance leg.
 *
 * This used to run the entire 230-test contract suite against the D1 binding,
 * and it could not: vitest-pool-workers charges hundreds of milliseconds of
 * isolated-storage bookkeeping per REQUEST, so a contract test making twenty
 * or thirty of them crossed a connection deadline around six seconds and
 * workerd killed the isolate. It surfaced as "Network connection lost" inside
 * updateStackedStorage, never as an assertion, and it failed roughly forty of
 * two hundred and thirty tests on every run for months -- the more thorough
 * the test, the more certainly it failed. Measured 2026-07-22: every transfers
 * test took 5-12s at four percent CPU, and the only two that passed were the
 * two fastest.
 *
 * So this leg no longer re-litigates business rules. Those are verified on the
 * Node leg, where the same suite runs in twelve seconds and passes. What is
 * left here is what ONLY D1 can answer: that the migrations apply to a real
 * D1 database, that the schema they produce is the schema the code expects,
 * that the dialect behaves where the app leans on it, and that the drizzle D1
 * driver round-trips through a few representative endpoints.
 *
 * The rule for anything added here: keep it under a handful of requests. A
 * test that needs twenty belongs on the Node leg.
 */

const makeHarness = async (): Promise<ContractHarness> => {
  await applyD1Migrations(env.DB);
  const db = createD1Db(env.DB);
  const clock = new FakeClock();
  const ids = new UlidGenerator();
  const hasher = new Pbkdf2PasswordHasher();
  const config = loadConfig({
    PUBLIC_URL: "http://onelight.test",
    SECRET_KEY: "conformance-suite-secret-key-with-32-plus-chars",
  });
  const app = createApp({
    db,
    hasher,
    clock,
    ids,
    config,
    version: "conformance-workers",
  });
  return { app, db, clock, ids, hasher, config, blobStore: null };
};

let h: ContractHarness;
let cookie = "";

/* Setup and sign-in live here, not in a test: isolatedStorage rolls back
   whatever a TEST writes and keeps what beforeAll writes, so an account
   created inside one test does not exist for the next one. */
beforeAll(async () => {
  h = await makeHarness();
  const setup = await req(h, "/api/v1/setup", {
    json: {
      workspace_name: "Conformance",
      name: "Admin",
      email: "conformance-admin@example.com",
      password: "conformance-password-1",
    },
  });
  if (![200, 201].includes(setup.status))
    throw new Error(`setup failed: ${String(setup.status)}`);
  const login = await req(h, "/api/v1/auth/login", {
    json: {
      email: "conformance-admin@example.com",
      password: "conformance-password-1",
    },
  });
  if (login.status !== 200)
    throw new Error(`login failed: ${String(login.status)}`);
  cookie = (login.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
});

describe("D1 migrations", () => {
  it("applies every migration and records each one", async () => {
    const tracked = await env.DB.prepare(
      "SELECT id FROM __onelight_migrations ORDER BY id",
    ).all<{ id: string }>();
    expect(tracked.results.map((row) => row.id)).toEqual(
      d1Migrations.map((migration) => migration.name),
    );
  });

  it("is idempotent: applying again is a no-op, not a re-run", async () => {
    /* The runner memoizes per binding, so this also proves a second isolate
       reaching the same database does not try to recreate its tables. */
    await applyD1Migrations(env.DB);
    const tracked = await env.DB.prepare(
      "SELECT count(*) AS n FROM __onelight_migrations",
    ).first<{ n: number }>();
    expect(tracked?.n).toBe(d1Migrations.length);
  });

  it("leaves every table the schema module declares", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all<{ name: string }>();
    const present = new Set(rows.results.map((row) => row.name));
    for (const table of [
      "workspaces",
      "users",
      "projects",
      "assets",
      "asset_versions",
      "renditions",
      "comments",
      "shares",
      "share_viewers",
      "transfers",
      "transfer_items",
      "transfer_receipts",
      "transfer_visits",
      "transfer_downloads",
    ])
      expect(present, table).toContain(table);
  });
});

describe("D1 dialect, where the app leans on it", () => {
  it("enforces the partial unique indexes on renditions", async () => {
    /* Two partial unique indexes over the same table, split on share_id being
       null. Migration 0020 rebuilds the table to get them; if D1 dropped
       either one, a share could quietly overwrite the base rendition. */
    const rows = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='renditions'",
    ).all<{ name: string; sql: string | null }>();
    const byName = new Map(rows.results.map((row) => [row.name, row.sql]));
    expect(byName.has("renditions_base_uq")).toBe(true);
    expect(byName.has("renditions_share_uq")).toBe(true);
    expect(byName.get("renditions_base_uq")).toContain("share_id IS NULL");
    expect(byName.get("renditions_share_uq")).toContain("share_id IS NOT NULL");
  });

  it("keeps the renditions kind CHECK, including the audio kinds", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='renditions'",
    ).first<{ sql: string }>();
    for (const kind of ["proxy_1080", "waveform_data", "spectrogram"])
      expect(row?.sql, kind).toContain(kind);
  });

  it("matches email case-insensitively, the way the login lookup assumes", async () => {
    /* users.email is COLLATE NOCASE in the DDL. A case-sensitive column would
       let two accounts share an address and break sign-in, and it would do it
       silently. */
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, settings_json, created_at) VALUES (?, 'Case', '{}', 1)",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "INSERT INTO users (id, workspace_id, email, name, role, created_at, updated_at) VALUES (?, ?, 'Mixed.Case@Example.com', 'Case', 'admin', 1, 1)",
    )
      .bind(id, id)
      .run();
    const found = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'mixed.case@example.com'",
    ).first<{ id: string }>();
    expect(found?.id).toBe(id);
  });

  it("cascades a delete through the foreign keys the schema declares", async () => {
    /* Deleting a project must take its assets with it. D1 enforces foreign
       keys; a migration that lost an ON DELETE CASCADE would leave orphans
       that nothing ever collects. */
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, settings_json, created_at) VALUES (?, 'Cascade', '{}', 1)",
      ).bind(id),
      env.DB.prepare(
        "INSERT INTO users (id, workspace_id, email, name, role, created_at, updated_at) VALUES (?, ?, ?, 'C', 'admin', 1, 1)",
      ).bind(id, id, `cascade-${id}@example.com`),
      env.DB.prepare(
        "INSERT INTO projects (id, workspace_id, name, palette, settings_json, created_by, created_at, updated_at) VALUES (?, ?, 'Cascade', 'kuwanomi', '{}', ?, 1, 1)",
      ).bind(id, id, id),
      env.DB.prepare(
        "INSERT INTO assets (id, project_id, name, kind, created_at, updated_at) VALUES (?, ?, 'clip.mov', 'video', 1, 1)",
      ).bind(id, id),
    ]);
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
    const left = await env.DB.prepare("SELECT id FROM assets WHERE id = ?")
      .bind(id)
      .first();
    expect(left).toBeNull();
  });

  it("refuses a foreign key that names nothing", async () => {
    /* The mirror of the cascade: enforcement is on, so a dangling reference
       is rejected rather than stored. */
    await expect(
      env.DB.prepare(
        "INSERT INTO assets (id, project_id, name, kind, created_at, updated_at) VALUES ('orphan', 'no-such-project', 'x.mov', 'video', 1, 1)",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("the API over D1, end to end", () => {
  /* A handful of requests, deliberately. Anything needing more belongs on the
     Node leg; see the note at the top of this file. */

  it("signed in over the real binding", () => {
    /* PBKDF2 at a hundred thousand iterations, verified through workerd's own
       WebCrypto rather than Node's. */
    expect(cookie).not.toBe("");
  });

  it("refuses an unauthenticated write", async () => {
    const denied = await req(h, "/api/v1/projects", {
      json: { name: "No Cookie" },
    });
    expect(denied.status).toBe(401);
  });

  it("creates a project and reads it back through the wire mapper", async () => {
    const created = await req(h, "/api/v1/projects", {
      cookie,
      json: { name: "Conformance Project" },
    });
    expect(created.status).toBe(201);
    const body = await json<Record<string, unknown>>(created);
    expect(body.name).toBe("Conformance Project");
    /* The wire contract holds on D1 as well: snake_case out, and no ORM
       column names or secrets riding along. */
    expect(forbiddenKeysIn(body)).toEqual([]);
    expect(Object.keys(body)).toContain("public_id");
    expect(Object.keys(body)).not.toContain("workspaceId");
  });

  it("serves the OpenAPI document from the registered routes", async () => {
    const spec = await req(h, "/api/v1/openapi.json");
    expect(spec.status).toBe(200);
    const doc = await json<{ paths: Record<string, unknown> }>(spec);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(50);
  });
});
