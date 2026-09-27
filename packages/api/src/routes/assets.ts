import { requireAuth } from "../auth.js";
import {
  userFromContext,
  jsonBody,
  mapError,
  getLimit,
  parseJsonObject,
} from "../helpers.js";
import { bodies } from "../schemas.js";
import { errors, stackKeyOf } from "@onelight/core";
import {
  assetVersions,
  assets,
  folders,
  shares,
  shareAssets,
  renditions,
} from "@onelight/db/schema";
import { eq, and, isNotNull, desc, isNull, inArray } from "drizzle-orm";
import { MAX_ATTACH_BATCH } from "../limits.js";
import type { AppEnv, ApiRouter, Variables } from "../types.js";
import type { Context } from "hono";
import type { Access } from "../operation/access.js";
import type { Uploads } from "../operation/uploads.js";
import type { Activity } from "../operation/activity.js";
import { assetWire, listCardVersion, versionWire } from "../wire.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";
import { assetPredicate, nextAssetStamp } from "../operation/asset-state.js";
import { assetListOrder } from "./asset-list.js";

export const registerAssetsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    uploads,
    activity,
    media,
    blobs,
  }: {
    access: Access;
    uploads: Uploads;
    activity: Activity;
    media: Media;
    blobs: Blobs;
  },
) => {
  const {
    requireProject,
    findUpload,
    requireDestinationFolder,
    assetForActor,
    assetParam,
  } = access;
  const { landUploadAsAsset, assetKind, isImageFilename } = uploads;
  const { appendProjectEvent, notifyApprovalChange } = activity;
  const { POSTER_FALLBACK_KINDS, posterRank, privateMediaUrl } = media;
  const { blobContentType } = blobs;

  api.post("/projects/:id/assets", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.assetCreate);
    const upload = await findUpload(body.upload_id, actor);
    if (upload.projectId !== c.req.param("id") || upload.status !== "completed")
      throw errors.validation("Upload must be completed for this project.");
    const existingVersion = await env.db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(eq(assetVersions.uploadSessionId, upload.id))
      .limit(1)
      .all();
    if (existingVersion.length)
      throw errors.conflict("This upload is already attached to an asset.");
    /* The new asset must be filed in an assets folder of this project. */
    if (body.folder_id != null)
      await requireDestinationFolder(c.req.param("id"), body.folder_id);
    const landed = await landUploadAsAsset(upload, {
      name: body.name,
      folderId: body.folder_id ?? null,
      uploadedBy: actor.id,
    });
    return c.json(
      {
        id: landed.assetId,
        name: landed.name,
        kind: assetKind(upload.clientFilename),
        status: "none",
        current_version_id: landed.versionId,
        version_id: landed.versionId,
        job_id: landed.jobId,
        created_at: landed.createdAt,
        updated_at: landed.createdAt,
      },
      201,
    );
  });

  /* Many completed uploads become many assets in one request.

     One request per file is fine for a handful and ruinous for a delivery:
     3000 attaches meant 3000 round trips, 3000 project events and 3000
     notifications. This lands them together, announces the batch once, and
     reports per-upload failures rather than refusing the whole set because
     one upload was already attached.

     The bound is per request, not per delivery: a client with thousands of
     files sends several of these. */
  api.post("/projects/:id/assets/batch", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "editor");
    const body = await jsonBody(c, bodies.assetBatchCreate);
    if (body.items.length > MAX_ATTACH_BATCH)
      throw errors.validation(
        `A batch may attach at most ${String(MAX_ATTACH_BATCH)} uploads.`,
      );
    /* Every destination folder is checked once, however many files land in
       it. */
    const folderIds = new Set(
      body.items
        .map((item) => item.folder_id ?? body.folder_id ?? null)
        .filter((id): id is string => typeof id === "string"),
    );
    for (const folderId of folderIds)
      await requireDestinationFolder(projectId, folderId);
    const items: Array<Record<string, unknown>> = [];
    const failures: Array<{ upload_id: string; error: string }> = [];
    for (const item of body.items) {
      try {
        const upload = await findUpload(item.upload_id, actor);
        if (upload.projectId !== projectId || upload.status !== "completed")
          throw errors.validation("Upload must be completed for this project.");
        const existingVersion = await env.db
          .select({ id: assetVersions.id })
          .from(assetVersions)
          .where(eq(assetVersions.uploadSessionId, upload.id))
          .limit(1)
          .all();
        if (existingVersion.length)
          throw errors.conflict("This upload is already attached to an asset.");
        const landed = await landUploadAsAsset(upload, {
          name: item.name,
          folderId: item.folder_id ?? body.folder_id ?? null,
          uploadedBy: actor.id,
          quiet: true,
        });
        items.push({
          id: landed.assetId,
          upload_id: upload.id,
          name: landed.name,
          kind: assetKind(upload.clientFilename),
          status: "none",
          current_version_id: landed.versionId,
          version_id: landed.versionId,
          job_id: landed.jobId,
          created_at: landed.createdAt,
          updated_at: landed.createdAt,
        });
      } catch (caught) {
        /* One bad upload does not sink the batch; the client is told which. */
        failures.push({
          upload_id: item.upload_id,
          error: mapError(caught).message,
        });
      }
    }
    if (items.length)
      await appendProjectEvent(projectId, "assets.created_batch", {
        count: items.length,
        asset_ids: items.slice(0, 20).map((item) => item.id),
      });
    return c.json({ items, failures }, items.length ? 201 : 207);
  });

  /* This project's trash. GET /trash is the workspace-wide, admin-only
     ledger; a person working in a project needs to see what they threw away
     without being an admin and without leaving the room. Editor, because
     restoring is an editor's verb (POST /assets/:id/restore). */
  api.get("/projects/:id/trash", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "editor",
    );
    const rows = (await env.db
      .select({ asset: assets, folderName: folders.name })
      .from(assets)
      .leftJoin(folders, eq(assets.folderId, folders.id))
      .where(and(eq(assets.projectId, project.id), isNotNull(assets.deletedAt)))
      .orderBy(desc(assets.deletedAt))
      .limit(500)
      .all()) as Array<{
      asset: typeof assets.$inferSelect;
      folderName: string | null;
    }>;
    /* The folder name travels with the row so the list can say where a thing
       will land when it is restored, which is the question anyone looking at
       a bin actually has. */
    return c.json({
      items: rows.map((row) => ({
        ...assetWire(row.asset),
        folder_name: row.folderName,
      })),
    });
  });

  api.get("/projects/:id/assets", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "viewer");
    const limit = getLimit(c.req.query("limit"));
    const listing = assetListOrder(c.req.param("id"), c.req.query());
    const folderId = c.req.query("folder_id");
    /* A share reads as a folder in the browser rail, so it filters the same
       list the same way -- one endpoint, one paging rule, one permission
       check, rather than a second asset list that only shares use. The share
       must belong to this project; otherwise the filter would be a way to read
       one project's asset rows through another's permission check. */
    /* selected=1 narrows the list to the shortlist, which is what the grid's
       Selects filter and the list export both ask for. */
    const selectedOnly = c.req.query("selected") === "1";
    const shareId = c.req.query("share_id");
    if (shareId) {
      const share = (
        await env.db
          .select({ projectId: shares.projectId })
          .from(shares)
          .where(eq(shares.id, shareId))
          .limit(1)
          .all()
      )[0];
      if (!share || share.projectId !== c.req.param("id"))
        throw errors.notFound("Share was not found.");
    }
    const rows = await env.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.projectId, c.req.param("id")),
          isNull(assets.deletedAt),
          folderId ? eq(assets.folderId, folderId) : undefined,
          selectedOnly ? isNotNull(assets.selectedAt) : undefined,
          shareId
            ? inArray(
                assets.id,
                env.db
                  .select({ id: shareAssets.assetId })
                  .from(shareAssets)
                  .where(eq(shareAssets.shareId, shareId)),
              )
            : undefined,
          listing.where,
        ),
      )
      .orderBy(...listing.order)
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    /* The browsing surfaces need a poster, a sprite, a version count and the
       current version's transcode state for every card. Leaving those to two
       follow-up reads per asset made a grid of N cost up to 2N round-trips,
       three at a time; two batched queries here put the same facts on the
       list itself, and the client only falls back to the per-asset reads for
       rows written by servers that predate this. */
    const versionRows = page.length
      ? await env.db
          .select()
          .from(assetVersions)
          /* Soft-deleted versions excluded so version_count cannot over-count
             once version-trash is wired; a no-op until then. */
          .where(
            and(
              inArray(
                assetVersions.assetId,
                page.map((asset) => asset.id),
              ),
              isNull(assetVersions.deletedAt),
            ),
          )
          .all()
      : [];
    const versionsByAsset = new Map<
      string,
      Array<typeof assetVersions.$inferSelect>
    >();
    for (const version of versionRows) {
      const list = versionsByAsset.get(version.assetId) ?? [];
      list.push(version);
      versionsByAsset.set(version.assetId, list);
    }
    for (const list of versionsByAsset.values())
      list.sort((a, b) => (a.id < b.id ? 1 : -1));
    const currentOf = (
      asset: typeof assets.$inferSelect,
    ): typeof assetVersions.$inferSelect | null => {
      const list = versionsByAsset.get(asset.id) ?? [];
      return (
        list.find((version) => version.id === asset.currentVersionId) ??
        list[0] ??
        null
      );
    };
    const currentIds = page
      .map((asset) => currentOf(asset)?.id)
      .filter((id): id is string => Boolean(id));
    const renditionRows = currentIds.length
      ? await env.db
          .select()
          .from(renditions)
          .where(
            and(
              inArray(renditions.versionId, currentIds),
              inArray(renditions.kind, [...POSTER_FALLBACK_KINDS, "sprite"]),
              /* The base renditions index is partial (WHERE share_id IS NULL);
                 without this predicate the planner cannot use it and falls to
                 a full scan on the hottest path there is. Poster and sprite
                 are always base renditions, so this only narrows to the rows
                 we already want. */
              isNull(renditions.shareId),
            ),
          )
          .all()
      : [];
    const renditionsByVersion = new Map<
      string,
      Array<typeof renditions.$inferSelect>
    >();
    for (const rendition of renditionRows) {
      const list = renditionsByVersion.get(rendition.versionId) ?? [];
      list.push(rendition);
      renditionsByVersion.set(rendition.versionId, list);
    }
    const mediaFor = async (asset: typeof assets.$inferSelect) => {
      const current = currentOf(asset);
      const kinds = current ? (renditionsByVersion.get(current.id) ?? []) : [];
      /* Same fallback order as the share room: poster, then whichever still
         rung exists. A JPEG uploaded before the stills ladder has no poster
         at all and would otherwise be a blank card. */
      const poster = kinds
        .filter((rendition) => rendition.kind !== "sprite")
        .sort(
          (left, right) => posterRank(left.kind) - posterRank(right.kind),
        )[0];
      const sprite = kinds.find((rendition) => rendition.kind === "sprite");
      const spriteMeta = sprite ? parseJsonObject(sprite.metaJson) : {};
      const vttKey =
        typeof spriteMeta.vtt_blob_key === "string"
          ? spriteMeta.vtt_blob_key
          : undefined;
      const signed = async (versionId: string, blobKey: string) =>
        env.blobStore ? await privateMediaUrl({ versionId }, blobKey) : null;
      return {
        version_count: (versionsByAsset.get(asset.id) ?? []).length,
        current_version: current ? listCardVersion(current) : null,
        poster_url:
          poster && current ? await signed(current.id, poster.blobKey) : null,
        sprite_url:
          sprite && current ? await signed(current.id, sprite.blobKey) : null,
        sprite_vtt_url:
          vttKey && current ? await signed(current.id, vttKey) : null,
      };
    };
    return c.json({
      items: await Promise.all(
        page.map(async (asset: typeof assets.$inferSelect) => ({
          ...assetWire(asset),
          media: await mediaFor(asset),
        })),
      ),
      next_cursor:
        rows.length > limit ? listing.cursor(page[page.length - 1]!) : null,
    });
  });

  api.get("/assets/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(
      await assetParam(c.req.param("id")),
      actor,
    );
    /* Trashed is gone as far as reads are concerned. Restore still works: it
       goes through assetForActor with the id the trash listing already has,
       and does not come through here. */
    if (asset.deletedAt !== null) throw errors.notFound("Asset was not found.");
    return c.json(assetWire(asset));
  });

  api.patch("/assets/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.assetPatch);
    if (body.status !== undefined)
      await requireProject(asset.projectId, actor, "manager");
    /* A folder move must land in an assets folder of THIS project. Without the
       check a stray id filed the asset under another project's tree (or a
       shares folder), where every folder listing -- all scoped by project --
       stopped showing it: orphaned in the UI with no way back. */
    if (body.folder_id != null)
      await requireDestinationFolder(asset.projectId, body.folder_id);
    const [updated] = await env.db
      .update(assets)
      .set({
        ...(body.name
          ? { name: body.name.trim(), stackKey: stackKeyOf(body.name.trim()) }
          : {}),
        ...(body.folder_id === undefined ? {} : { folderId: body.folder_id }),
        ...(body.status ? { status: body.status } : {}),
        ...(body.selected === undefined
          ? {}
          : { selectedAt: body.selected ? env.clock.now() : null }),
        ...(body.description === undefined
          ? {}
          : { description: body.description }),
        ...(body.tags === undefined
          ? {}
          : { tagsJson: JSON.stringify(body.tags) }),
        ...(body.display_transfer === undefined
          ? {}
          : {
              displayTransfer:
                body.display_transfer === "auto" ? null : body.display_transfer,
            }),
        updatedAt: nextAssetStamp(env.clock.now()),
      })
      .where(
        and(assetPredicate(asset.id, body.expected), isNull(assets.deletedAt)),
      )
      .returning()
      .all();
    if (!updated)
      throw errors.conflict("The asset changed. Refresh before trying again.");
    if (body.status !== undefined)
      await notifyApprovalChange({
        asset: updated,
        status: body.status,
        actorUserId: actor.id,
        actorName: actor.name,
      });
    return c.json(assetWire(updated));
  });

  const trashAsset = async (
    c: Context<{ Variables: Variables }, "/assets/:id">,
  ) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = (await jsonBody(c, bodies.assetTrash.optional())) ?? {};
    const stamp = nextAssetStamp(env.clock.now());
    const [updated] = await env.db
      .update(assets)
      .set({ deletedAt: stamp, updatedAt: stamp })
      .where(assetPredicate(asset.id, body.expected))
      .returning()
      .all();
    if (!updated)
      throw errors.conflict("The asset changed. Refresh before trying again.");
    return body.return_asset ? c.json(assetWire(updated)) : c.body(null, 204);
  };
  api.delete("/assets/:id", requireAuth, trashAsset);
  api.post("/assets/:id/trash", requireAuth, trashAsset);

  /* A chosen thumbnail: an uploaded picture, or a frame captured out of the
     viewer and uploaded as a PNG. Same shape as the project cover -- a
     completed upload session, no transcode, no asset row -- because this is
     already a still and the poster pipeline exists to make stills out of
     footage. The old blob is left for the GC rather than deleted inline: the
     new pointer is the truth, and a delete that races a reader serves a
     broken picture. */
  api.put("/assets/:id/thumbnail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.assetThumbnailPut);
    const upload = await findUpload(body.upload_id, actor);
    if (upload.projectId !== asset.projectId || upload.status !== "completed")
      throw errors.validation("Upload must be completed for this project.");
    if (!isImageFilename(upload.clientFilename))
      throw errors.validation("A thumbnail must be an image.");
    await env.db
      .update(assets)
      .set({
        thumbnailBlobKey: upload.blobKey,
        updatedAt: nextAssetStamp(env.clock.now()),
      })
      .where(eq(assets.id, asset.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, asset.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    return c.json(assetWire(updated));
  });

  api.delete("/assets/:id/thumbnail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    await env.db
      .update(assets)
      .set({
        thumbnailBlobKey: null,
        updatedAt: nextAssetStamp(env.clock.now()),
      })
      .where(eq(assets.id, asset.id))
      .run();
    return c.body(null, 204);
  });

  /* Served from a stable path rather than a signed media URL so that the wire
     mapper can stay synchronous: the asset row already says whether there is
     one, and updated_at busts the cache when it changes. */
  api.get("/assets/:id/thumbnail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor);
    if (!asset.thumbnailBlobKey || !env.blobStore) throw errors.notFound();
    let stream: ReadableStream;
    try {
      stream = await env.blobStore.getStream(asset.thumbnailBlobKey);
    } catch {
      throw errors.notFound();
    }
    return new Response(stream, {
      headers: {
        "Content-Type": await blobContentType(asset.thumbnailBlobKey),
        "Cache-Control": "private, max-age=86400",
      },
    });
  });

  api.get("/assets/:id/versions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor);
    const rows = await env.db
      .select()
      .from(assetVersions)
      /* Exclude soft-deleted versions. The column exists and purgeTrashedVersions
         is ready, but no route sets it yet -- so this is a no-op today that makes
         the listing correct-by-construction the moment version-trash is wired,
         rather than a leak that has to be remembered. */
      .where(
        and(
          eq(assetVersions.assetId, asset.id),
          isNull(assetVersions.deletedAt),
        ),
      )
      .orderBy(desc(assetVersions.versionNo))
      .all();
    return c.json({
      items: rows.map((version: typeof assetVersions.$inferSelect) =>
        versionWire(version),
      ),
    });
  });

  api.post("/assets/:id/restore", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = (await jsonBody(c, bodies.assetRestore.optional())) ?? {};
    const [restored] = await env.db
      .update(assets)
      .set({ deletedAt: null, updatedAt: nextAssetStamp(env.clock.now()) })
      .where(assetPredicate(asset.id, body.expected))
      .returning()
      .all();
    if (!restored)
      throw errors.conflict("The asset changed. Refresh before trying again.");
    return c.json(assetWire(restored));
  });
};
