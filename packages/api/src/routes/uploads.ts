import { requireAuth } from "../auth.js";
import { userFromContext, jsonBody, limitStream } from "../helpers.js";
import { bodies } from "../schemas.js";
import { errors, crc32cStream, crc32cMatches } from "@onelight/core";
import {
  uploadSessions,
  assetVersions,
  uploadParts,
} from "@onelight/db/schema";
import { and, eq, or, desc } from "drizzle-orm";
import { MAX_DIRECT_UPLOAD_BYTES } from "../limits.js";
import type { MultipartBlobStore } from "@onelight/core";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Access } from "../operation/access.js";
import type { Uploads } from "../operation/uploads.js";
import { uploadWire } from "../wire.js";
import type { Blobs } from "../operation/blobs.js";

export const registerUploadsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    uploads,
    blobs,
  }: { access: Access; uploads: Uploads; blobs: Blobs },
) => {
  const { requireProject, requireDestinationFolder, findUpload } = access;
  const {
    storedFilename,
    landUploadAsAsset,
    assetKind,
    multipartResponse,
    startMultipart,
    listPartsResponse,
    multipartPartLimit,
    storePart,
    finishUpload,
  } = uploads;
  const { requireBlobStore, deleteBlobQuietly } = blobs;

  api.post("/uploads", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.uploadCreate);
    await requireProject(body.project_id, actor, "editor");
    if ((body.relative_path ?? "").split(/[\\/]/).includes(".."))
      throw errors.validation("Relative path cannot contain parent segments.");
    const filename = storedFilename(body.filename);
    // Idempotency-Key (phase-1 section 3, scoped interpretation, supersession
    // dated 2026-07-11): a keyed create that matches a still-open session by
    // the same user for the same project, filename, and size replays that
    // session with 200 instead of opening a duplicate. Complete is naturally
    // idempotent already (re-complete returns 202 with the original result).
    // A general key -> response replay store is future work.
    if (c.req.header("idempotency-key")) {
      const existing = (
        await env.db
          .select()
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.createdBy, actor.id),
              eq(uploadSessions.projectId, body.project_id),
              eq(uploadSessions.clientFilename, filename),
              eq(uploadSessions.size, body.size),
              or(
                eq(uploadSessions.status, "pending"),
                eq(uploadSessions.status, "uploading"),
              ),
            ),
          )
          .orderBy(desc(uploadSessions.id))
          .limit(1)
          .all()
      )[0];
      if (existing)
        return c.json(
          {
            upload: uploadWire(existing),
            upload_url: `/api/v1/uploads/${existing.id}/multipart`,
          },
          200,
        );
    }
    const uploadId = env.ids.ulid();
    const blobKey = `${actor.workspaceId}/${body.project_id}/uploads/${uploadId}/${filename}`;
    const now = env.clock.now();
    await env.db
      .insert(uploadSessions)
      .values({
        id: uploadId,
        workspaceId: actor.workspaceId,
        projectId: body.project_id,
        createdBy: actor.id,
        clientFilename: filename,
        relativePath: body.relative_path ?? "",
        size: body.size,
        checksumCrc32c: body.checksum_crc32c ?? null,
        blobKey,
        uploadId: null,
        partSize: null,
        status: "pending",
        createdAt: now,
        completedAt: null,
      })
      .run();
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .limit(1)
        .all()
    )[0];
    if (!upload) throw errors.internal();
    return c.json(
      {
        upload: uploadWire(upload),
        upload_url: `/api/v1/uploads/${uploadId}/multipart`,
      },
      201,
    );
  });

  /* A small file, whole, in one request, landed as an asset.

     The multipart path is six round trips before a byte is reviewed: create
     the session, initialize it, list its parts, put the one part, complete it,
     attach it. That is the right shape for a camera master and the wrong one
     for a JPEG, and at a few thousand files the round trips dominate the
     transfer. This is the same journey with the ceremony removed, for
     anything at or under MAX_DIRECT_UPLOAD_BYTES.

     The body is the file. Everything else rides in the query string, which is
     what lets the whole thing be one streamed request rather than a multipart
     form the server would have to buffer to parse. */
  api.post("/projects/:id/uploads/direct", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "editor");
    const store = requireBlobStore();
    const rawName = (c.req.query("filename") ?? "").trim();
    if (!rawName || rawName.length > 500)
      throw errors.validation("A filename is required.");
    const relativePath = (c.req.query("relative_path") ?? "").slice(0, 2000);
    if (relativePath.split(/[\\/]/).includes(".."))
      throw errors.validation("Relative path cannot contain parent segments.");
    const filename = storedFilename(rawName);
    const folderId = c.req.query("folder_id") || null;
    if (folderId) await requireDestinationFolder(projectId, folderId);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_DIRECT_UPLOAD_BYTES) throw errors.payloadTooLarge();
    if (!c.req.raw.body) throw errors.validation("A file body is required.");
    const uploadId = env.ids.ulid();
    const blobKey = `${actor.workspaceId}/${projectId}/uploads/${uploadId}/${filename}`;
    const now = env.clock.now();
    await env.db
      .insert(uploadSessions)
      .values({
        id: uploadId,
        workspaceId: actor.workspaceId,
        projectId,
        createdBy: actor.id,
        clientFilename: filename,
        relativePath,
        size: declared > 0 ? declared : 0,
        checksumCrc32c: null,
        blobKey,
        uploadId: null,
        partSize: null,
        status: "uploading",
        createdAt: now,
        completedAt: null,
      })
      .run();
    /* The stream is capped whatever Content-Length claimed, so a lying header
       cannot write an unbounded blob. */
    await store.putStream(
      blobKey,
      limitStream(c.req.raw.body, MAX_DIRECT_UPLOAD_BYTES),
      declared > 0 ? { size: declared } : {},
    );
    const stored =
      typeof store.head === "function"
        ? await store.head(blobKey).catch(() => undefined)
        : undefined;
    const size = stored?.size ?? declared;
    if (!size) {
      await env.db
        .update(uploadSessions)
        .set({ status: "aborted" })
        .where(eq(uploadSessions.id, uploadId))
        .run();
      await deleteBlobQuietly(blobKey);
      throw errors.validation("The uploaded file was empty.");
    }
    /* A declared length that does not match what arrived is a truncated or
       overlong body: refuse it rather than land a corrupt asset. */
    if (declared > 0 && size !== declared) {
      await env.db
        .update(uploadSessions)
        .set({ status: "quarantined" })
        .where(eq(uploadSessions.id, uploadId))
        .run();
      throw errors.validation("Upload size does not match the declared size.", {
        expected: declared,
        actual: size,
      });
    }
    const expected = c.req.query("checksum_crc32c");
    if (expected) {
      const actual = await crc32cStream(await store.getStream(blobKey));
      if (!crc32cMatches(expected, actual)) {
        await env.db
          .update(uploadSessions)
          .set({ status: "quarantined", checksumCrc32c: expected })
          .where(eq(uploadSessions.id, uploadId))
          .run();
        throw errors.validation(
          "Upload checksum does not match the stored object.",
          { expected, actual: actual.hex },
        );
      }
    }
    await env.db
      .update(uploadSessions)
      .set({
        status: "completed",
        size,
        ...(expected ? { checksumCrc32c: expected } : {}),
        completedAt: env.clock.now(),
      })
      .where(eq(uploadSessions.id, uploadId))
      .run();
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .limit(1)
        .all()
    )[0];
    if (!upload) throw errors.internal();
    /* attach=0 leaves the upload for a batch attach to land, which is how a
       client that wants one project event for the whole delivery uses this. */
    if (c.req.query("attach") === "0")
      return c.json({ upload: uploadWire(upload) }, 201);
    const landed = await landUploadAsAsset(upload, {
      ...(c.req.query("name") ? { name: c.req.query("name") } : {}),
      folderId,
      uploadedBy: actor.id,
      quiet: c.req.query("quiet") === "1",
    });
    return c.json(
      {
        upload: uploadWire(upload),
        asset: {
          id: landed.assetId,
          name: landed.name,
          kind: assetKind(filename),
          status: "none",
          current_version_id: landed.versionId,
          version_id: landed.versionId,
          job_id: landed.jobId,
          created_at: landed.createdAt,
          updated_at: landed.createdAt,
        },
      },
      201,
    );
  });

  api.post("/uploads/:id/multipart", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    return c.json(multipartResponse(await startMultipart(upload)));
  });

  api.get("/uploads/:id/parts", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    return c.json(await listPartsResponse(upload));
  });

  api.get("/uploads/:id/parts/:partNo/url", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const partNo = Number(c.req.param("partNo"));
    multipartPartLimit(upload, partNo);
    return c.json({ url: `/api/v1/uploads/${upload.id}/parts/${partNo}` });
  });

  api.put("/uploads/:id/parts/:partNo", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    c.header("etag", await storePart(c, upload));
    return c.body(null, 204);
  });

  api.post("/uploads/:id/complete", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    // A re-complete answers before reading the body, as it always has.
    if (upload.status === "completed")
      return c.json({ upload: uploadWire(upload) }, 202);
    const body = await jsonBody(c, bodies.uploadComplete);
    return c.json(
      { upload: uploadWire(await finishUpload(upload, body)) },
      202,
    );
  });

  api.delete("/uploads/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const referenced = await env.db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(eq(assetVersions.uploadSessionId, upload.id))
      .limit(1)
      .all();
    if (referenced.length)
      throw errors.conflict("This upload is attached to an asset version.");
    const store = env.blobStore as MultipartBlobStore | undefined;
    if (
      upload.uploadId &&
      upload.status !== "completed" &&
      store?.abortMultipart
    )
      await store.abortMultipart(upload.uploadId);
    if (store) {
      try {
        await store.delete(upload.blobKey);
      } catch {
        // The assembled blob may not exist for pending or aborted sessions.
      }
    }
    await env.db
      .delete(uploadParts)
      .where(eq(uploadParts.uploadId, upload.id))
      .run();
    await env.db
      .delete(uploadSessions)
      .where(eq(uploadSessions.id, upload.id))
      .run();
    return c.body(null, 204);
  });

  api.post("/uploads/:id/abort", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const store = env.blobStore as MultipartBlobStore | undefined;
    if (upload.uploadId && store?.abortMultipart)
      await store.abortMultipart(upload.uploadId);
    await env.db
      .update(uploadSessions)
      .set({ status: "aborted" })
      .where(eq(uploadSessions.id, upload.id))
      .run();
    return c.body(null, 204);
  });
};
