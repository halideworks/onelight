import { requireAuth } from "../auth.js";
import {
  userFromContext,
  SEARCH_STREAMS,
  getLimit,
  searchCursorParam,
  extractHashtags,
  encodeSearchCursor,
} from "../helpers.js";
import { errors, implicitProjectRole } from "@onelight/core";
import type { SearchStream } from "../helpers.js";
import { sql, and, eq, lt, desc, isNull } from "drizzle-orm";
import {
  projects,
  shares,
  assets,
  comments,
  assetVersions,
  users,
} from "@onelight/db/schema";
import type { AppEnv, ApiRouter, ActorUser } from "../types.js";
import type { Access } from "../operation/access.js";
import type { Projects } from "../operation/projects.js";

export const registerSearchRoutes = (
  api: ApiRouter,
  env: AppEnv,
  { access, projectsOps }: { access: Access; projectsOps: Projects },
) => {
  const { grantFor } = access;
  const { coverUrlFor } = projectsOps;

  // Search: scope=assets|comments|all with keyset cursor pagination. Assets
  // stream first (id desc), then comments; the cursor carries which stream
  // it points into so pages never drop or duplicate rows across the seam.
  api.get("/search", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 2)
      throw errors.validation(
        "Search query must contain at least two characters.",
      );
    const SCOPES: Record<string, SearchStream[]> = {
      all: [...SEARCH_STREAMS],
      assets: ["asset"],
      comments: ["comment"],
      projects: ["project"],
      people: ["person"],
      shares: ["share"],
    };
    const scope = c.req.query("scope") ?? "all";
    const wanted = SCOPES[scope];
    if (!wanted)
      throw errors.validation(
        `Search scope must be one of: ${Object.keys(SCOPES).join(", ")}.`,
      );
    const limit = getLimit(c.req.query("limit"));
    const cursor = searchCursorParam(c.req.query("cursor"));
    if (cursor && !wanted.includes(cursor.t))
      throw errors.validation("Cursor does not match the requested scope.");
    // Escape LIKE metacharacters (%, _, and the escape char itself) so a
    // query containing them matches literally instead of widening the search
    // within the caller's workspace. The LIKE conditions declare ESCAPE '\'.
    const escapeLike = (value: string): string =>
      value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escapeLike(q)}%`;
    // A query starting with # is a hashtag search: comments match when they
    // contain that exact tag token (derived, see extractHashtags), not just
    // the substring. The LIKE fetch is a candidate superset ("#tag" also
    // matches "#tagged"); rows are re-checked against the extracted tags
    // before they count.
    const tagQuery = q.startsWith("#") ? q.slice(1).toLowerCase() : undefined;
    const commentPattern = tagQuery ? `%#${escapeLike(tagQuery)}%` : pattern;
    /* FTS5's trigram tokenizer preserves the existing substring behavior.
       LIKE remains the final literal check, so FTS only narrows candidates and
       can never widen a query. Two-character searches take the LIKE path
       because a trigram index has no token for them. */
    const ftsQuery =
      env.searchBackend === "fts5" && Array.from(q).length >= 3
        ? `"${q.replace(/"/g, '""')}"`
        : null;
    const searchMatch = (
      kind: SearchStream,
      id: unknown,
      likeCondition: ReturnType<typeof sql>,
    ) =>
      ftsQuery
        ? and(
            likeCondition,
            sql`EXISTS (
              SELECT 1 FROM onelight_search
              WHERE kind = ${kind}
                AND entity_id = ${id}
                AND onelight_search MATCH ${ftsQuery}
            )`,
          )
        : likeCondition;
    const items: Array<Record<string, unknown>> = [];
    let nextCursor: string | null = null;

    /* Restricted projects are invisible to anyone without a grant, so search
       cannot simply LIKE over the workspace: that would leak the names of
       projects the caller cannot open, and the names of their shares with
       them. Both streams post-filter with the same rule the project read uses,
       and keep scanning so a filtered-out row does not consume a page slot. */
    const visibleCache = new Map<string, boolean>();
    const visibleProject = async (
      project: typeof projects.$inferSelect,
    ): Promise<boolean> => {
      const cached = visibleCache.get(project.id);
      if (cached !== undefined) return cached;
      const visible =
        implicitProjectRole(
          actor.role,
          Boolean(project.restricted),
          (await grantFor(project.id, actor.id)) ?? undefined,
        ) !== undefined;
      visibleCache.set(project.id, visible);
      return visible;
    };

    const matchingProjects = async (
      after: string | undefined,
      take: number,
    ): Promise<Array<typeof projects.$inferSelect>> => {
      const collected: Array<typeof projects.$inferSelect> = [];
      let scanCursor = after;
      for (;;) {
        const batch = await env.db
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.workspaceId, actor.workspaceId),
              searchMatch(
                "project",
                projects.id,
                sql`${projects.name} LIKE ${pattern} ESCAPE '\\'`,
              ),
              scanCursor ? lt(projects.id, scanCursor) : undefined,
            ),
          )
          .orderBy(desc(projects.id))
          .limit(Math.max(take, 25))
          .all();
        for (const project of batch) {
          if (await visibleProject(project)) collected.push(project);
          if (collected.length === take) return collected;
        }
        if (batch.length < Math.max(take, 25)) return collected;
        scanCursor = batch[batch.length - 1]?.id;
      }
    };

    const matchingShares = async (
      after: string | undefined,
      take: number,
    ): Promise<Array<typeof shares.$inferSelect>> => {
      const collected: Array<typeof shares.$inferSelect> = [];
      let scanCursor = after;
      for (;;) {
        const batch = await env.db
          .select({ share: shares, project: projects })
          .from(shares)
          .innerJoin(projects, eq(shares.projectId, projects.id))
          .where(
            and(
              eq(projects.workspaceId, actor.workspaceId),
              isNull(shares.revokedAt),
              searchMatch(
                "share",
                shares.id,
                sql`${shares.title} LIKE ${pattern} ESCAPE '\\'`,
              ),
              scanCursor ? lt(shares.id, scanCursor) : undefined,
            ),
          )
          .orderBy(desc(shares.id))
          .limit(Math.max(take, 25))
          .all();
        for (const row of batch) {
          if (await visibleProject(row.project)) collected.push(row.share);
          if (collected.length === take) return collected;
        }
        if (batch.length < Math.max(take, 25)) return collected;
        scanCursor = batch[batch.length - 1]?.share.id;
      }
    };
    /* Assets carry a restricted project's names; like the project and share
       streams, this post-filters every candidate through visibleProject so a
       member without a grant -- or a guest, who may see nothing ungranted --
       cannot read the names of assets in projects they cannot open. */
    const matchingAssets = async (
      after: string | undefined,
      take: number,
    ): Promise<Array<typeof assets.$inferSelect>> => {
      const collected: Array<typeof assets.$inferSelect> = [];
      let scanCursor = after;
      for (;;) {
        const batch = await env.db
          .select({ asset: assets, project: projects })
          .from(assets)
          .innerJoin(projects, eq(assets.projectId, projects.id))
          .where(
            and(
              eq(projects.workspaceId, actor.workspaceId),
              isNull(assets.deletedAt),
              searchMatch(
                "asset",
                assets.id,
                sql`${assets.name} LIKE ${pattern} ESCAPE '\\'`,
              ),
              scanCursor ? lt(assets.id, scanCursor) : undefined,
            ),
          )
          .orderBy(desc(assets.id))
          .limit(Math.max(take, 25))
          .all();
        for (const row of batch) {
          if (await visibleProject(row.project)) collected.push(row.asset);
          if (collected.length === take) return collected;
        }
        if (batch.length < Math.max(take, 25)) return collected;
        scanCursor = batch[batch.length - 1]?.asset.id;
      }
    };
    const fetchCommentRows = (after: string | undefined, take: number) =>
      env.db
        .select()
        .from(comments)
        .innerJoin(assetVersions, eq(comments.versionId, assetVersions.id))
        .innerJoin(assets, eq(assetVersions.assetId, assets.id))
        .innerJoin(projects, eq(assets.projectId, projects.id))
        .where(
          and(
            eq(projects.workspaceId, actor.workspaceId),
            isNull(comments.deletedAt),
            searchMatch(
              "comment",
              comments.id,
              sql`${comments.bodyText} LIKE ${commentPattern} ESCAPE '\\'`,
            ),
            after ? lt(comments.id, after) : undefined,
          ),
        )
        .orderBy(desc(comments.id))
        .limit(take)
        .all();
    type CommentRow = Awaited<ReturnType<typeof fetchCommentRows>>[number];
    /* Comment bodies are the most sensitive text in the app (client feedback),
       so this always post-filters by project visibility -- and by the hashtag
       token when the query is one. A plain LIKE over the workspace, as this
       once was, disclosed the notes on restricted projects to anyone. */
    const matchingComments = async (
      after: string | undefined,
      take: number,
    ): Promise<CommentRow[]> => {
      const batchSize = Math.max(take, 50);
      const collected: CommentRow[] = [];
      let cursor = after;
      for (;;) {
        const batch = await fetchCommentRows(cursor, batchSize);
        for (const row of batch) {
          const tagOk =
            !tagQuery ||
            extractHashtags(row.comments.bodyText).includes(tagQuery);
          if (tagOk && (await visibleProject(row.projects)))
            collected.push(row);
          if (collected.length === take) return collected;
        }
        if (batch.length < batchSize) return collected;
        cursor = batch[batch.length - 1]?.comments.id;
      }
    };
    /* Every stream answers one question -- "give me the next N hits after this
       id" -- and returns them already shaped for the wire, each with the id a
       cursor would resume from. One loop then drives all five, rather than a
       bespoke branch each with its own seam handling. Streams are consumed in
       order, and the cursor names which one the next page resumes in, so a page
       break never drops or repeats a row. */
    interface Hit {
      wire: Record<string, unknown>;
      id: string;
    }
    interface Stream {
      t: SearchStream;
      page: (after: string | undefined, take: number) => Promise<Hit[]>;
    }

    const streams: Stream[] = [
      {
        t: "asset",
        page: async (after, take) =>
          (await matchingAssets(after, take)).map((asset) => ({
            id: asset.id,
            wire: {
              type: "asset",
              id: asset.id,
              public_id: asset.publicId ?? asset.id,
              name: asset.name,
              project_id: asset.projectId,
              /* Enough to draw the row without a second request per hit: the
                 version to fetch a poster for, and when it happened. */
              current_version_id: asset.currentVersionId,
              updated_at: asset.updatedAt,
            },
          })),
      },
      {
        t: "comment",
        page: async (after, take) =>
          (await matchingComments(after, take)).map((row) => ({
            id: row.comments.id,
            wire: {
              type: "comment",
              id: row.comments.id,
              body_text: row.comments.bodyText,
              asset_id: row.assets.id,
              version_id: row.comments.versionId,
              project_id: row.assets.projectId,
              // Deep-link anchor for ?f= so search hits jump to the frame.
              frame_in: row.comments.frameIn,
              updated_at: row.comments.createdAt,
            },
          })),
      },
      {
        t: "project",
        page: async (after, take) =>
          Promise.all(
            (await matchingProjects(after, take)).map(async (row) => ({
              id: row.id,
              wire: {
                type: "project",
                id: row.id,
                public_id: row.publicId ?? row.id,
                name: row.name,
                palette: row.palette,
                cover_url: await coverUrlFor(row),
                updated_at: row.updatedAt,
              },
            })),
          ),
      },
      {
        t: "person",
        /* The member directory (names AND emails) is not for guests: a guest
           has no project of their own and no reason to enumerate the team, and
           this stream would otherwise hand them every address. */
        page: async (after, take) =>
          (actor.role === "guest"
            ? []
            : await env.db
                .select()
                .from(users)
                .where(
                  and(
                    eq(users.workspaceId, actor.workspaceId),
                    isNull(users.disabledAt),
                    searchMatch(
                      "person",
                      users.id,
                      sql`(${users.name} LIKE ${pattern} ESCAPE '\\' OR ${users.email} LIKE ${pattern} ESCAPE '\\')`,
                    ),
                    after ? lt(users.id, after) : undefined,
                  ),
                )
                .orderBy(desc(users.id))
                .limit(take)
                .all()
          ).map((row: ActorUser) => ({
            id: row.id,
            wire: {
              type: "person",
              id: row.id,
              name: row.name,
              email: row.email,
              updated_at: row.updatedAt,
            },
          })),
      },
      {
        t: "share",
        page: async (after, take) =>
          (await matchingShares(after, take)).map((row) => ({
            id: row.id,
            wire: {
              type: "share",
              id: row.id,
              title: row.title,
              slug: row.slug,
              project_id: row.projectId,
              updated_at: row.createdAt,
            },
          })),
      },
    ];

    for (const [index, stream] of streams.entries()) {
      if (!wanted.includes(stream.t)) continue;
      // Skip streams that come before the one the cursor points into.
      if (cursor && streams.findIndex((entry) => entry.t === cursor.t) > index)
        continue;
      const remaining = limit - items.length;
      if (remaining <= 0) break;
      const after = cursor?.t === stream.t ? cursor.id : undefined;
      const hits = await stream.page(after, remaining + 1);
      const pageHits = hits.slice(0, remaining);
      items.push(...pageHits.map((hit) => hit.wire));
      if (hits.length > remaining) {
        const last = pageHits[pageHits.length - 1];
        if (last) nextCursor = encodeSearchCursor(stream.t, last.id);
        break;
      }
      // This stream is exhausted. If the page is full, the next page has to say
      // where to resume, and only a stream with something in it may claim it.
      if (items.length >= limit) {
        for (const later of streams.slice(index + 1)) {
          if (!wanted.includes(later.t)) continue;
          const peek = await later.page(undefined, 1);
          if (peek.length) {
            nextCursor = encodeSearchCursor(later.t);
            break;
          }
        }
        break;
      }
    }
    return c.json({ items, next_cursor: nextCursor });
  });
};
