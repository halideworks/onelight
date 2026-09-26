import type { projects } from "@onelight/db/schema";
import {
  renditions,
  assets,
  assetVersions,
  projectMembers,
  projectEvents,
  projectVisits,
} from "@onelight/db/schema";
import { eq, and, isNull, desc, inArray, sql } from "drizzle-orm";
import type { WorkspaceRole } from "@onelight/core";
import { implicitProjectRole } from "@onelight/core";
import { parseJsonObject } from "../helpers.js";
import type { AppEnv } from "../types.js";
import type { Media } from "./media.js";
import type { Access } from "./access.js";

export const createProjects = (env: AppEnv, media: Media, access: Access) => {
  const { privateMediaUrl } = media;
  const { grantFor } = access;

  /* The cover picture is the poster rendition of one of the project's own
     assets, so a cover costs no new storage and no new pipeline -- the poster
     was already generated when the asset was uploaded. Resolving returns null
     for a cover whose asset was deleted, whose current version is gone, or
     whose poster has not been produced yet; each of those is a normal state,
     and the client draws the generated palette cover instead. */
  const coverUrlFor = async (
    project: typeof projects.$inferSelect,
  ): Promise<string | null> => {
    /* An uploaded cover is the picture itself: no rendition to wait for, so it
       shows the moment the upload lands. */
    if (project.coverBlobKey)
      return privateMediaUrl({ projectId: project.id }, project.coverBlobKey);
    if (!project.coverAssetId) return null;
    const row = (
      await env.db
        .select({
          versionId: renditions.versionId,
          blobKey: renditions.blobKey,
        })
        .from(assets)
        .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
        .innerJoin(
          renditions,
          and(
            eq(renditions.versionId, assetVersions.id),
            eq(renditions.kind, "poster"),
            isNull(renditions.shareId),
          ),
        )
        .where(
          and(
            eq(assets.id, project.coverAssetId),
            // A cover must live in the project it covers: a stale id from
            // another project must not leak a frame across a permission
            // boundary.
            eq(assets.projectId, project.id),
            isNull(assets.deletedAt),
            isNull(assetVersions.deletedAt),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!row) return null;
    return privateMediaUrl({ versionId: row.versionId }, row.blobKey);
  };

  /* Per-project facts the wire needs that each cost a query: the caller's
     grant, the cover URL, and the last-activity timestamp. Resolving them one
     project at a time is three queries per row; the list endpoint precomputes
     them for a whole page in three queries total (see projectListContext) and
     passes the entry in here. Single-project callers omit it and pay the three
     small reads inline. */
  type ProjectFacts = {
    grant: (typeof projectMembers.$inferSelect)["role"] | undefined;
    coverUrl: string | null;
    lastActivityAt: number | null;
    /** When THIS person last opened it, which only they can be told. */
    lastOpenedAt: number | null;
  };

  const projectWire = async (
    project: typeof projects.$inferSelect,
    userId: string,
    workspaceRole: WorkspaceRole,
    precomputed?: ProjectFacts,
  ) => {
    const grant = precomputed
      ? precomputed.grant
      : await grantFor(project.id, userId);
    const myRole = implicitProjectRole(
      workspaceRole,
      Boolean(project.restricted),
      grant ?? undefined,
    );
    return {
      id: project.id,
      public_id: project.publicId ?? project.id,
      name: project.name,
      status: project.status,
      palette: project.palette,
      cover_asset_id: project.coverAssetId,
      /* Which kind of cover this is, so the settings page can say so without
         guessing from the URL. */
      cover_kind: project.coverBlobKey
        ? ("upload" as const)
        : project.coverAssetId
          ? ("asset" as const)
          : ("generated" as const),
      cover_url: precomputed
        ? precomputed.coverUrl
        : await coverUrlFor(project),
      restricted: Boolean(project.restricted),
      display_transfer: project.displayTransfer ?? null,
      /* Whether transfer links in this project keep the addresses of the
         people who open them. Off unless the project says otherwise. */
      record_transfer_ips:
        parseJsonObject(project.settingsJson).record_transfer_ips === true,
      created_by: project.createdBy,
      created_at: project.createdAt,
      /* When the project's own record was last edited: its name, palette,
         cover, restriction. Not when anyone last did any work in it. */
      updated_at: project.updatedAt,
      /* When anything last happened in it -- an upload, a note, an approval.
         The event log is already written for the SSE stream and is indexed on
         (project_id, id), so the newest row is one seek; ids are ULIDs, so id
         order is time order. This is what "recently edited" means to someone
         looking at a list of projects. */
      last_activity_at:
        (precomputed
          ? precomputed.lastActivityAt
          : (
              await env.db
                .select({ createdAt: projectEvents.createdAt })
                .from(projectEvents)
                .where(eq(projectEvents.projectId, project.id))
                .orderBy(desc(projectEvents.id))
                .limit(1)
                .all()
            )[0]?.createdAt) ?? project.updatedAt,
      /* When you last opened it. Not when anyone did: the recent shelf is a
         record of where this person has been, so it is per viewer and the
         only honest answer for somebody who has never opened it is null. */
      last_opened_at: precomputed
        ? precomputed.lastOpenedAt
        : ((
            await env.db
              .select({ openedAt: projectVisits.openedAt })
              .from(projectVisits)
              .where(
                and(
                  eq(projectVisits.userId, userId),
                  eq(projectVisits.projectId, project.id),
                ),
              )
              .limit(1)
              .all()
          )[0]?.openedAt ?? null),
      my_role: myRole,
    };
  };

  /* Resolve ProjectFacts for a page of projects in three queries instead of
     three per project: one grant lookup, one grouped last-activity, one cover
     join. ULID ids are time-ordered, so MAX(created_at) per project is the
     newest event -- the same value the per-project newest-by-id read returns.
     Cover URLs are signed in memory (no query) from the batched rows. */
  const projectListContext = async (
    rows: Array<typeof projects.$inferSelect>,
    userId: string,
  ): Promise<Map<string, ProjectFacts>> => {
    const facts = new Map<string, ProjectFacts>();
    if (rows.length === 0) return facts;
    const ids = rows.map((project) => project.id);

    const grantRows = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          inArray(projectMembers.projectId, ids),
        ),
      )
      .all();
    const grantByProject = new Map(
      grantRows.map((row) => [row.projectId, row.role]),
    );

    const activityRows = await env.db
      .select({
        projectId: projectEvents.projectId,
        at: sql<number>`max(${projectEvents.createdAt})`,
      })
      .from(projectEvents)
      .where(inArray(projectEvents.projectId, ids))
      .groupBy(projectEvents.projectId)
      .all();
    const activityByProject = new Map(
      activityRows.map((row) => [row.projectId, row.at]),
    );

    /* And when this person last opened each of them: one indexed read for the
       whole page. */
    const visitRows = await env.db
      .select({
        projectId: projectVisits.projectId,
        openedAt: projectVisits.openedAt,
      })
      .from(projectVisits)
      .where(
        and(
          eq(projectVisits.userId, userId),
          inArray(projectVisits.projectId, ids),
        ),
      )
      .all();
    const openedByProject = new Map(
      visitRows.map((row) => [row.projectId, row.openedAt]),
    );

    /* Asset-backed covers (an uploaded cover is its own blob, no join). The
       cover asset must live in its own project, so the map is keyed by asset
       id and the projectId is matched below. */
    const coverAssetIds = rows
      .filter((project) => !project.coverBlobKey && project.coverAssetId)
      .map((project) => project.coverAssetId as string);
    const coverRows = coverAssetIds.length
      ? await env.db
          .select({
            assetId: assets.id,
            projectId: assets.projectId,
            versionId: renditions.versionId,
            blobKey: renditions.blobKey,
          })
          .from(assets)
          .innerJoin(
            assetVersions,
            eq(assetVersions.id, assets.currentVersionId),
          )
          .innerJoin(
            renditions,
            and(
              eq(renditions.versionId, assetVersions.id),
              eq(renditions.kind, "poster"),
              isNull(renditions.shareId),
            ),
          )
          .where(
            and(
              inArray(assets.id, coverAssetIds),
              isNull(assets.deletedAt),
              isNull(assetVersions.deletedAt),
            ),
          )
          .all()
      : [];
    const coverByAsset = new Map(coverRows.map((row) => [row.assetId, row]));

    for (const project of rows) {
      let coverUrl: string | null = null;
      if (project.coverBlobKey)
        coverUrl = await privateMediaUrl(
          { projectId: project.id },
          project.coverBlobKey,
        );
      else if (project.coverAssetId) {
        const cover = coverByAsset.get(project.coverAssetId);
        if (cover && cover.projectId === project.id)
          coverUrl = await privateMediaUrl(
            { versionId: cover.versionId },
            cover.blobKey,
          );
      }
      facts.set(project.id, {
        grant: grantByProject.get(project.id),
        coverUrl,
        lastActivityAt: activityByProject.get(project.id) ?? null,
        lastOpenedAt: openedByProject.get(project.id) ?? null,
      });
    }
    return facts;
  };

  return { coverUrlFor, projectWire, projectListContext };
};

export type Projects = ReturnType<typeof createProjects>;
