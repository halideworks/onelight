import { describe, expect, it } from "vitest";
import {
  applyNodeMigrations,
  assets,
  createNodeDb,
  projects,
  shareAssets,
  shares,
  users,
  workspaces,
} from "@onelight/db";
import type { AppDb } from "@onelight/db";
import { buildShareOgTags } from "./og.js";

const PUBLIC_URL = "http://test.local";

const makeDb = (): AppDb => {
  const { db, sqlite } = createNodeDb(":memory:");
  applyNodeMigrations(sqlite);
  return db;
};

type ShareOverrides = Partial<typeof shares.$inferInsert> & {
  assetCount?: number;
};

// Seeds the FK chain (workspace, user, project) plus one share and its
// share_assets rows, all via direct inserts: buildShareOgTags never
// touches sessions or auth, so the HTTP surface is not needed here.
const seedShare = async (db: AppDb, overrides: ShareOverrides = {}) => {
  const now = Date.now();
  const { assetCount = 2, ...shareOverrides } = overrides;
  await db
    .insert(workspaces)
    .values({ id: "ws1", name: "Test", createdAt: now })
    .run();
  await db
    .insert(users)
    .values({
      id: "user1",
      workspaceId: "ws1",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await db
    .insert(projects)
    .values({
      id: "proj1",
      workspaceId: "ws1",
      name: "Spot",
      palette: "ajisai",
      createdBy: "user1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await db
    .insert(shares)
    .values({
      id: "share1",
      projectId: "proj1",
      slug: "test-slug",
      kind: "review",
      title: "Cut 04",
      layout: "grid",
      passphraseHash: null,
      expiresAt: null,
      allowDownload: "none",
      allowComments: true,
      showAllVersions: false,
      createdBy: "user1",
      revokedAt: null,
      createdAt: now,
      ...shareOverrides,
    })
    .run();
  for (let index = 0; index < assetCount; index += 1) {
    const assetId = `asset${index}`;
    await db
      .insert(assets)
      .values({
        id: assetId,
        projectId: "proj1",
        name: `Asset ${index}`,
        kind: "video",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(shareAssets)
      .values({ shareId: "share1", assetId, sortOrder: index })
      .run();
  }
};

describe("buildShareOgTags", () => {
  it("emits escaped tags for a valid share", async () => {
    const db = makeDb();
    await seedShare(db, {
      title: `"Rough" <Cut> & Friend's Notes`,
    });
    const tags = await buildShareOgTags(db, "test-slug", PUBLIC_URL);
    expect(tags).not.toBeNull();
    expect(tags).toContain(
      'content="&quot;Rough&quot; &lt;Cut&gt; &amp; Friend&#39;s Notes"',
    );
    expect(tags).not.toContain("<Cut>");
    expect(tags).toContain(
      '<meta property="og:description" content="2 items for review on Onelight">',
    );
    expect(tags).toContain('<meta property="og:type" content="website">');
    expect(tags).toContain(
      '<meta property="og:url" content="http://test.local/s/test-slug">',
    );
    expect(tags).not.toContain("og:image");
  });

  it("describes presentation shares by kind and pluralizes correctly", async () => {
    const db = makeDb();
    await seedShare(db, { kind: "presentation", assetCount: 1 });
    const tags = await buildShareOgTags(db, "test-slug", PUBLIC_URL);
    expect(tags).toContain(
      '<meta property="og:description" content="1 item in a presentation on Onelight">',
    );
  });

  it("emits only generic tags for a passphrase-protected share", async () => {
    const db = makeDb();
    await seedShare(db, {
      title: "Secret Client Cut",
      passphraseHash: "fake-hash",
    });
    const tags = await buildShareOgTags(db, "test-slug", PUBLIC_URL);
    expect(tags).not.toBeNull();
    expect(tags).toContain(
      '<meta property="og:title" content="Protected share">',
    );
    expect(tags).not.toContain("Secret Client Cut");
    expect(tags).not.toContain("items");
    expect(tags).toContain(
      '<meta property="og:url" content="http://test.local/s/test-slug">',
    );
    expect(tags).not.toContain("og:image");
  });

  it("returns null for a revoked share", async () => {
    const db = makeDb();
    await seedShare(db, { revokedAt: Date.now() - 1000 });
    expect(await buildShareOgTags(db, "test-slug", PUBLIC_URL)).toBeNull();
  });

  it("returns null for an expired share", async () => {
    const db = makeDb();
    await seedShare(db, { expiresAt: Date.now() - 1000 });
    expect(await buildShareOgTags(db, "test-slug", PUBLIC_URL)).toBeNull();
  });

  it("still resolves a share expiring in the future", async () => {
    const db = makeDb();
    await seedShare(db, { expiresAt: Date.now() + 60_000 });
    expect(await buildShareOgTags(db, "test-slug", PUBLIC_URL)).not.toBeNull();
  });

  it("returns null for an unknown slug", async () => {
    const db = makeDb();
    await seedShare(db);
    expect(await buildShareOgTags(db, "no-such-slug", PUBLIC_URL)).toBeNull();
  });
});
