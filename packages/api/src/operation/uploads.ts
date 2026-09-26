import {
  errors,
  isStillSource,
  crc32cStream,
  crc32cMatches,
  stackKeyOf,
} from "@onelight/core";
import {
  uploadSessions,
  uploadParts,
  assets,
  assetVersions,
  projects,
  jobs,
} from "@onelight/db/schema";
import { eq, asc, sql } from "drizzle-orm";
import { MAX_MULTIPART_PARTS, MAX_MULTIPART_PART_BYTES } from "../limits.js";
import type { Context } from "hono";
import type { Variables, AppEnv } from "../types.js";
import { limitStream } from "../helpers.js";
import type { Blobs } from "./blobs.js";
import { uploadWire } from "../wire.js";
import type { Access } from "./access.js";
import type { Activity } from "./activity.js";

export const createUploads = (
  env: AppEnv,
  blobs: Blobs,
  access: Access,
  activity: Activity,
) => {
  const { requireBlobStore } = blobs;
  const { newAssetPublicId } = access;
  const { appendProjectEvent } = activity;

  /* The name a file is stored under. Separators are flattened so a client
     cannot describe a directory, and a name that is only dots is refused
     outright: "uploads/<ulid>/.." names the directory above rather than a
     file in it, and a store that took it would be writing somewhere nobody
     asked for. */
  const storedFilename = (raw: string): string => {
    const flattened = raw.replace(/[\\/]/g, "_").trim();
    if (!flattened || /^\.+$/.test(flattened))
      throw errors.validation("Filename is not usable.");
    return flattened;
  };

  /* A cover is put straight into an <img>, so "is this an image" means "will a
     browser draw it", not "is it pictorial". assetKind() calls EXR, DPX and TIFF
     images -- correctly, for footage -- and no browser renders any of them, so
     accepting one would set a cover that silently never appears. This list
     matches what blobContentType can actually label. */
  const isImageFilename = (filename: string): boolean =>
    ["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(
      filename.toLowerCase().split(".").pop() ?? "",
    );

  const assetKind = (
    filename: string,
  ): "video" | "audio" | "image" | "pdf" | "file" => {
    const extension = filename.toLowerCase().split(".").pop();
    if (
      ["mov", "mp4", "mxf", "webm", "avi", "mkv", "prores"].includes(
        extension ?? "",
      )
    )
      return "video";
    if (
      ["wav", "aif", "aiff", "mp3", "aac", "flac", "m4a"].includes(
        extension ?? "",
      )
    )
      return "audio";
    /* What the stills pipeline can render, and nothing else: a file that
       lands as "image" and cannot be decoded is a card with no picture, which
       is worse than an honest "file". The table is in core (stills-format.ts)
       so the API, the worker and the review room cannot disagree about it: it
       covers what sharp opens, Photoshop's two containers, the camera RAW
       families through libraw, and HEIC through libheif. */
    if (isStillSource(filename)) return "image";
    if (extension === "pdf") return "pdf";
    return "file";
  };

  /* The multipart engine, shared between the member endpoints and the
     transfer request endpoints so the two flows cannot drift: same init,
     same part persistence, same verification and quarantine on complete. */
  const startMultipart = async (
    upload: typeof uploadSessions.$inferSelect,
  ): Promise<{
    upload: typeof uploadSessions.$inferSelect;
    uploadId?: string;
    partSize?: number;
  }> => {
    const store = requireBlobStore();
    if (upload.status === "completed") return { upload };
    if (upload.status === "quarantined" || upload.status === "aborted")
      throw errors.conflict("This upload cannot be resumed.");
    if (upload.status === "uploading" && upload.uploadId && upload.partSize)
      return { upload, uploadId: upload.uploadId, partSize: upload.partSize };
    const created = await store.createMultipart(upload.blobKey, {
      size: upload.size,
    });
    await env.db
      .update(uploadSessions)
      .set({
        uploadId: created.uploadId,
        partSize: created.partSize,
        status: "uploading",
      })
      .where(eq(uploadSessions.id, upload.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, upload.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    return {
      upload: updated,
      uploadId: created.uploadId,
      partSize: created.partSize,
    };
  };

  const multipartResponse = (started: {
    upload: typeof uploadSessions.$inferSelect;
    uploadId?: string;
    partSize?: number;
  }) => ({
    upload: uploadWire(started.upload),
    ...(started.uploadId
      ? { upload_id: started.uploadId, part_size: started.partSize }
      : {}),
  });

  const multipartPartLimit = (
    upload: typeof uploadSessions.$inferSelect,
    partNo: number,
  ): number => {
    if (!upload.uploadId || !upload.partSize)
      throw errors.validation("Multipart upload is not initialized.");
    if (!Number.isInteger(partNo) || partNo < 1 || partNo > MAX_MULTIPART_PARTS)
      throw errors.validation("Part number is outside this upload.");
    return Math.min(upload.size, MAX_MULTIPART_PART_BYTES);
  };

  const listPartsResponse = async (
    upload: typeof uploadSessions.$inferSelect,
  ) => {
    const rows = await env.db
      .select()
      .from(uploadParts)
      .where(eq(uploadParts.uploadId, upload.id))
      .orderBy(asc(uploadParts.partNo))
      .all();
    return {
      items: rows.map((part: typeof uploadParts.$inferSelect) => ({
        part_no: part.partNo,
        etag: part.etag,
        size: part.size,
        completed_at: part.completedAt,
      })),
    };
  };

  const storePart = async (
    c: Context<{ Variables: Variables }>,
    upload: typeof uploadSessions.$inferSelect,
  ): Promise<string> => {
    const store = requireBlobStore();
    if (!upload.uploadId || !c.req.raw.body)
      throw errors.validation("Multipart upload is not initialized.");
    const partNo = Number(c.req.param("partNo"));
    const partByteLimit = multipartPartLimit(upload, partNo);
    const declaredPartLength = Number(c.req.header("content-length") ?? 0);
    if (
      declaredPartLength > 0 &&
      (!Number.isSafeInteger(declaredPartLength) ||
        declaredPartLength > partByteLimit)
    )
      throw errors.validation(
        "Part length exceeds this upload's multipart part size.",
      );
    const result = await store.putPart(
      upload.uploadId,
      partNo,
      limitStream(c.req.raw.body, partByteLimit),
      // A trusted Content-Length lets the R2 adapter stream a fixed-length
      // body instead of buffering the whole part; omit it when absent so the
      // adapter falls back to buffering rather than truncating to zero.
      declaredPartLength > 0 ? declaredPartLength : undefined,
    );
    if (result.size < 1 || result.size > partByteLimit)
      throw errors.validation(
        "Part length is outside this upload's multipart plan.",
      );
    await env.db
      .insert(uploadParts)
      .values({
        uploadId: upload.id,
        partNo,
        etag: result.etag,
        size: result.size,
        completedAt: env.clock.now(),
      })
      .onConflictDoUpdate({
        target: [uploadParts.uploadId, uploadParts.partNo],
        set: {
          etag: result.etag,
          size: result.size,
          completedAt: env.clock.now(),
        },
      })
      .run();
    return result.etag;
  };

  const finishUpload = async (
    upload: typeof uploadSessions.$inferSelect,
    body: {
      parts: Array<{ part_no: number; etag: string }>;
      checksum_crc32c?: string | undefined;
    },
  ): Promise<typeof uploadSessions.$inferSelect> => {
    // Re-completing a completed upload is idempotent: return the original
    // result instead of re-driving the blob store (spec phase-1 section 3).
    // An Idempotency-Key header is accepted and needs no bookkeeping here;
    // this natural idempotency is the documented scoped interpretation.
    if (upload.status === "completed") return upload;
    if (upload.status === "quarantined" || upload.status === "aborted")
      throw errors.conflict("This upload cannot be completed.");
    const store = requireBlobStore();
    if (!upload.uploadId)
      throw errors.validation("Multipart upload is not initialized.");
    if (!upload.partSize)
      throw errors.validation("Multipart upload is not initialized.");
    if (!body.parts.length)
      throw errors.validation(
        "Upload completion must include at least one part.",
      );
    const requestedPartNumbers = new Set(
      body.parts.map((part) => part.part_no),
    );
    const orderedParts = [...body.parts].sort(
      (left, right) => left.part_no - right.part_no,
    );
    if (
      requestedPartNumbers.size !== body.parts.length ||
      orderedParts.some(
        (part, index) =>
          part.part_no !== index + 1 ||
          multipartPartLimit(upload, part.part_no) < 1,
      )
    )
      throw errors.validation(
        "Upload completion must include contiguous parts exactly once.",
      );
    const persistedParts = await env.db
      .select()
      .from(uploadParts)
      .where(eq(uploadParts.uploadId, upload.id))
      .all();
    const persistedByNumber = new Map(
      persistedParts.map((part: typeof uploadParts.$inferSelect) => [
        part.partNo,
        part,
      ]),
    );
    let persistedBytes = 0;
    for (const part of orderedParts) {
      const persisted = persistedByNumber.get(part.part_no);
      const persistedSize = persisted?.size;
      if (
        !persisted ||
        persisted.etag !== part.etag ||
        typeof persistedSize !== "number" ||
        persistedSize < 1 ||
        persistedSize > multipartPartLimit(upload, part.part_no)
      )
        throw errors.validation(
          "Every completed part must match an uploaded part.",
        );
      persistedBytes += persistedSize;
    }
    if (persistedBytes !== upload.size) {
      await env.db
        .update(uploadSessions)
        .set({ status: "quarantined" })
        .where(eq(uploadSessions.id, upload.id))
        .run();
      throw errors.validation("Upload size does not match the declared size.", {
        expected: upload.size,
        actual: persistedBytes,
      });
    }
    await store.completeMultipart(
      upload.blobKey,
      upload.uploadId,
      orderedParts.map((part) => ({
        partNo: part.part_no,
        etag: part.etag,
      })),
    );
    if (typeof store.head === "function") {
      let assembled: { size: number };
      try {
        assembled = await store.head(upload.blobKey);
      } catch {
        throw errors.internal("The assembled upload could not be verified.");
      }
      if (assembled.size !== upload.size) {
        await env.db
          .update(uploadSessions)
          .set({ status: "quarantined" })
          .where(eq(uploadSessions.id, upload.id))
          .run();
        throw errors.validation(
          "Upload size does not match the declared size.",
          { expected: upload.size, actual: assembled.size },
        );
      }
    }
    const expectedChecksum = body.checksum_crc32c ?? upload.checksumCrc32c;
    if (expectedChecksum) {
      const actualChecksum = await crc32cStream(
        await store.getStream(upload.blobKey),
      );
      if (!crc32cMatches(expectedChecksum, actualChecksum)) {
        await env.db
          .update(uploadSessions)
          .set({ status: "quarantined", checksumCrc32c: expectedChecksum })
          .where(eq(uploadSessions.id, upload.id))
          .run();
        throw errors.validation(
          "Upload checksum does not match the assembled object.",
          { expected: expectedChecksum, actual: actualChecksum.hex },
        );
      }
    }
    const now = env.clock.now();
    await env.db
      .update(uploadSessions)
      .set({
        status: "completed",
        checksumCrc32c: body.checksum_crc32c ?? upload.checksumCrc32c,
        completedAt: now,
      })
      .where(eq(uploadSessions.id, upload.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, upload.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    return updated;
  };

  /* A completed upload becomes an asset with a first version and a queued
     probe. Shared by the member attach endpoint and the transfer request
     flow, whose received files land through the exact same door. */
  const landUploadAsAsset = async (
    upload: typeof uploadSessions.$inferSelect,
    options: {
      name?: string | undefined;
      folderId: string | null;
      uploadedBy: string;
      /** Suppresses the per-asset project event; the caller announces the
          batch itself. */
      quiet?: boolean;
    },
  ): Promise<{
    assetId: string;
    versionId: string;
    jobId: string;
    name: string;
    createdAt: number;
  }> => {
    const now = env.clock.now();
    const assetId = env.ids.ulid();
    const versionId = env.ids.ulid();
    const name = options.name?.trim() || upload.clientFilename;
    await env.db
      .insert(assets)
      .values({
        id: assetId,
        publicId: await newAssetPublicId(),
        projectId: upload.projectId,
        folderId: options.folderId,
        name,
        stackKey: stackKeyOf(name),
        kind: assetKind(upload.clientFilename),
        currentVersionId: versionId,
        status: "none",
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await env.db
      .insert(assetVersions)
      .values({
        id: versionId,
        assetId,
        uploadSessionId: upload.id,
        versionNo: 1,
        originalBlobKey: upload.blobKey,
        originalFilename: upload.clientFilename,
        size: upload.size,
        checksumCrc32c: upload.checksumCrc32c ?? "",
        uploadedBy: options.uploadedBy,
        mediaInfoJson: "{}",
        sourceTimecodeStart: null,
        sourceStartFrame: null,
        frameRateNum: null,
        frameRateDen: null,
        dropFrame: false,
        durationFrames: null,
        colorJson: "{}",
        transcodeStatus: "pending",
        deletedAt: null,
        createdAt: now,
      })
      .run();
    await env.db
      .update(projects)
      .set({ storageBytes: sql`${projects.storageBytes} + ${upload.size}` })
      .where(eq(projects.id, upload.projectId))
      .run();
    const jobId = env.ids.ulid();
    await env.db
      .insert(jobs)
      .values({
        id: jobId,
        kind: "probe",
        payloadJson: JSON.stringify({
          workspace_id: upload.workspaceId,
          project_id: upload.projectId,
          asset_id: assetId,
          version_id: versionId,
          blob_key: upload.blobKey,
        }),
        idempotencyKey: `probe:${versionId}`,
        status: "queued",
        priority: 0,
        capabilityJson: "{}",
        maxAttempts: 5,
        attempts: 0,
        runAfter: now,
        createdAt: now,
        startedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        finishedAt: null,
        error: null,
        workerId: null,
      })
      .run();
    /* A batch announces itself once, at the end, instead of 3000 times: a
       room full of open browsers would otherwise take one event, one fetch
       and one re-render per file. */
    if (!options.quiet)
      await appendProjectEvent(upload.projectId, "asset.created", {
        asset_id: assetId,
        version_id: versionId,
        job_id: jobId,
      });
    return { assetId, versionId, jobId, name, createdAt: now };
  };

  return {
    storedFilename,
    isImageFilename,
    assetKind,
    startMultipart,
    multipartResponse,
    multipartPartLimit,
    listPartsResponse,
    storePart,
    finishUpload,
    landUploadAsAsset,
  };
};

export type Uploads = ReturnType<typeof createUploads>;
