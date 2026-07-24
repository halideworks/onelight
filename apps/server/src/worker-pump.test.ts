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
import { sweepShuttleAudioJobs, sweepWatermarkJobs } from "./worker-pump.js";

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
        idempotencyKey: "reference-audio:v2:version-audio",
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
        idempotencyKey: "reference-audio:v2:version-100",
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
        idempotencyKey: "watermark:v2:version-1:share-1:spec-1",
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
