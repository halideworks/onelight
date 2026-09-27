import { eq, sql } from "drizzle-orm";
import { assets, assetVersions } from "@onelight/db/schema";
import { errors, stackKeyOf } from "@onelight/core";
import { requireAuth } from "../auth.js";
import { jsonBody, userFromContext } from "../helpers.js";
import { bodies } from "../schemas.js";
import { assetWire, versionWire } from "../wire.js";
import {
  stackPredicate,
  signStackUndo,
  verifyStackUndo,
  stackDigest,
} from "../operation/version-stack.js";
import type { Access } from "../operation/access.js";
import type { Activity } from "../operation/activity.js";
import type { Uploads } from "../operation/uploads.js";
import type { ApiRouter, AppEnv } from "../types.js";

export const registerVersionStacksRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    activity,
    uploads,
  }: { access: Access; activity: Activity; uploads: Uploads },
) => {
  const result = async (assetId: string, versionId: string) => {
    const asset = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, assetId))
        .limit(1)
        .all()
    )[0];
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, versionId))
        .limit(1)
        .all()
    )[0];
    if (!asset || !version)
      throw errors.conflict("The version changed again. Refresh the library.");
    return { asset: assetWire(asset), version: versionWire(version) };
  };
  const announce = (
    projectId: string,
    sourceId: string,
    detachedId: string,
    versionId: string,
  ) =>
    activity.appendProjectEvent(projectId, "asset.versions_changed", {
      asset_id: sourceId,
      asset_ids: [sourceId, detachedId],
      version_id: versionId,
    });

  api.post("/versions/:id/unstack", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await access.versionForActor(
      c.req.param("id"),
      actor,
      "editor",
    );
    const source = await access.assetForActor(version.assetId, actor, "editor");
    const { expected, undo_token: uploadUndo } = await jsonBody(
      c,
      bodies.versionUnstack,
    );
    if (source.deletedAt !== null || version.deletedAt !== null)
      throw errors.notFound();
    if (expected.asset_id !== source.id)
      throw errors.conflict("The version is no longer in this stack.");
    const live = await env.db
      .select({
        id: assetVersions.id,
        no: assetVersions.versionNo,
        deleted: assetVersions.deletedAt,
      })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, source.id))
      .all();
    const remaining = live
      .filter((row) => row.id !== version.id && row.deleted === null)
      .sort((a, b) => b.no - a.no);
    if (!remaining.length)
      throw errors.conflict("The only version cannot be unstacked.");
    let current =
      expected.current_version_id === version.id
        ? remaining[0]!.id
        : expected.current_version_id;
    if (uploadUndo) {
      const claim = await verifyStackUndo(
        env,
        actor,
        uploadUndo,
        "unstack",
        source.projectId,
        version.id,
        expected,
      );
      if (claim.asset_id !== source.id)
        throw errors.conflict("The upload no longer belongs to this stack.");
      current = claim.current_version_id;
    }
    if (current === null || !remaining.some((row) => row.id === current))
      throw errors.conflict("The remaining current version changed.");
    const detachedId = env.ids.ulid();
    const publicId = await access.newAssetPublicId();
    const now = env.clock.now();
    const changed = await env.db.atomic([
      sql`INSERT INTO assets (id, public_id, project_id, folder_id, name, stack_key, kind, display_transfer, current_version_id, created_at, updated_at)
          SELECT ${detachedId}, ${publicId}, project_id, folder_id, ${version.originalFilename}, ${stackKeyOf(version.originalFilename)}, ${uploads.assetKind(version.originalFilename)}, display_transfer, ${version.id}, ${now}, ${now}
          FROM assets WHERE ${stackPredicate(expected)}
          AND EXISTS (SELECT 1 FROM asset_versions WHERE id = ${version.id} AND asset_id = ${source.id} AND deleted_at IS NULL)
          AND EXISTS (SELECT 1 FROM asset_versions WHERE id = ${current} AND asset_id = ${source.id} AND deleted_at IS NULL)
          RETURNING id`,
      sql`UPDATE asset_versions SET asset_id = ${detachedId}, version_no = 1 WHERE changes() = 1 AND id = ${version.id} AND asset_id = ${source.id} RETURNING id`,
      sql`UPDATE assets SET current_version_id = ${current}, updated_at = max(updated_at + 1, ${now}) WHERE changes() = 1 AND id = ${source.id} RETURNING id`,
    ]);
    if (!changed[0]?.length)
      throw errors.conflict("The stack changed. Refresh before unstacking.");
    const sourceStack = {
      ...expected,
      current_version_id: current,
      versions: expected.versions.filter((row) => row.id !== version.id),
    };
    const undoToken = await signStackUndo(env, actor, {
      action: "restack",
      project_id: source.projectId,
      version_id: version.id,
      asset_id: source.id,
      current_version_id: expected.current_version_id,
      version_no: version.versionNo,
      detached_id: detachedId,
      detached_updated_at: now,
      expected_digest: await stackDigest(sourceStack),
    });
    await announce(source.projectId, source.id, detachedId, version.id);
    return c.json({
      ...(await result(detachedId, version.id)),
      source_stack: sourceStack,
      before_stack: expected,
      undo_token: undoToken,
    });
  });

  api.post("/versions/:id/restack", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await access.versionForActor(
      c.req.param("id"),
      actor,
      "editor",
    );
    const detached = await access.assetForActor(
      version.assetId,
      actor,
      "editor",
    );
    const { expected, undo_token: token } = await jsonBody(
      c,
      bodies.versionRestack,
    );
    const claim = await verifyStackUndo(
      env,
      actor,
      token,
      "restack",
      detached.projectId,
      version.id,
      expected,
    );
    if (
      claim.detached_id !== detached.id ||
      claim.asset_id !== expected.asset_id ||
      claim.version_no === undefined ||
      claim.detached_updated_at === undefined
    )
      throw errors.conflict("This undo does not match the detached version.");
    const target = await access.assetForActor(claim.asset_id, actor, "editor");
    if (target.projectId !== detached.projectId || detached.id === target.id)
      throw errors.conflict("Versions must remain in their original project.");
    const now = env.clock.now();
    const changed = await env.db.atomic([
      sql`UPDATE assets SET current_version_id = ${claim.current_version_id}, updated_at = max(updated_at + 1, ${now})
          WHERE ${stackPredicate(expected)}
          AND EXISTS (SELECT 1 FROM assets d WHERE d.id = ${detached.id} AND d.deleted_at IS NULL AND d.updated_at = ${claim.detached_updated_at} AND d.current_version_id = ${version.id})
          AND (SELECT count(*) FROM asset_versions WHERE asset_id = ${detached.id}) = 1
          AND EXISTS (SELECT 1 FROM asset_versions WHERE id = ${version.id} AND asset_id = ${detached.id} AND version_no = 1 AND deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM asset_versions WHERE asset_id = ${target.id} AND version_no = ${claim.version_no})
          AND (${claim.current_version_id} = ${version.id} OR EXISTS (SELECT 1 FROM asset_versions WHERE id = ${claim.current_version_id} AND asset_id = ${target.id} AND deleted_at IS NULL))
          AND NOT EXISTS (SELECT 1 FROM share_assets WHERE asset_id = ${detached.id})
          AND NOT EXISTS (SELECT 1 FROM transfer_items WHERE asset_id = ${detached.id})
          AND NOT EXISTS (SELECT 1 FROM transfer_receipts WHERE asset_id = ${detached.id})
          AND NOT EXISTS (SELECT 1 FROM transfer_downloads WHERE asset_id = ${detached.id})
          AND NOT EXISTS (SELECT 1 FROM projects WHERE cover_asset_id = ${detached.id})
          AND NOT EXISTS (SELECT 1 FROM download_manifests, json_each(download_manifests.asset_ids_json) manifest_asset WHERE download_manifests.project_id = ${target.projectId} AND download_manifests.expires_at > ${now} AND manifest_asset.value = ${detached.id})
          RETURNING id`,
      sql`UPDATE asset_versions SET asset_id = ${target.id}, version_no = ${claim.version_no} WHERE changes() = 1 AND id = ${version.id} AND asset_id = ${detached.id} RETURNING id`,
      sql`DELETE FROM assets WHERE changes() = 1 AND id = ${detached.id} AND NOT EXISTS (SELECT 1 FROM asset_versions WHERE asset_id = ${detached.id}) RETURNING id`,
    ]);
    if (!changed[0]?.length)
      throw errors.conflict(
        "The stack or detached asset changed. Undo cannot safely restore it.",
      );
    await announce(target.projectId, target.id, detached.id, version.id);
    const restored = {
      ...expected,
      current_version_id: claim.current_version_id,
      versions: [
        ...expected.versions,
        { id: version.id, version_no: claim.version_no },
      ].sort((a, b) => a.version_no - b.version_no),
    };
    return c.json({
      ...(await result(target.id, version.id)),
      stack_state: restored,
    });
  });
};
