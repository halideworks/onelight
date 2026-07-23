import { describe, expect, it } from "vitest";
import {
  applyNodeMigrations,
  assetVersions,
  assets,
  createNodeDb,
  jobs,
  projects,
  renditions,
  uploadSessions,
  users,
  workspaces,
} from "@onelight/db";
import { sweepShuttleAudioJobs } from "./worker-pump.js";

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
        idempotencyKey: "shuttle-audio:v1:version-audio",
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
        .insert(renditions)
        .values([
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
});
