import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyNodeMigrations,
  assets,
  assetVersions,
  createNodeDb,
  projects,
  shares,
  uploadSessions,
  users,
  workspaces,
} from "@onelight/db";
import type { BlobStore } from "@onelight/core";
import type { MailMessage, Mailer } from "./mailer.js";
import {
  DEFAULT_GC_INTERVAL_MS,
  DEFAULT_TRASH_PURGE_AFTER_MS,
  DEFAULT_UPLOAD_REAP_AFTER_MS,
  backupReferencedBlobKeys,
  diffOrphanBlobs,
  maintenanceConfigFromEnv,
  referencedBlobKeys,
  notificationDeepLink,
  planEmailSweep,
  reapUploadSessions,
  subjectForKind,
  walkBlobObjects,
} from "./maintenance.js";
import type { SweepNotificationRow } from "./maintenance.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const row = (
  overrides: Partial<SweepNotificationRow> & { id: string },
): SweepNotificationRow => ({
  userId: "user-1",
  kind: "comment.created",
  payloadJson: JSON.stringify({
    project_id: "proj",
    asset_id: "asset",
    preview: "Looks good",
  }),
  createdAt: 1_000,
  email: "user@example.com",
  mode: "instant",
  ...overrides,
});

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe("notificationDeepLink", () => {
  it("builds the project asset link with an optional frame", () => {
    expect(
      notificationDeepLink("https://onelight.example.com/", {
        project_id: "p1",
        asset_id: "a1",
      }),
    ).toBe("https://onelight.example.com/projects/p1/assets/a1");
    expect(
      notificationDeepLink("https://onelight.example.com", {
        project_id: "p1",
        asset_id: "a1",
        frame: 240,
      }),
    ).toBe("https://onelight.example.com/projects/p1/assets/a1?f=240");
  });

  it("returns null without both ids and ignores a non-integer frame", () => {
    expect(notificationDeepLink("https://x.test", { project_id: "p1" })).toBe(
      null,
    );
    expect(notificationDeepLink("https://x.test", { asset_id: "a1" })).toBe(
      null,
    );
    expect(
      notificationDeepLink("https://x.test", {
        project_id: "p1",
        asset_id: "a1",
        frame: 1.5,
      }),
    ).toBe("https://x.test/projects/p1/assets/a1");
  });
});

describe("planEmailSweep", () => {
  it("sends one email per notification in instant mode", () => {
    const now = 10 * HOUR;
    const plan = planEmailSweep(
      [
        row({ id: "n1" }),
        row({ id: "n2", kind: "approval.updated", createdAt: 2_000 }),
      ],
      now,
      "https://x.test",
    );
    expect(plan.skippedIds).toEqual([]);
    expect(plan.emails).toHaveLength(2);
    expect(plan.emails[0]).toMatchObject({
      to: "user@example.com",
      subject: subjectForKind("comment.created"),
      notificationIds: ["n1"],
    });
    expect(plan.emails[0]?.text).toContain("Looks good");
    expect(plan.emails[0]?.text).toContain(
      "https://x.test/projects/proj/assets/asset",
    );
    expect(plan.emails[1]?.notificationIds).toEqual(["n2"]);
  });

  it("holds hourly digests until the oldest row is an hour old", () => {
    const rows = [
      row({ id: "n1", mode: "hourly", createdAt: 1_000 }),
      row({ id: "n2", mode: "hourly", createdAt: 2_000 }),
    ];
    const early = planEmailSweep(rows, 1_000 + HOUR - 1, "https://x.test");
    expect(early.emails).toEqual([]);
    const due = planEmailSweep(rows, 1_000 + HOUR, "https://x.test");
    expect(due.emails).toHaveLength(1);
    expect(due.emails[0]?.notificationIds).toEqual(["n1", "n2"]);
    expect(due.emails[0]?.subject).toContain("2 new notifications");
  });

  it("holds daily digests for 24 hours", () => {
    const rows = [row({ id: "n1", mode: "daily", createdAt: 5_000 })];
    expect(
      planEmailSweep(rows, 5_000 + DAY - 1, "https://x.test").emails,
    ).toEqual([]);
    const due = planEmailSweep(rows, 5_000 + DAY, "https://x.test");
    expect(due.emails).toHaveLength(1);
    expect(due.emails[0]?.notificationIds).toEqual(["n1"]);
  });

  it("groups digests per user and mixes modes independently", () => {
    const now = 2 * DAY;
    const plan = planEmailSweep(
      [
        row({ id: "a1", userId: "instant-user", email: "i@example.com" }),
        row({
          id: "b1",
          userId: "hourly-user",
          email: "h@example.com",
          mode: "hourly",
          createdAt: now - 2 * HOUR,
        }),
        row({
          id: "b2",
          userId: "hourly-user",
          email: "h@example.com",
          mode: "hourly",
          createdAt: now - 1,
        }),
        row({
          id: "c1",
          userId: "daily-user",
          email: "d@example.com",
          mode: "daily",
          createdAt: now - HOUR,
        }),
      ],
      now,
      "https://x.test",
    );
    expect(plan.emails).toHaveLength(2);
    const digest = plan.emails.find((email) => email.to === "h@example.com");
    expect(digest?.notificationIds).toEqual(["b1", "b2"]);
    expect(
      plan.emails.find((email) => email.to === "d@example.com"),
    ).toBeUndefined();
  });

  it("skips rows without a recipient address", () => {
    const plan = planEmailSweep(
      [row({ id: "n1", email: "  " }), row({ id: "n2" })],
      0,
      "https://x.test",
    );
    expect(plan.skippedIds).toEqual(["n1"]);
    expect(plan.emails).toHaveLength(1);
  });

  it("drives an injected fake mailer with the planned batches", async () => {
    const mailer = new FakeMailer();
    const now = 3 * HOUR;
    const plan = planEmailSweep(
      [
        row({ id: "n1" }),
        row({
          id: "n2",
          userId: "hourly-user",
          email: "h@example.com",
          mode: "hourly",
          createdAt: now - 2 * HOUR,
        }),
      ],
      now,
      "https://x.test",
    );
    const marked: string[] = [];
    for (const email of plan.emails) {
      await mailer.send(email);
      marked.push(...email.notificationIds);
    }
    expect(mailer.sent.map((message) => message.to)).toEqual([
      "user@example.com",
      "h@example.com",
    ]);
    expect(marked.sort()).toEqual(["n1", "n2"]);
  });
});

