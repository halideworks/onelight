import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyNodeMigrations,
  assetVersions,
  assets,
  createNodeDb,
  jobs,
  projects,
  renditions,
  shareAssets,
  shares,
  uploadSessions,
  users,
  workspaces,
} from "@onelight/db";
import { CLIP_HASH_POSITIONS } from "@onelight/worker";
import {
  judgesTheVersion,
  startWorkerPump,
  sweepFingerprints,
  sweepReKindStills,
  sweepShuttleAudioJobs,
  sweepStillLadderJobs,
  sweepWatermarkJobs,
} from "./worker-pump.js";

describe("shuttle audio reconciliation", () => {
  it("queues one low-priority backfill for a ready version with audio", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "project-1",
          workspaceId: "ws-1",
          name: "Film",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(uploadSessions)
        .values([
          {
            id: "upload-audio",
            workspaceId: "ws-1",
            projectId: "project-1",
            createdBy: "user-1",
            clientFilename: "with-audio.mov",
            relativePath: "",
            size: 100,
            blobKey: "originals/with-audio.mov",
            status: "completed",
            createdAt: 1,
            completedAt: 1,
          },
          {
            id: "upload-silent",
            workspaceId: "ws-1",
            projectId: "project-1",
            createdBy: "user-1",
            clientFilename: "silent.mov",
            relativePath: "",
            size: 100,
            blobKey: "originals/silent.mov",
            status: "completed",
            createdAt: 2,
            completedAt: 2,
          },
        ])
        .run();
      await db
        .insert(assets)
        .values([
          {
            id: "asset-audio",
            projectId: "project-1",
            name: "With audio",
            kind: "video",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "asset-silent",
            projectId: "project-1",
            name: "Silent",
            kind: "video",
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        .run();
      await db
        .insert(assetVersions)
        .values([
          {
            id: "version-audio",
            assetId: "asset-audio",
            uploadSessionId: "upload-audio",
            versionNo: 1,
            originalBlobKey: "originals/with-audio.mov",
            originalFilename: "with-audio.mov",
            size: 100,
            checksumCrc32c: "",
            uploadedBy: "user-1",
            mediaInfoJson: JSON.stringify({
              streams: [{ codec_type: "video" }, { codec_type: "audio" }],
            }),
            transcodeStatus: "ready",
            createdAt: 1,
          },
          {
            id: "version-silent",
            assetId: "asset-silent",
            uploadSessionId: "upload-silent",
            versionNo: 1,
            originalBlobKey: "originals/silent.mov",
            originalFilename: "silent.mov",
            size: 100,
            checksumCrc32c: "",
            uploadedBy: "user-1",
            mediaInfoJson: JSON.stringify({
              streams: [{ codec_type: "video" }],
            }),
            transcodeStatus: "ready",
            createdAt: 2,
          },
        ])
        .run();

      expect(await sweepShuttleAudioJobs(db)).toBe(1);
      const queued = await db.select().from(jobs).all();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        kind: "transcode",
        idempotencyKey: "reference-audio:v3:version-audio",
        status: "queued",
        priority: -10,
      });
      expect(JSON.parse(queued[0]?.payloadJson ?? "{}")).toMatchObject({
        blob_key: "originals/with-audio.mov",
        version_id: "version-audio",
        secondary_only: "shuttle_audio",
      });
      expect(await sweepShuttleAudioJobs(db)).toBe(0);
      await db
        .update(jobs)
        .set({
          status: "failed",
          attempts: 5,
          finishedAt: 10,
          error: "old worker failed",
        })
        .run();
      expect(await sweepShuttleAudioJobs(db)).toBe(1);
      expect((await db.select().from(jobs).all())[0]).toMatchObject({
        status: "queued",
        attempts: 0,
        finishedAt: null,
        error: null,
      });

      await db
        .insert(renditions)
        .values([
          {
            id: "rendition-1x",
            versionId: "version-audio",
            kind: "reference_audio_1x",
            blobKey: "renditions/version-audio/reference_audio_1x.m4a",
            createdAt: 3,
          },
          {
            id: "rendition-2x",
            versionId: "version-audio",
            kind: "shuttle_audio_2x",
            blobKey: "renditions/version-audio/shuttle_audio_2x.m4a",
            createdAt: 3,
          },
          {
            id: "rendition-4x",
            versionId: "version-audio",
            kind: "shuttle_audio_4x",
            blobKey: "renditions/version-audio/shuttle_audio_4x.m4a",
            createdAt: 3,
          },
        ])
        .run();
      await db
        .insert(renditions)
        .values({
          id: "proxy-1080",
          versionId: "version-audio",
          kind: "proxy_1080",
          blobKey: "renditions/version-audio/proxy_1080.mp4",
          metaJson: JSON.stringify({
            frame_rate_num: 24000,
            frame_rate_den: 1001,
            height: 1080,
          }),
          createdAt: 3,
        })
        .run();
      await db.update(jobs).set({ status: "complete", finishedAt: 20 }).run();
      expect(await sweepShuttleAudioJobs(db)).toBe(1);
      expect((await db.select().from(jobs).all())[0]).toMatchObject({
        status: "queued",
        finishedAt: null,
      });

      await db
        .update(renditions)
        .set({
          metaJson: JSON.stringify({
            frame_rate_num: 24000,
            frame_rate_den: 1001,
            codec: "avc1.640c28",
            codec_contract_version: 2,
            coded_width: 1920,
            coded_height: 1080,
            bit_rate: 4500000,
            output_color: {
              primaries: "bt709",
              transfer: "bt709",
              matrix: "bt709",
              range: "tv",
              chromaLocation: "left",
            },
          }),
        })
        .where(eq(renditions.id, "proxy-1080"))
        .run();
      await db.update(jobs).set({ status: "complete", finishedAt: 30 }).run();
      expect(await sweepShuttleAudioJobs(db)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("scans beyond the oldest 100 ready versions", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "project-1",
          workspaceId: "ws-1",
          name: "Film",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      const indices = Array.from({ length: 101 }, (_, index) => index);
      await db
        .insert(uploadSessions)
        .values(
          indices.map((index) => ({
            id: `upload-${String(index)}`,
            workspaceId: "ws-1",
            projectId: "project-1",
            createdBy: "user-1",
            clientFilename: `clip-${String(index)}.mov`,
            relativePath: "",
            size: 100,
            blobKey: `originals/clip-${String(index)}.mov`,
            status: "completed" as const,
            createdAt: index + 1,
            completedAt: index + 1,
          })),
        )
        .run();
      await db
        .insert(assets)
        .values(
          indices.map((index) => ({
            id: `asset-${String(index)}`,
            projectId: "project-1",
            name: `Clip ${String(index)}`,
            kind: "video" as const,
            createdAt: index + 1,
            updatedAt: index + 1,
          })),
        )
        .run();
      await db
        .insert(assetVersions)
        .values(
          indices.map((index) => ({
            id: `version-${String(index)}`,
            assetId: `asset-${String(index)}`,
            uploadSessionId: `upload-${String(index)}`,
            versionNo: 1,
            originalBlobKey: `originals/clip-${String(index)}.mov`,
            originalFilename: `clip-${String(index)}.mov`,
            size: 100,
            checksumCrc32c: "",
            uploadedBy: "user-1",
            mediaInfoJson: JSON.stringify({
              streams:
                index === 100
                  ? [{ codec_type: "video" }, { codec_type: "audio" }]
                  : [{ codec_type: "video" }],
            }),
            transcodeStatus: "ready" as const,
            createdAt: index + 1,
          })),
        )
        .run();

      expect(await sweepShuttleAudioJobs(db)).toBe(1);
      expect((await db.select().from(jobs).all())[0]).toMatchObject({
        idempotencyKey: "reference-audio:v3:version-100",
        status: "queued",
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("watermark reconciliation", () => {
  it("backfills an incomplete burned rendition contract", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "project-1",
          workspaceId: "ws-1",
          name: "Film",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(uploadSessions)
        .values({
          id: "upload-1",
          workspaceId: "ws-1",
          projectId: "project-1",
          createdBy: "user-1",
          clientFilename: "picture.mov",
          relativePath: "",
          size: 100,
          blobKey: "originals/picture.mov",
          status: "completed",
          createdAt: 1,
          completedAt: 1,
        })
        .run();
      await db
        .insert(assets)
        .values({
          id: "asset-1",
          projectId: "project-1",
          name: "Picture",
          kind: "video",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(assetVersions)
        .values({
          id: "version-1",
          assetId: "asset-1",
          uploadSessionId: "upload-1",
          versionNo: 1,
          originalBlobKey: "originals/picture.mov",
          originalFilename: "picture.mov",
          size: 100,
          checksumCrc32c: "",
          uploadedBy: "user-1",
          frameRateNum: 24,
          frameRateDen: 1,
          mediaInfoJson: JSON.stringify({
            streams: [{ codec_type: "video" }],
          }),
          transcodeStatus: "ready",
          createdAt: 1,
        })
        .run();
      await db.update(assets).set({ currentVersionId: "version-1" }).run();
      await db
        .insert(shares)
        .values({
          id: "share-1",
          projectId: "project-1",
          slug: "share-slug",
          kind: "review",
          title: "Review",
          layout: "grid",
          allowDownload: "none",
          watermarkSpecJson: JSON.stringify({ text: "Review" }),
          watermarkSpecHash: "spec-1",
          createdBy: "user-1",
          createdAt: 1,
        })
        .run();
      await db
        .insert(shareAssets)
        .values({ shareId: "share-1", assetId: "asset-1", sortOrder: 0 })
        .run();
      await db
        .insert(renditions)
        .values([
          {
            id: "proxy-1",
            versionId: "version-1",
            kind: "proxy_1080",
            blobKey: "renditions/version-1/proxy_1080.mp4",
            metaJson: "{}",
            createdAt: 2,
          },
          {
            id: "burned-1",
            versionId: "version-1",
            kind: "watermarked",
            blobKey: "renditions/version-1/watermarked-old.mp4",
            metaJson: JSON.stringify({ spec_hash: "spec-1" }),
            shareId: "share-1",
            createdAt: 2,
          },
        ])
        .run();

      await sweepWatermarkJobs(db);
      const queued = await db.select().from(jobs).all();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        kind: "watermark",
        idempotencyKey: "watermark:v3:version-1:share-1:spec-1",
        status: "queued",
      });

      await db
        .update(renditions)
        .set({
          metaJson: JSON.stringify({
            spec_hash: "spec-1",
            frame_rate_num: 24,
            frame_rate_den: 1,
            codec: "avc1.64002A",
            codec_contract_version: 2,
            coded_width: 1920,
            coded_height: 1080,
            bit_rate: 4500000,
            output_color: {
              primaries: "bt709",
              transfer: "bt709",
              matrix: "bt709",
              range: "tv",
              chromaLocation: "left",
            },
          }),
        })
        .where(eq(renditions.id, "burned-1"))
        .run();
      await sweepWatermarkJobs(db);
      expect(await db.select().from(jobs).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("still ladder backfill", () => {
  const seedStill = async (
    db: ReturnType<typeof createNodeDb>["db"],
    options: { kinds: string[] },
  ): Promise<void> => {
    await db
      .insert(workspaces)
      .values({ id: "ws-1", name: "Studio", createdAt: 1 })
      .run();
    await db
      .insert(users)
      .values({
        id: "user-1",
        workspaceId: "ws-1",
        email: "owner@example.com",
        name: "Owner",
        role: "admin",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: "project-1",
        workspaceId: "ws-1",
        name: "Shoot",
        palette: "kuro",
        createdBy: "user-1",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(uploadSessions)
      .values({
        id: "upload-1",
        workspaceId: "ws-1",
        projectId: "project-1",
        createdBy: "user-1",
        clientFilename: "frame.jpg",
        relativePath: "",
        size: 10,
        checksumCrc32c: "abc",
        blobKey: "ws-1/project-1/uploads/upload-1/frame.jpg",
        status: "completed",
        createdAt: 1,
        completedAt: 1,
      })
      .run();
    await db
      .insert(assets)
      .values({
        id: "asset-1",
        projectId: "project-1",
        name: "frame.jpg",
        kind: "image",
        currentVersionId: "version-1",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(assetVersions)
      .values({
        id: "version-1",
        assetId: "asset-1",
        uploadSessionId: "upload-1",
        versionNo: 1,
        originalBlobKey: "ws-1/project-1/uploads/upload-1/frame.jpg",
        originalFilename: "frame.jpg",
        size: 10,
        checksumCrc32c: "abc",
        uploadedBy: "user-1",
        transcodeStatus: "ready",
        createdAt: 1,
      })
      .run();
    for (const [index, kind] of options.kinds.entries())
      await db
        .insert(renditions)
        .values({
          id: `rendition-${String(index)}`,
          versionId: "version-1",
          kind: kind as "poster",
          blobKey: `renditions/version-1/${kind}`,
          metaJson: "{}",
          size: 10,
          checksumSha256: "sha",
          createdAt: 1,
        })
        .run();
  };

  it("queues a rebuild for a JPEG whose poster ffmpeg never wrote", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      /* still_tiles alone is exactly what a JPEG uploaded before the ladder
         has: the old poster recipe emitted nothing for it. */
      await seedStill(db, { kinds: ["still_tiles"] });
      expect(await sweepStillLadderJobs(db)).toBe(1);
      const queued = await db.select().from(jobs).all();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        kind: "transcode",
        idempotencyKey: "stills:v1:version-1",
        status: "queued",
      });
      /* Below ordinary work: a backfill must never delay an upload happening
         now. */
      expect(queued[0]?.priority).toBeLessThan(0);
      /* Idempotent: a second pass adds nothing. */
      expect(await sweepStillLadderJobs(db)).toBe(0);
      expect(await db.select().from(jobs).all()).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  it("leaves a version that already has the ladder alone", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seedStill(db, { kinds: ["poster", "still_review"] });
      expect(await sweepStillLadderJobs(db)).toBe(0);
      expect(await db.select().from(jobs).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("fingerprint backfill for a library signed by the old scheme", () => {
  const seedLibrary = async (
    db: ReturnType<typeof createNodeDb>["db"],
    rows: Array<{
      id: string;
      kind: "image" | "video";
      contentHash: string | null;
      motionHash?: string;
      durationFrames?: number;
    }>,
  ): Promise<void> => {
    await db
      .insert(workspaces)
      .values({ id: "ws-1", name: "Studio", createdAt: 1 })
      .run();
    await db
      .insert(users)
      .values({
        id: "user-1",
        workspaceId: "ws-1",
        email: "owner@example.com",
        name: "Owner",
        role: "admin",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: "project-1",
        workspaceId: "ws-1",
        name: "Shoot",
        palette: "kuro",
        createdBy: "user-1",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    for (const [index, row] of rows.entries()) {
      await db
        .insert(uploadSessions)
        .values({
          id: `upload-${row.id}`,
          workspaceId: "ws-1",
          projectId: "project-1",
          createdBy: "user-1",
          clientFilename: `${row.id}.mov`,
          relativePath: "",
          size: 10,
          checksumCrc32c: "abc",
          blobKey: `ws-1/project-1/uploads/upload-${row.id}/${row.id}.mov`,
          status: "completed",
          createdAt: index + 1,
          completedAt: index + 1,
        })
        .run();
      await db
        .insert(assets)
        .values({
          id: `asset-${row.id}`,
          projectId: "project-1",
          name: `${row.id}.mov`,
          kind: row.kind,
          currentVersionId: row.id,
          createdAt: index + 1,
          updatedAt: index + 1,
        })
        .run();
      await db
        .insert(assetVersions)
        .values({
          id: row.id,
          assetId: `asset-${row.id}`,
          uploadSessionId: `upload-${row.id}`,
          versionNo: 1,
          originalBlobKey: `ws-1/project-1/${row.id}`,
          originalFilename: `${row.id}.mov`,
          size: 10,
          checksumCrc32c: "abc",
          uploadedBy: "user-1",
          transcodeStatus: "ready",
          ...(row.contentHash ? { contentHash: row.contentHash } : {}),
          ...(row.motionHash ? { motionHash: row.motionHash } : {}),
          ...(row.durationFrames === undefined
            ? {}
            : {
                durationFrames: row.durationFrames,
                frameRateNum: 24,
                frameRateDen: 1,
              }),
          createdAt: index + 1,
        })
        .run();
    }
  };

  const hashes = (count: number): string =>
    new Array(count).fill("0f0f0f0f0f0f0f0f").join(":");

  it("re-signs a clip signed at four points and leaves the current ones alone", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seedLibrary(db, [
        /* The old scheme: four points, no audio, no shot list. */
        { id: "stale-clip", kind: "video", contentHash: hashes(4) },
        /* The current one, silent, so it will never gain an audio hash and
           must not be swept forever on account of it. */
        {
          id: "current-clip",
          kind: "video",
          contentHash: hashes(CLIP_HASH_POSITIONS.length),
          motionHash: "0f0f0f0f0f0f0f0f",
        },
        /* A still is signed once by design and is not stale. */
        { id: "still", kind: "image", contentHash: "0f0f0f0f0f0f0f0f" },
      ]);
      expect(await sweepFingerprints(db)).toBe(1);
      const queued = await db.select().from(jobs).all();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.kind).toBe("fingerprint");
      expect(queued[0]?.priority).toBeLessThan(0);
      const payload = JSON.parse(queued[0]?.payloadJson ?? "{}") as {
        version_ids: string[];
      };
      expect(payload.version_ids).toEqual(["stale-clip"]);
      /* Idempotent: a second pass adds nothing. */
      expect(await sweepFingerprints(db)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("leaves a version alone while the job signing it is still in flight", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      /* Twenty-six stale clips: two batches. Signing twenty-five clips takes
         minutes and the sweep comes round every minute, so the second pass
         happens while the first job is still working. */
      await seedLibrary(
        db,
        Array.from({ length: 26 }, (_, index) => ({
          id: `clip-${String(index).padStart(2, "0")}`,
          kind: "video" as const,
          contentHash: hashes(4),
          motionHash: "3f3f3f3f3f3f3f3f",
        })),
      );
      expect(await sweepFingerprints(db)).toBe(2);
      const queued = await db.select().from(jobs).all();
      const batches = queued.map(
        (row) =>
          (JSON.parse(row.payloadJson) as { version_ids: string[] })
            .version_ids,
      );
      const big = batches.find((batch) => batch.length > 1) ?? [];
      const small = batches.find((batch) => batch.length === 1) ?? [];
      expect(big).toHaveLength(25);
      /* All but one of the big batch lands, which shifts every slice
         boundary: the leftover becomes the lead of a new batch and the small
         batch's member falls in behind it. Its job's key cannot see that, so
         without a read of what is in flight the same clip is signed twice. */
      for (const id of big.slice(0, 24))
        await db
          .update(assetVersions)
          .set({ contentHash: hashes(CLIP_HASH_POSITIONS.length) })
          .where(eq(assetVersions.id, id))
          .run();
      expect(await sweepFingerprints(db)).toBe(0);
      const after = await db.select().from(jobs).all();
      expect(after).toHaveLength(2);
      /* And the two still in flight are exactly the two nobody re-offered. */
      expect([...big.slice(24), ...small].sort()).toEqual(
        ["clip-00", big[24] as string].sort(),
      );
    } finally {
      sqlite.close();
    }
  });

  it("leaves a clip too short to hold the full grid alone", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seedLibrary(db, [
        /* One frame at 24fps: 41 ms, signed at one point on purpose. A short
           signature is not evidence of the old scheme here, and offering it
           again every minute forever is what the naive test would do. */
        {
          id: "one-frame",
          kind: "video",
          contentHash: "0f0f0f0f0f0f0f0f",
          motionHash: "1f1f1f1f1f1f1f1f",
          durationFrames: 1,
        },
        /* Thirty seconds, signed at four: that one really is stale. */
        {
          id: "stale-spot",
          kind: "video",
          contentHash: hashes(4),
          motionHash: "2f2f2f2f2f2f2f2f",
          durationFrames: 720,
        },
      ]);
      expect(await sweepFingerprints(db)).toBe(1);
      const payload = JSON.parse(
        (await db.select().from(jobs).all())[0]?.payloadJson ?? "{}",
      ) as { version_ids: string[] };
      expect(payload.version_ids).toEqual(["stale-spot"]);
    } finally {
      sqlite.close();
    }
  });

  it("re-signs a clip that has no motion contour", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seedLibrary(db, [
        /* Signed by the current sampler, but before the motion contour
           existed: the tier that answers a silent colour pass has nothing to
           work with until this is re-signed. */
        {
          id: "no-motion",
          kind: "video",
          contentHash: hashes(CLIP_HASH_POSITIONS.length),
          durationFrames: 720,
        },
        {
          id: "complete",
          kind: "video",
          contentHash: hashes(CLIP_HASH_POSITIONS.length),
          motionHash: "0f0f0f0f0f0f0f0f",
          durationFrames: 720,
        },
        /* A still has no motion by definition and must be left alone. */
        {
          id: "still",
          kind: "image",
          contentHash: "0f0f0f0f0f0f0f0f",
        },
      ]);
      expect(await sweepFingerprints(db)).toBe(1);
      const payload = JSON.parse(
        (await db.select().from(jobs).all())[0]?.payloadJson ?? "{}",
      ) as { version_ids: string[] };
      expect(payload.version_ids).toEqual(["no-motion"]);
    } finally {
      sqlite.close();
    }
  });

  it("still picks up a version nothing has ever looked at", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seedLibrary(db, [
        { id: "unsigned", kind: "image", contentHash: null },
      ]);
      expect(await sweepFingerprints(db)).toBe(1);
      const payload = JSON.parse(
        (await db.select().from(jobs).all())[0]?.payloadJson ?? "{}",
      ) as { version_ids: string[] };
      expect(payload.version_ids).toEqual(["unsigned"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("re-kinding files that have become stills", () => {
  it("turns a RAW uploaded before there was a decoder into an image", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "project-1",
          workspaceId: "ws-1",
          name: "Shoot",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      /* Two hundred and fifty plain files go in FIRST, so they are what a
         sweep reading one unordered batch would see: without the keyset walk
         the RAW behind them is never reached, and this test fails. */
      await db
        .insert(assets)
        .values(
          Array.from({ length: 250 }, (_, index) => ({
            id: `asset-filler-${String(index).padStart(4, "0")}`,
            projectId: "project-1",
            name: `notes-${String(index)}.txt`,
            kind: "file" as const,
            createdAt: 1,
            updatedAt: 1,
          })),
        )
        .run();
      await db
        .insert(assets)
        .values([
          {
            id: "asset-raw",
            projectId: "project-1",
            name: "IMG_0431.CR3",
            kind: "file",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "asset-heic",
            projectId: "project-1",
            name: "IMG_0432.heic",
            kind: "file",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "asset-zip",
            projectId: "project-1",
            name: "deliverables.zip",
            kind: "file",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        .run();
      expect(await sweepReKindStills(db)).toBe(2);
      const rows = await db.select().from(assets).all();
      const byId = new Map(rows.map((row) => [row.id, row.kind]));
      expect(byId.get("asset-raw")).toBe("image");
      expect(byId.get("asset-heic")).toBe("image");
      /* Everything else is still a file, which is the point of the check. */
      expect(byId.get("asset-zip")).toBe("file");
      expect(await sweepReKindStills(db)).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});

describe("fingerprint jobs, against a stand-in worker", () => {
  /* The pump and the worker agree on an envelope: everything the worker
     returns is nested under `result`, as media_info and renditions are.
     Reading fingerprints from the top level instead typechecked on both
     sides and killed every job three times over, so the contract is tested
     where it actually lives: over HTTP, through the real pump. */
  it("writes what the worker answers onto the upload and the version", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    const answered: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          const parsed = JSON.parse(body) as {
            job_id: string;
            kind: string;
            sources?: Array<{ id: string }>;
          };
          answered.push(parsed.kind);
          jobResults.set(parsed.job_id, {
            job_id: parsed.job_id,
            status: "complete",
            /* Exactly the shape apps/worker sends. */
            result: {
              fingerprints: (parsed.sources ?? []).map((source) => ({
                id: source.id,
                content_hash: "0f1e2d3c4b5a6978",
                capture_key: "2026:07:29 14:03:11.470|nikon z 9|",
                audio_hash: "cd95422f42931325",
                state: "ready" as const,
              })),
            },
          });
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      const id = (request.url ?? "").split("?")[0]?.split("/").pop() ?? "";
      const result = jobResults.get(id);
      response.writeHead(result ? 200 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(result ?? { error: "not found" }));
    });
    const jobResults = new Map<string, unknown>();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    let stop: (() => void) | undefined;
    try {
      await db
        .insert(workspaces)
        .values({ id: "ws-1", name: "Studio", createdAt: 1 })
        .run();
      await db
        .insert(users)
        .values({
          id: "user-1",
          workspaceId: "ws-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(projects)
        .values({
          id: "project-1",
          workspaceId: "ws-1",
          name: "Shoot",
          palette: "kuro",
          createdBy: "user-1",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      await db
        .insert(uploadSessions)
        .values({
          id: "upload-1",
          workspaceId: "ws-1",
          projectId: "project-1",
          createdBy: "user-1",
          clientFilename: "renamed.tif",
          relativePath: "",
          size: 10,
          checksumCrc32c: "abc",
          blobKey: "ws-1/project-1/uploads/upload-1/renamed.tif",
          status: "completed",
          createdAt: 1,
          completedAt: 1,
        })
        .run();
      await db
        .insert(jobs)
        .values({
          id: "job-print",
          kind: "fingerprint",
          payloadJson: JSON.stringify({
            workspace_id: "ws-1",
            project_id: "project-1",
            upload_ids: ["upload-1"],
          }),
          idempotencyKey: "fingerprint:test",
          status: "queued",
          priority: 1,
          capabilityJson: "{}",
          maxAttempts: 3,
          attempts: 0,
          runAfter: Date.now(),
          createdAt: Date.now(),
        })
        .run();

      stop = startWorkerPump(db, {
        workerUrl: `http://127.0.0.1:${String(port)}`,
        workerSecret: "test-secret",
        blobRoot: "/tmp",
      });

      const deadline = Date.now() + 15_000;
      let row: { contentHash: string | null } | undefined;
      while (Date.now() < deadline) {
        row = (
          await db
            .select()
            .from(uploadSessions)
            .where(eq(uploadSessions.id, "upload-1"))
            .all()
        )[0];
        if (row?.contentHash) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(answered).toContain("fingerprint");
      expect(row?.contentHash).toBe("0f1e2d3c4b5a6978");
      const finished = (
        await db
          .select()
          .from(uploadSessions)
          .where(eq(uploadSessions.id, "upload-1"))
          .all()
      )[0];
      expect(finished?.captureKey).toContain("nikon z 9");
      /* The sound too: the matcher reads it off the upload session, and the
         last time an answer was read from the wrong place in this envelope
         every job died silently. */
      expect(finished?.audioHash).toBe("cd95422f42931325");
      expect(finished?.fingerprintState).toBe("ready");
    } finally {
      stop?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sqlite.close();
    }
  }, 20_000);
});

describe("which dead jobs condemn their version", () => {
  /* A zoom rung is rendered on demand, long after the version was ready. Its
     job dying says nothing about the version, and marking a months-old ready
     asset failed because an optional rendition could not be built is worse
     than not having the rung. */
  it("spares a version when the job asked for one named rendition", () => {
    expect(judgesTheVersion({ version_id: "v1", only: ["still_full"] })).toBe(
      false,
    );
    expect(judgesTheVersion({ version_id: "v1", only: ["proxy_1080"] })).toBe(
      false,
    );
  });

  it("spares a version for the shuttle audio pass", () => {
    expect(
      judgesTheVersion({ version_id: "v1", secondary_only: "shuttle_audio" }),
    ).toBe(false);
  });

  it("condemns it for the primary pipeline", () => {
    expect(judgesTheVersion({ version_id: "v1" })).toBe(true);
    expect(judgesTheVersion({ version_id: "v1", only: [] })).toBe(true);
  });
});
