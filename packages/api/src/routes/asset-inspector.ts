import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  assetVersions,
  projectEvents,
  shareAssets,
  shares,
} from "@onelight/db/schema";
import { errors, projectRoleAtLeast } from "@onelight/core";
import { requireAuth } from "../auth.js";
import { userFromContext } from "../helpers.js";
import type { Access } from "../operation/access.js";
import type { ApiRouter, AppEnv } from "../types.js";

export const registerAssetInspectorRoutes = (
  api: ApiRouter,
  env: AppEnv,
  { access }: { access: Access },
): void => {
  api.get("/assets/:id/context", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await access.assetForActor(
      await access.assetParam(c.req.param("id")),
      actor,
    );
    if (asset.deletedAt !== null) throw errors.notFound("Asset was not found.");
    const { role } = await access.requireProject(
      asset.projectId,
      actor,
      "viewer",
    );
    const limit = 50;
    const [memberships, events] = await Promise.all([
      projectRoleAtLeast(role, "manager")
        ? env.db
            .select({
              id: shares.id,
              title: shares.title,
              revoked_at: shares.revokedAt,
              expires_at: shares.expiresAt,
            })
            .from(shares)
            .innerJoin(shareAssets, eq(shareAssets.shareId, shares.id))
            .where(
              and(
                eq(shares.projectId, asset.projectId),
                eq(shareAssets.assetId, asset.id),
              ),
            )
            .orderBy(desc(shares.id))
            .limit(limit + 1)
            .all()
        : Promise.resolve(null),
      env.db
        .select({
          id: projectEvents.id,
          type: projectEvents.type,
          at: projectEvents.createdAt,
        })
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, asset.projectId),
            or(
              sql`json_extract(${projectEvents.payloadJson}, '$.asset_id') = ${asset.id}`,
              inArray(
                sql<string>`json_extract(${projectEvents.payloadJson}, '$.version_id')`,
                env.db
                  .select({ id: assetVersions.id })
                  .from(assetVersions)
                  .where(eq(assetVersions.assetId, asset.id)),
              ),
            ),
          ),
        )
        .orderBy(desc(projectEvents.id))
        .limit(limit + 1)
        .all(),
    ]);
    /* Explicit projections above never fetch share secrets or event payloads.
       This is retained project activity, not the complete audit ledger. */
    return c.json({
      shares:
        memberships === null
          ? null
          : {
              items: memberships.slice(0, limit),
              has_more: memberships.length > limit,
            },
      activity: {
        items: events.slice(0, limit),
        has_more: events.length > limit,
      },
    });
  });
};