describe("maintenanceConfigFromEnv", () => {
  const base = {
    publicUrl: "https://x.test",
    blobStore: { delete: () => Promise.resolve() } as never,
  };

  it("applies defaults", () => {
    const config = maintenanceConfigFromEnv({}, base);
    expect(config.uploadReapAfterMs).toBe(DEFAULT_UPLOAD_REAP_AFTER_MS);
    expect(config.trashPurgeAfterMs).toBe(DEFAULT_TRASH_PURGE_AFTER_MS);
    expect(config.gcIntervalMs).toBe(DEFAULT_GC_INTERVAL_MS);
    expect(config.gcDelete).toBe(false);
  });

  it("reads overrides and rejects nonsense values", () => {
    const config = maintenanceConfigFromEnv(
      {
        UPLOAD_REAP_AFTER_MS: "60000",
        TRASH_PURGE_AFTER_MS: "-5",
        GC_INTERVAL_MS: "oops",
        ONELIGHT_GC_DELETE: "true",
      },
      base,
    );
    expect(config.uploadReapAfterMs).toBe(60_000);
    expect(config.trashPurgeAfterMs).toBe(DEFAULT_TRASH_PURGE_AFTER_MS);
    expect(config.gcIntervalMs).toBe(DEFAULT_GC_INTERVAL_MS);
    expect(config.gcDelete).toBe(true);
  });
});

