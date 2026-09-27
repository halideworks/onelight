import { requireAuth } from "../auth.js";
import {
  userFromContext,
  jsonBody,
  mapError,
  parseJsonObject,
  readBodyBytes,
} from "../helpers.js";
import { bodies } from "../schemas.js";
import { nextAssetStamp } from "../operation/asset-state.js";
import {
  stackPredicate,
  signStackUndo,
  stackDigest,
} from "../operation/version-stack.js";
import type { StackState } from "../operation/version-stack.js";
import { MAX_ATTACH_BATCH } from "../limits.js";
import { errors, stackKeyOf, needsStillFull } from "@onelight/core";
import type { uploadSessions } from "@onelight/db/schema";
import {
  assets,
  assetVersions,
  jobs,
  renditions,
  captionTracks,
} from "@onelight/db/schema";
import { eq, sql, and, isNull, asc, inArray, desc } from "drizzle-orm";
import type { AppEnv, ApiRouter, ActorUser } from "../types.js";
import type { Access } from "../operation/access.js";
import type { Activity } from "../operation/activity.js";
import type { Comments } from "../operation/comments.js";
import { assetWire, versionWire } from "../wire.js";
import type { Identity } from "../operation/identity.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";

export const registerVersionsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    activity,
    commentsOps,
    identity,
    media,
    blobs,
  }: {
    access: Access;
    activity: Activity;
    commentsOps: Comments;
    identity: Identity;
    media: Media;
    blobs: Blobs;
  },
) => {
  const { requireProject, assetForActor, findUpload, versionForActor } = access;
  const { projectManagerIds, appendProjectEvent, createNotifications } =
    activity;
  const { copyUnresolvedComments } = commentsOps;
  const { hitRateLimit } = identity;
  const { privateMediaUrl, DOWNLOAD_TOKEN_TTL_MS } = media;
  const { requireBlobStore, attachmentDisposition, deleteBlobQuietly } = blobs;

  api.post("/projects/:id/versions/batch", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    const { project } = await requireProject(projectId, actor, "editor");
    const body = await jsonBody(c, bodies.versionBatchCreate);
    if (body.items.length > MAX_ATTACH_BATCH)
      throw errors.validation(
        `A batch may add at most ${String(MAX_ATTACH_BATCH)} versions.`,
      );
    const items: Array<Record<string, unknown>> = [];
    const failures: Array<{ upload_id: string; error: string }> = [];
    /* Who hears about it, gathered once for the whole batch rather than per
       file: a delivery used to write one notification per file per recipient,
       which is how an inbox becomes useless. */
    const recipients = new Set<string>(await projectManagerIds(projectId));
    for (const item of body.items) {
      try {
        const asset = await assetForActor(item.asset_id, actor, "editor");
        if (asset.projectId !== projectId)
          throw errors.conflict("Asset belongs to another project.");
        const upload = await findUpload(item.upload_id, actor);
        const created = await addVersionToAsset(asset, upload, {
          actor,
          ...(item.name === undefined ? {} : { name: item.name }),
          carryForward: item.carry_forward ?? body.carry_forward ?? true,
          quiet: true,
        });
        for (const uploader of created.priorUploaders) recipients.add(uploader);
        items.push({
          asset_id: asset.id,
          upload_id: upload.id,
          version_id: created.versionId,
          version_no: created.versionNo,
          job_id: created.jobId,
          stack_state: created.stackState,
          previous_current_version_id: created.previousCurrentId,
          undo_token: created.undoToken,
        });
      } catch (caught) {
        failures.push({
          upload_id: item.upload_id,
          error: mapError(caught).message,
        });
      }
    }
    if (items.length) {
      await appendProjectEvent(projectId, "asset.versions_created_batch", {
        count: items.length,
        asset_ids: items.slice(0, 20).map((item) => item.asset_id),
      });
      await createNotifications({
        projectId,
        actorUserId: actor.id,
        recipients: [...recipients],
        kind: "versions.created_batch",
        payload: {
          project_id: projectId,
          project_name: project.name,
          count: items.length,
          actor_name: actor.name,
          preview: `${actor.name} added ${String(items.length)} ${
            items.length === 1 ? "version" : "versions"
          } in ${project.name}`,
        },
      });
    }
    return c.json({ items, failures }, items.length ? 201 : 207);
  });

  /* One upload becoming the next version of one asset. Shared by the single
     endpoint and the batch, so the two cannot drift on what a version is: the
     row, the current pointer, the storage accounting, the probe job, and the
     comments carried forward are all here. What differs is the announcing,
     which a batch does once for the whole set. */
  const addVersionToAsset = async (
    asset: typeof assets.$inferSelect,
    upload: typeof uploadSessions.$inferSelect,
    options: {
      actor: ActorUser;
      name?: string | undefined;
      carryForward: boolean;
      quiet?: boolean;
    },
  ): Promise<{
    versionId: string;
    versionNo: number;
    jobId: string;
    priorUploaders: string[];
    stackState: StackState;
    previousCurrentId: string | null;
    undoToken: string;
  }> => {
    // The three attach rules are all state conflicts, not shape errors: 409.
    if (upload.status !== "completed")
      throw errors.conflict("Upload must be completed before attaching.");
    if (upload.projectId !== asset.projectId)
      throw errors.conflict("Upload must belong to the asset's project.");
    const alreadyAttached = await env.db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(eq(assetVersions.uploadSessionId, upload.id))
      .limit(1)
      .all();
    if (alreadyAttached.length)
      throw errors.conflict(
        "This upload is already attached to an asset version.",
      );
    const priorVersions = await env.db
      .select({
        id: assetVersions.id,
        versionNo: assetVersions.versionNo,
        uploadedBy: assetVersions.uploadedBy,
      })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, asset.id))
      .all();
    const versionNo =
      priorVersions.reduce(
        (max: number, row: { versionNo: number }) =>
          Math.max(max, row.versionNo),
        0,
      ) + 1;
    const current = (
      await env.db
        .select({ id: assets.currentVersionId })
        .from(assets)
        .where(eq(assets.id, asset.id))
        .limit(1)
        .all()
    )[0];
    if (!current) throw errors.notFound("Asset was not found.");
    const before: StackState = {
      asset_id: asset.id,
      current_version_id: current.id,
      versions: priorVersions
        .map((row) => ({ id: row.id, version_no: row.versionNo }))
        .sort((a, b) => a.version_no - b.version_no),
    };
    const previousCurrentId = before.current_version_id;
    const now = env.clock.now();
    const versionId = env.ids.ulid();
    const jobId = env.ids.ulid();
    const jobPayload = JSON.stringify({
      workspace_id: options.actor.workspaceId,
      project_id: asset.projectId,
      asset_id: asset.id,
      version_id: versionId,
      blob_key: upload.blobKey,
    });
    const renamed = options.name
      ? sql`, name = ${options.name.trim()}, stack_key = ${stackKeyOf(options.name.trim())}`
      : sql``;
    const changed = await env.db.atomic([
      sql`UPDATE assets SET current_version_id = ${versionId}, updated_at = max(updated_at + 1, ${now}) ${renamed}
          WHERE ${stackPredicate(before)} AND NOT EXISTS (SELECT 1 FROM asset_versions WHERE upload_session_id = ${upload.id}) RETURNING id`,
      sql`INSERT INTO asset_versions (id, asset_id, upload_session_id, version_no, original_blob_key, original_filename, size, checksum_crc32c, uploaded_by, drop_frame, created_at)
          SELECT ${versionId}, ${asset.id}, ${upload.id}, ${versionNo}, ${upload.blobKey}, ${upload.clientFilename}, ${upload.size}, ${upload.checksumCrc32c ?? ""}, ${options.actor.id}, 0, ${now} WHERE changes() = 1 RETURNING id`,
      sql`UPDATE projects SET storage_bytes = storage_bytes + ${upload.size} WHERE changes() = 1 AND id = ${asset.projectId} RETURNING id`,
      sql`INSERT INTO jobs (id, kind, payload_json, idempotency_key, status, priority, capability_json, max_attempts, attempts, run_after, created_at)
          SELECT ${jobId}, 'probe', ${jobPayload}, ${`probe:${versionId}`}, 'queued', 0, '{}', 5, 0, ${now}, ${now} WHERE changes() = 1 RETURNING id`,
    ]);
    if (!changed[0]?.length)
      throw errors.conflict(
        "The version stack changed. Retry the upload attachment.",
      );
    if (options.carryForward && previousCurrentId)
      await copyUnresolvedComments(previousCurrentId, versionId);
    if (!options.quiet)
      await appendProjectEvent(asset.projectId, "asset.version_created", {
        asset_id: asset.id,
        version_id: versionId,
        version_no: versionNo,
        job_id: jobId,
      });
    const after: StackState = {
      ...before,
      current_version_id: versionId,
      versions: [...before.versions, { id: versionId, version_no: versionNo }],
    };
    return {
      versionId,
      versionNo,
      jobId,
      stackState: after,
      previousCurrentId,
      undoToken: await signStackUndo(env, options.actor, {
        action: "unstack",
        project_id: asset.projectId,
        version_id: versionId,
        asset_id: asset.id,
        current_version_id: previousCurrentId,
        expected_digest: await stackDigest(after),
      }),
      priorUploaders: priorVersions.map(
        (row: { uploadedBy: string }) => row.uploadedBy,
      ),
    };
  };

  api.post("/assets/:id/versions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.versionCreate);
    const upload = await findUpload(body.upload_id, actor);
    const created = await addVersionToAsset(asset, upload, {
      actor,
      ...(body.name === undefined ? {} : { name: body.name }),
      carryForward: body.carry_forward ?? false,
    });
    const updatedAsset = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, asset.id))
        .limit(1)
        .all()
    )[0];
    const newVersion = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, created.versionId))
        .limit(1)
        .all()
    )[0];
    if (!updatedAsset || !newVersion) throw errors.internal();
    await createNotifications({
      projectId: asset.projectId,
      actorUserId: actor.id,
      recipients: [
        ...created.priorUploaders,
        ...(await projectManagerIds(asset.projectId)),
      ],
      kind: "version.created",
      payload: {
        project_id: asset.projectId,
        asset_id: asset.id,
        asset_name: updatedAsset.name,
        version_id: created.versionId,
        version_no: created.versionNo,
        actor_name: actor.name,
        preview: `Version ${created.versionNo} of ${updatedAsset.name}`,
      },
    });
    return c.json(
      {
        asset: assetWire(updatedAsset),
        version: versionWire(newVersion),
        job_id: created.jobId,
        stack_state: created.stackState,
        previous_current_version_id: created.previousCurrentId,
        undo_token: created.undoToken,
      },
      201,
    );
  });

  api.get("/versions/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound();
    await assetForActor(version.assetId, actor);
    return c.json(versionWire(version));
  });

  api.post("/versions/:id/playback-diagnostics", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor);
    await hitRateLimit(
      `playback_diagnostic:${actor.id}:${version.id}`,
      12,
      5 * 60 * 1000,
    );
    const diagnostic = await jsonBody(c, bodies.playbackDiagnostic);
    console.warn(
      `[onelight-playback-diagnostic] ${JSON.stringify({
        scope: "project",
        request_id: c.get("requestId"),
        workspace_id: actor.workspaceId,
        actor_id: actor.id,
        version_id: version.id,
        user_agent: c.req.header("user-agent") ?? null,
        client_platform: c.req.header("sec-ch-ua-platform") ?? null,
        client_brands: c.req.header("sec-ch-ua") ?? null,
        recorded_at: env.clock.now(),
        ...diagnostic,
      })}`,
    );
    return c.body(null, 204);
  });

  api.get("/versions/:id/renditions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound();
    await assetForActor(version.assetId, actor);
    const rows = await env.db
      .select()
      .from(renditions)
      .where(eq(renditions.versionId, version.id))
      .all();
    const mediaInfo = parseJsonObject(version.mediaInfoJson);
    const streams = Array.isArray(mediaInfo.streams) ? mediaInfo.streams : [];
    return c.json({
      items: await Promise.all(
        rows.map(async (rendition: typeof renditions.$inferSelect) => {
          const meta = parseJsonObject(rendition.metaJson);
          const vttKey =
            typeof meta.vtt_blob_key === "string"
              ? meta.vtt_blob_key
              : undefined;
          return {
            id: rendition.id,
            version_id: rendition.versionId,
            kind: rendition.kind,
            blob_key: rendition.blobKey,
            meta,
            size: rendition.size,
            created_at: rendition.createdAt,
            url: env.blobStore
              ? await privateMediaUrl(
                  { versionId: version.id },
                  rendition.blobKey,
                )
              : null,
            vtt_url:
              env.blobStore && vttKey
                ? await privateMediaUrl({ versionId: version.id }, vttKey)
                : null,
          };
        }),
      ),
      captions: await captionsWire(version.id),
      has_audio: streams.some(
        (stream) =>
          stream &&
          typeof stream === "object" &&
          !Array.isArray(stream) &&
          (stream as Record<string, unknown>).codec_type === "audio",
      ),
    });
  });

  /* The picture at 1:1, for a source a browser cannot open.

     A JPEG or a PNG needs nothing here: the original is a file the browser
     decodes, so zooming past the review still just fetches it. A TIFF, a PSD,
     an EXR or a DPX is not something any browser will draw, so the full-size
     rung is rendered for them, once, the first time anyone actually zooms.

     Making it at ingest instead would cost seconds and megabytes per file on
     a delivery where most frames are never opened at all. */
  api.get("/versions/:id/still-full", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound();
    const asset = await assetForActor(version.assetId, actor);
    if (asset.kind !== "image")
      throw errors.validation("This version is not a still.");
    requireBlobStore();
    /* The original serves as its own full-size picture wherever a browser can
       decode it. */
    if (!needsStillFull(version.originalFilename))
      return c.json({
        status: "ready",
        source: "original",
        url: await privateMediaUrl(
          { versionId: version.id },
          version.originalBlobKey,
        ),
      });
    const existing = (
      await env.db
        .select()
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, version.id),
            eq(renditions.kind, "still_full"),
            isNull(renditions.shareId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (existing)
      return c.json({
        status: "ready",
        source: "rendition",
        url: await privateMediaUrl({ versionId: version.id }, existing.blobKey),
      });
    /* Not made yet: ask for it and tell the client to come back. The
       idempotency key means a hundred viewers zooming at once queue one job,
       and the rate limit means one viewer walking a library cannot fill the
       queue with work nobody asked to look at. */
    await hitRateLimit(`still_full:${actor.id}`, 60, 5 * 60 * 1000);
    const now = env.clock.now();
    const idempotencyKey = `still_full:${version.id}`;
    const queued = (
      await env.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, idempotencyKey))
        .limit(1)
        .all()
    )[0];
    if (!queued)
      await env.db
        .insert(jobs)
        .values({
          id: env.ids.ulid(),
          kind: "transcode",
          payloadJson: JSON.stringify({
            workspace_id: actor.workspaceId,
            project_id: asset.projectId,
            asset_id: asset.id,
            version_id: version.id,
            blob_key: version.originalBlobKey,
            only: ["still_full"],
          }),
          idempotencyKey,
          status: "queued",
          /* Someone is looking at the screen waiting for this. */
          priority: 1,
          capabilityJson: "{}",
          maxAttempts: 3,
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
    return c.json({ status: "processing" }, 202);
  });

  /* Caption tracks ride the renditions listing internally and the share
     asset detail publicly; these routes are how they get there. The upload
     is raw WebVTT, one track per language, replace-on-put -- simple enough
     that a deployment's captioning hook is a curl. */
  const CAPTION_MAX_BYTES = 1_048_576;

  const captionsWire = async (versionId: string) => {
    const rows = await env.db
      .select()
      .from(captionTracks)
      .where(eq(captionTracks.versionId, versionId))
      .orderBy(asc(captionTracks.language))
      .all();
    return Promise.all(
      rows.map(async (track: typeof captionTracks.$inferSelect) => ({
        language: track.language,
        label: track.label,
        url: env.blobStore
          ? await privateMediaUrl({ versionId }, track.blobKey)
          : null,
      })),
    );
  };

  /* Internal downloads. Originals are the camera negatives of the room, so
     they take editor; the proxy is what any member already streams, so it
     downloads at viewer. Both hand back a short-lived signed URL with an
     attachment disposition. */
  api.get("/versions/:id/download", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const kind = c.req.query("kind") === "proxy" ? "proxy" : "original";
    const version = await versionForActor(
      c.req.param("id"),
      actor,
      kind === "original" ? "editor" : "viewer",
    );
    if (!env.blobStore) throw errors.notFound("Media is not available.");
    const expiresAt = env.clock.now() + DOWNLOAD_TOKEN_TTL_MS;
    if (kind === "original")
      return c.json({
        url: await privateMediaUrl(
          { versionId: version.id },
          version.originalBlobKey,
          attachmentDisposition(version.originalFilename),
        ),
        expires_at: expiresAt,
      });
    const proxyRows = (await env.db
      .select()
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, version.id),
          inArray(renditions.kind, [
            "proxy_1080",
            "proxy_540",
            "proxy_2160",
            "proxy_audio",
          ]),
          isNull(renditions.shareId),
        ),
      )
      .all()) as Array<typeof renditions.$inferSelect>;
    const order = ["proxy_1080", "proxy_540", "proxy_2160", "proxy_audio"];
    const proxy = proxyRows.sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
    )[0];
    if (!proxy) throw errors.notFound("A review rendition is not ready.");
    const baseName =
      version.originalFilename.replace(/\.[^.]+$/, "") || "download";
    /* The suffix has to match what is actually inside: an audio proxy saved
       as .mp4 opens in a video player and looks broken. */
    const proxyExtension = proxy.kind === "proxy_audio" ? "m4a" : "mp4";
    return c.json({
      url: await privateMediaUrl(
        { versionId: version.id },
        proxy.blobKey,
        attachmentDisposition(`${baseName}-proxy.${proxyExtension}`),
      ),
      expires_at: expiresAt,
    });
  });

  api.put("/versions/:id/captions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor, "editor");
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const language = (c.req.query("language") ?? "en").trim().toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language))
      throw errors.validation(
        "language must be a BCP 47 tag like en or pt-br.",
      );
    const label = (c.req.query("label") ?? "").trim() || language.toUpperCase();
    if (label.length > 80) throw errors.validation("label is too long.");
    const bytes = await readBodyBytes(c, CAPTION_MAX_BYTES);
    if (!bytes.byteLength)
      throw errors.validation("The captions file is empty.");
    const head = new TextDecoder().decode(bytes.slice(0, 32));
    if (
      !head
        .replace(/^\uFEFF/, "")
        .trimStart()
        .startsWith("WEBVTT")
    )
      throw errors.validation(
        "Captions must be WebVTT; the file has to start with WEBVTT.",
      );
    const key = `captions/${version.id}/${language}-${env.ids.ulid()}.vtt`;
    await env.blobStore.putStream(
      key,
      new Response(bytes).body as ReadableStream,
      { contentType: "text/vtt", size: bytes.byteLength },
    );
    const now = env.clock.now();
    const existing = (
      await env.db
        .select()
        .from(captionTracks)
        .where(
          and(
            eq(captionTracks.versionId, version.id),
            eq(captionTracks.language, language),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (existing) {
      await env.db
        .update(captionTracks)
        .set({ label, blobKey: key, createdBy: actor.id, createdAt: now })
        .where(eq(captionTracks.id, existing.id))
        .run();
      await deleteBlobQuietly(existing.blobKey);
    } else {
      await env.db
        .insert(captionTracks)
        .values({
          id: env.ids.ulid(),
          versionId: version.id,
          language,
          label,
          blobKey: key,
          createdBy: actor.id,
          createdAt: now,
        })
        .run();
    }
    return c.json(
      {
        language,
        label,
        url: await privateMediaUrl({ versionId: version.id }, key),
      },
      201,
    );
  });

  api.delete("/versions/:id/captions/:language", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor, "editor");
    const language = c.req.param("language").toLowerCase();
    const existing = (
      await env.db
        .select()
        .from(captionTracks)
        .where(
          and(
            eq(captionTracks.versionId, version.id),
            eq(captionTracks.language, language),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!existing) throw errors.notFound("No captions in that language.");
    await env.db
      .delete(captionTracks)
      .where(eq(captionTracks.id, existing.id))
      .run();
    await deleteBlobQuietly(existing.blobKey);
    return c.body(null, 204);
  });

  api.patch("/versions/:id/stack", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.stackPatch);
    const target = (
      await env.db
        .select()
        .from(assetVersions)
        .where(
          and(
            eq(assetVersions.assetId, version.assetId),
            eq(assetVersions.versionNo, body.version_no),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound("Version was not found.");
    const changed = await env.db
      .update(assets)
      .set({
        currentVersionId: target.id,
        updatedAt: nextAssetStamp(env.clock.now()),
      })
      .where(
        and(
          eq(assets.id, version.assetId),
          isNull(assets.deletedAt),
          sql`EXISTS (SELECT 1 FROM asset_versions WHERE id = ${target.id} AND asset_id = ${version.assetId} AND deleted_at IS NULL)`,
        ),
      )
      .returning({ id: assets.id })
      .all();
    if (!changed.length)
      throw errors.conflict(
        "The version moved or was deleted. Refresh the stack.",
      );
    const rows = await env.db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, version.assetId))
      .orderBy(desc(assetVersions.versionNo))
      .all();
    return c.json({
      items: rows.map((row: typeof assetVersions.$inferSelect) =>
        versionWire(row),
      ),
      current_version_id: target.id,
    });
  });
};