describe("upload session reaping", () => {
  it("removes every stale terminal state but protects live versions", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    const now = 10 * DAY;
    const staleAt = now - 2 * DAY;
    const deleted: string[] = [];
    const aborted: string[] = [];
    const store = {
      delete(key: string) {
        deleted.push(key);
        return Promise.resolve();
      },
      abortMultipart(uploadId: string) {
        aborted.push(uploadId);
        return Promise.resolve();
      },
    } as unknown as BlobStore;
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1_000 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "a@example.com",
          name: "A",
          role: "admin",
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "proj-1",
          workspaceId: "ws-1",
          name: "Film",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        .run();
      const session = (
        id: string,
        status:
          "pending" | "uploading" | "completed" | "quarantined" | "aborted",
        createdAt: number,
        completedAt: number | null = null,
      ) => ({
        id,
        workspaceId: "ws-1",
        projectId: "proj-1",
        createdBy: "user-1",
        clientFilename: `${id}.bin`,
        relativePath: "",
        size: 4,
        checksumCrc32c: null,
        blobKey: `uploads/${id}.bin`,
        uploadId: `multipart-${id}`,
        partSize: 8,
        status,
        createdAt,
        completedAt,
      });
      await db
        .insert(uploadSessions)
        .values([
          session("stale-pending", "pending", staleAt),
          session("stale-quarantined", "quarantined", staleAt),
          session("stale-aborted", "aborted", staleAt),
          session("stale-completed", "completed", staleAt, staleAt),
          session("fresh-uploading", "uploading", now),
          session("fresh-completed", "completed", staleAt, now),
          session("referenced-completed", "completed", staleAt, staleAt),
        ])
        .run();
      await db
        .insert(assets)
        .values({
          id: "asset-1",
          projectId: "proj-1",
          name: "Kept",
          kind: "video",
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        .run();
      await db
        .insert(assetVersions)
        .values({
          id: "version-1",
          assetId: "asset-1",
          uploadSessionId: "referenced-completed",
          versionNo: 1,
          originalBlobKey: "uploads/referenced-completed.bin",
          originalFilename: "kept.bin",
          size: 4,
          checksumCrc32c: "",
          uploadedBy: "user-1",
          createdAt: 1_000,
        })
        .run();

      await reapUploadSessions(db, store, now, DAY);

      expect(
        (await db.select({ id: uploadSessions.id }).from(uploadSessions).all())
          .map((row) => row.id)
          .sort(),
      ).toEqual(["fresh-completed", "fresh-uploading", "referenced-completed"]);
      expect(deleted.sort()).toEqual([
        "uploads/stale-aborted.bin",
        "uploads/stale-completed.bin",
        "uploads/stale-pending.bin",
        "uploads/stale-quarantined.bin",
      ]);
      expect(aborted.sort()).toEqual([
        "multipart-stale-aborted",
        "multipart-stale-completed",
        "multipart-stale-pending",
        "multipart-stale-quarantined",
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe("blob gc diff", () => {
  it("walks a blob root and diffs object keys against referenced keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "onelight-gc-"));
    try {
      await mkdir(path.join(root, "renditions", "v1"), { recursive: true });
      await mkdir(path.join(root, ".multipart", "u1"), { recursive: true });
      await writeFile(path.join(root, "originals.bin"), "original");
      await writeFile(
        path.join(root, "renditions", "v1", "proxy_1080.mp4"),
        "proxy",
      );
      await writeFile(
        path.join(root, "renditions", "v1", "stray.mp4"),
        "stray-bytes",
      );
      await writeFile(
        path.join(root, ".multipart", "u1", "manifest.json"),
        "{}",
      );
      await writeFile(path.join(root, "upload.tmp-abc123"), "partial");
      const old = new Date(Date.now() - 48 * HOUR);
      await utimes(path.join(root, "renditions", "v1", "stray.mp4"), old, old);
      const objects = await walkBlobObjects(root);
      expect(objects.map((object) => object.key).sort()).toEqual([
        "originals.bin",
        "renditions/v1/proxy_1080.mp4",
        "renditions/v1/stray.mp4",
      ]);
      const orphans = diffOrphanBlobs(
        objects,
        new Set(["originals.bin", "renditions/v1/proxy_1080.mp4"]),
      );
      expect(orphans).toHaveLength(1);
      expect(orphans[0]).toMatchObject({
        key: "renditions/v1/stray.mp4",
        size: 11,
      });
      expect(Date.now() - (orphans[0]?.mtimeMs ?? 0)).toBeGreaterThan(
        24 * HOUR,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /* A blob the live DB no longer references but a retained backup still does
     must be protected, or the sweep deletes it out from under a snapshot you
     might restore. */
  it("protects blobs a retained backup manifest still references", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "onelight-bkm-"));
    try {
      await writeFile(
        path.join(dir, "onelight-20260716-120000.manifest.json"),
        JSON.stringify({
          created_at: "2026-07-16T12:00:00.000Z",
          blob_keys: ["renditions/v9/proxy_1080.mp4"],
        }),
      );
      const protectedByBackup = backupReferencedBlobKeys(dir);
      expect(protectedByBackup.has("renditions/v9/proxy_1080.mp4")).toBe(true);
      // Live DB references nothing, but the backup does: unioning the two keeps
      // the blob off the orphan list.
      const objects = [
        { key: "renditions/v9/proxy_1080.mp4", size: 5, mtimeMs: 0 },
      ];
      const referenced = new Set<string>();
      for (const key of protectedByBackup) referenced.add(key);
      expect(diffOrphanBlobs(objects, referenced)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /* Avatars sit under the same blob root as renditions, so a table missing
     from referencedBlobKeys is not a missed cleanup: it is a delete. This
     shipped, and every avatar vanished a day after upload. */
  it("counts user avatars as referenced", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1_000 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "a@example.com",
          name: "A",
          role: "admin",
          avatarKey: "avatars/user-1.jpg",
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        .run();
      const keys = await referencedBlobKeys(db);
      expect(keys.has("avatars/user-1.jpg")).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  /* A share logo's only reference is shares.brand_json.logo_key -- no column of
     its own. Same failure mode as avatars: omit it and the GC deletes a live
     logo. This test fails the moment that pass is dropped. */
  it("counts share logos (brand_json.logo_key) as referenced", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1_000 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "a@example.com",
          name: "A",
          role: "admin",
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "proj-1",
          workspaceId: "ws-1",
          name: "Film",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1_000,
          updatedAt: 1_000,
        })
        .run();
      await db
        .insert(shares)
        .values({
          id: "share-1",
          projectId: "proj-1",
          slug: "s-abc",
          kind: "review",
          title: "Client review",
          layout: "grid",
          allowDownload: "none",
          brandJson: JSON.stringify({
            logo_key: "ws-1/sharelogos/share-1-x.svg",
          }),
          createdBy: "user-1",
          createdAt: 1_000,
        })
        .run();
      const keys = await referencedBlobKeys(db);
      expect(keys.has("ws-1/sharelogos/share-1-x.svg")).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
