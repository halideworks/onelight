import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  PALETTES,
  base64UrlEncode,
  crc32cMatches,
  crc32cStream,
  days,
  errors,
  generateBackupCodes,
  generateTotpSecret,
  implicitProjectRole,
  isSmtpConfigError,
  mailSettingsToInput,
  otpauthUrl,
  parseMarkersCsv,
  parseResolveEdl,
  parseSmtpConfig,
  projectRoleAtLeast,
  randomBytes,
  utf8,
  verifyTotp,
  sha256,
  sha256Hex,
  zipEntryName,
  zipLength,
  zipStreamFrom,
} from "@onelight/core";
import type { ZipEntry } from "@onelight/core";
import type {
  MultipartBlobStore,
  StoredMailSettings,
  WorkspaceRole,
} from "@onelight/core";
import {
  apiTokens,
  assetVersions,
  assets,
  captionTracks,
  comments,
  commentAttachments,
  commentReactions,
  auditLog,
  exportJobs,
  folders,
  identities,
  invites,
  jobs,
  projectMembers,
  projectEvents,
  projects,
  rateLimits,
  renditions,
  sessions,
  shareAssets,
  shareViewers,
  shares,
  transferDownloads,
  transferItems,
  transferReceipts,
  transferVisits,
  transfers,
  uploadParts,
  projectCoverUploads,
  uploadSessions,
  users,
  webhookDeliveries,
  webhooks,
  workspaces,
  notifications,
  notificationPreferences,
  passwordResets,
  appSettings,
} from "@onelight/db/schema";
import {
  authMiddleware,
  clearSessionCookie,
  createSession,
  OIDC_COOKIE,
  requireAuth,
  requireOrigin,
  SESSION_COOKIE,
} from "./auth.js";
import {
  clientIp,
  commentCursorParam,
  cursorParam,
  encodeCommentCursor,
  encodeCursor,
  encodeSearchCursor,
  extractHashtags,
  getLimit,
  searchCursorParam,
  SEARCH_STREAMS,
  jsonBody,
  mapError,
  parseJsonObject,
  parseJsonValue,
  userFromContext,
} from "./helpers.js";
import type { SearchStream } from "./helpers.js";
import { bodies, errorEnvelope, routeDocs } from "./schemas.js";
import type { RouteDoc } from "./schemas.js";
import type { AppEnv, SessionUser, Variables } from "./types.js";
import { redactBearerPath } from "./request-log.js";
import {
  DEFAULT_TRANSFER_REQUEST_BYTE_CAP,
  MAX_COMMENT_ATTACHMENT_BYTES,
  MAX_COMMENT_ATTACHMENTS,
  MAX_COMMENT_ATTACHMENT_TOTAL_BYTES,
  MAX_MULTIPART_PART_BYTES,
  MAX_MULTIPART_PARTS,
  PRESENCE_WRITE_INTERVAL_MS,
} from "./limits.js";
import {
  assertWebhookUrlAllowed,
  scheduleWebhookDeliveries,
} from "./webhooks.js";

/* A user as the routes handle one: either the session-derived shape (guest
   folded into role) or a raw row read from the table for wire projection.
   Property-wise identical apart from role's width. */
type UserRow = typeof users.$inferSelect;
type ActorUser = SessionUser | UserRow;

/* The keyset-pagination tail every list endpoint repeated: take `limit` of the
   `limit + 1` rows read, map them to the wire, and hand back a cursor only when
   there was an extra row. One place so the "did we over-read" check and the
   cursor cannot drift between endpoints. */
const pageResult = <T extends { id: string }, W>(
  rows: T[],
  limit: number,
  map: (row: T) => W,
): { items: W[]; next_cursor: string | null } => {
  const page = rows.slice(0, limit);
  return {
    items: page.map(map),
    next_cursor:
      rows.length > limit
        ? encodeCursor(page[page.length - 1]?.id ?? "")
        : null,
  };
};

const app = (env: AppEnv): Hono<{ Variables: Variables }> => {
  const root = new Hono<{ Variables: Variables }>();
  const api = new Hono<{ Variables: Variables }>();

  /* One mail surface for every route: the platform's dynamic control when
     present (the Node server, which resolves admin settings over the
     environment), else a static facade over the injected mailer (the
     contract harness), else undefined (mail disabled). */
  const mailControl =
    env.mail ??
    (env.mailer
      ? {
          status: () =>
            Promise.resolve({
              state: "ready" as const,
              detail: null,
              source: "env" as const,
            }),
          send: (message: { to: string; subject: string; text: string }) =>
            env.mailer!.send(message),
          reload: (): void => {},
        }
      : undefined);
  const mailStatus = async (): Promise<{
    state: "ready" | "disabled" | "error";
    detail: string | null;
    source: "settings" | "env" | "none";
  }> =>
    mailControl
      ? mailControl.status()
      : { state: "disabled", detail: null, source: "none" };

  root.use("*", authMiddleware(env));
  root.use("*", requireOrigin(env));

  const errorHandler = (
    error: unknown,
    c: Context<{ Variables: Variables }>,
  ) => {
    const mapped = mapError(error);
    const requestId = c.get("requestId") ?? env.ids.ulid();
    c.header("x-request-id", requestId);
    if (mapped.code === "rate_limited") {
      const retryAfter = Number(
        (mapped.details as { retry_after?: number } | undefined)?.retry_after ??
          300,
      );
      c.header("retry-after", String(retryAfter));
    }
    return c.json(
      {
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(mapped.details ? { details: mapped.details } : {}),
        },
      },
      mapped.status as 400,
    );
  };
  const notFoundHandler = (c: Context<{ Variables: Variables }>) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "The requested resource was not found.",
        },
      },
      404,
    );
  root.onError(errorHandler);
  root.notFound(notFoundHandler);
  // /s/* requests are forwarded to the api app with api.fetch, which is a
  // separate dispatch: without its own handlers a thrown AppError there
  // would surface as Hono's plain-text 500 instead of the error envelope.
  api.onError(errorHandler);
  api.notFound(notFoundHandler);
  root.use("*", async (c, next) => {
    c.set("requestId", env.ids.ulid());
    await next();
  });
  /* One structured line for the requests worth seeing: every 4xx/5xx and every
     request slower than a second, with the id the error envelope also carries
     so a report ("request abc123 failed") ties straight back to a log line.
     Successful fast requests stay quiet -- access-logging every 2xx is noise on
     a box one operator watches. Health probes never log. */
  root.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const path = c.req.path;
    if (path === "/healthz" || path === "/readyz") return;
    const ms = Date.now() - started;
    const status = c.res.status;
    if (status >= 400 || ms > 1000)
      console.log(
        `[onelight] ${c.req.method} ${redactBearerPath(path)} ${String(status)} ${String(ms)}ms req=${c.get("requestId") ?? "-"}`,
      );
  });

  const userWire = (user: ActorUser) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.guest ? "guest" : user.role,
    /* Same-origin path, cookie-authenticated like every app read; updatedAt
       busts the cache when the picture changes. Null means the generated
       avatar. */
    avatar_url: user.avatarKey
      ? `/api/v1/users/${user.id}/avatar?v=${String(user.updatedAt)}`
      : null,
    disabled_at: user.disabledAt,
    created_at: user.createdAt,
    totp_enabled: Boolean(user.totpVerifiedAt),
  });

  const workspaceFor = async (workspaceId: string) => {
    const rows = await env.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .all();
    const workspace = rows[0];
    if (!workspace) throw errors.notFound("Workspace was not found.");
    return workspace;
  };

  const grantFor = async (projectId: string, userId: string) => {
    const rows = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1)
      .all();
    return rows[0]?.role;
  };

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

  /* Best-effort blob delete: the row is the truth, and a blob that outlives it
     is the GC's problem, so a store error never fails the request. One helper
     so the nine delete sites cannot drift into nine spellings (one of which had
     no catch at all and would 500 the request on a store hiccup). */
  const deleteBlobQuietly = async (
    key: string | null | undefined,
  ): Promise<void> => {
    if (!key || !env.blobStore) return;
    await env.blobStore.delete(key).catch(() => undefined);
  };

  /* pdf_pages registers its first page as blob_key and lists the rest of the
     page basenames in meta.pages, relative to the blob_key's directory. Mirror
     of maintenance.ts renditionBlobKeys so the two never disagree on what a
     rendition owns. */
  const renditionOwnedKeys = (blobKey: string, metaJson: string): string[] => {
    const keys = [blobKey];
    const meta = parseJsonObject(metaJson);
    if (typeof meta.vtt_blob_key === "string") keys.push(meta.vtt_blob_key);
    if (Array.isArray(meta.pages)) {
      const normalized = blobKey.replaceAll("\\", "/");
      const directory = normalized.slice(0, normalized.lastIndexOf("/"));
      for (const page of meta.pages)
        if (typeof page === "string") keys.push(`${directory}/${page}`);
    }
    return keys;
  };

  /* Every blob key a project owns, so deleting the project can free them
     inline instead of stranding gigabytes on disk until a GC that is off by
     default eventually reconciles. Batched by project rather than per-version.
     A completeness test seeds one blob per column and asserts this returns them
     all -- the guard against the missing-column class that has bitten the GC. */
  const collectProjectBlobKeys = async (
    project: typeof projects.$inferSelect,
  ): Promise<string[]> => {
    const keys = new Set<string>();
    const add = (key: string | null | undefined): void => {
      if (key) keys.add(key);
    };
    const inProject = eq(assets.projectId, project.id);
    for (const row of await env.db
      .select({ key: assetVersions.originalBlobKey })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ blobKey: renditions.blobKey, metaJson: renditions.metaJson })
      .from(renditions)
      .innerJoin(assetVersions, eq(renditions.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      for (const key of renditionOwnedKeys(row.blobKey, row.metaJson)) add(key);
    for (const row of await env.db
      .select({ key: commentAttachments.blobKey })
      .from(commentAttachments)
      .innerJoin(comments, eq(commentAttachments.commentId, comments.id))
      .innerJoin(assetVersions, eq(comments.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ key: captionTracks.blobKey })
      .from(captionTracks)
      .innerJoin(assetVersions, eq(captionTracks.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ key: assets.thumbnailBlobKey })
      .from(assets)
      .where(and(inProject, isNotNull(assets.thumbnailBlobKey)))
      .all())
      add(row.key);
    add(project.coverBlobKey);
    for (const row of await env.db
      .select({ key: projectCoverUploads.blobKey })
      .from(projectCoverUploads)
      .where(eq(projectCoverUploads.projectId, project.id))
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ resultBlobKey: exportJobs.resultBlobKey })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.projectId, project.id),
          isNotNull(exportJobs.resultBlobKey),
        ),
      )
      .all())
      add(row.resultBlobKey);
    for (const row of await env.db
      .select({ brandJson: shares.brandJson })
      .from(shares)
      .where(and(eq(shares.projectId, project.id), isNotNull(shares.brandJson)))
      .all()) {
      if (!row.brandJson) continue;
      try {
        const brand = JSON.parse(row.brandJson) as { logo_key?: unknown };
        if (typeof brand.logo_key === "string") add(brand.logo_key);
      } catch {
        /* A malformed brand blob names no logo. */
      }
    }
    return [...keys];
  };

  const deleteProjectBlobs = async (
    project: typeof projects.$inferSelect,
  ): Promise<void> => {
    for (const key of await collectProjectBlobKeys(project))
      await deleteBlobQuietly(key);
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
      });
    }
    return facts;
  };

  const requireProject = async (
    projectId: string,
    user: ActorUser,
    minimum?: "manager" | "editor" | "commenter" | "viewer",
    options?: { allowArchived?: boolean },
  ) => {
    const rows = await env.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .all();
    const project = rows[0];
    if (!project || project.workspaceId !== user.workspaceId)
      throw errors.notFound("Project was not found.");
    const role = implicitProjectRole(
      user.role,
      Boolean(project.restricted),
      (await grantFor(project.id, user.id)) ?? undefined,
    );
    // Projects invisible to the caller (restricted without a grant, or any
    // project a guest holds no grant on) 404 rather than 403, so existence
    // does not leak.
    if (!role) throw errors.notFound("Project was not found.");
    if (
      project.status === "archived" &&
      minimum &&
      minimum !== "viewer" &&
      !options?.allowArchived
    )
      throw errors.forbidden("Archived projects are read-only.");
    if (minimum && !projectRoleAtLeast(role, minimum)) throw errors.forbidden();
    return { project, role };
  };

  /* Short random URL identity: 10 lowercase hex characters, 40 random bits.
     Random rather than derived, so addresses neither collide with names nor
     enumerate; the unique index is the arbiter and a clash just redraws. */
  const newPublicId = async (
    exists: (candidate: string) => Promise<boolean>,
  ): Promise<string> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = Array.from(randomBytes(5))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (!(await exists(candidate))) return candidate;
    }
    throw errors.internal("Could not allocate a public id.");
  };

  const newProjectPublicId = () =>
    newPublicId(
      async (candidate) =>
        (
          await env.db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.publicId, candidate))
            .limit(1)
            .all()
        ).length > 0,
    );

  const newAssetPublicId = () =>
    newPublicId(
      async (candidate) =>
        (
          await env.db
            .select({ id: assets.id })
            .from(assets)
            .where(eq(assets.publicId, candidate))
            .limit(1)
            .all()
        ).length > 0,
    );

  const newSharePublicId = () =>
    newPublicId(
      async (candidate) =>
        (
          await env.db
            .select({ id: shares.id })
            .from(shares)
            .where(eq(shares.publicId, candidate))
            .limit(1)
            .all()
        ).length > 0,
    );

  /* URL params arrive as either the canonical ULID or the short public id.
     Resolution happens ONCE, at the entity's own GET: every other endpoint
     and every mutation takes canonical ids only, so an alias can never be
     written into a row. A ULID is exactly 26 characters and a public id is
     not, so the forms cannot collide. */
  const projectParam = async (param: string): Promise<string> => {
    if (param.length === 26) return param;
    const row = (
      await env.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.publicId, param))
        .limit(1)
        .all()
    )[0];
    return row?.id ?? param;
  };

  const assetParam = async (param: string): Promise<string> => {
    if (param.length === 26) return param;
    const row = (
      await env.db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.publicId, param))
        .limit(1)
        .all()
    )[0];
    return row?.id ?? param;
  };

  const shareParam = async (param: string): Promise<string> => {
    if (param.length === 26) return param;
    const row = (
      await env.db
        .select({ id: shares.id })
        .from(shares)
        .where(eq(shares.publicId, param))
        .limit(1)
        .all()
    )[0];
    return row?.id ?? param;
  };

  const audit = async (
    workspaceId: string,
    actorUserId: string | null,
    action: string,
    target: string | null,
    meta: unknown = {},
  ) => {
    await env.db
      .insert(auditLog)
      .values({
        id: env.ids.ulid(),
        workspaceId,
        actorUserId,
        action,
        target,
        metaJson: JSON.stringify(meta),
        at: env.clock.now(),
      })
      .run();
  };

  const projectEventWaiters = new Map<string, Set<() => void>>();
  const projectEventEpoch = new Map<string, number>();

  const wakeProjectEventStreams = (projectId: string): void => {
    projectEventEpoch.set(
      projectId,
      (projectEventEpoch.get(projectId) ?? 0) + 1,
    );
    const waiters = projectEventWaiters.get(projectId);
    if (!waiters) return;
    projectEventWaiters.delete(projectId);
    for (const wake of waiters) wake();
  };

  const waitForProjectEvent = (
    projectId: string,
    observedEpoch: number,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        const waiters = projectEventWaiters.get(projectId);
        waiters?.delete(finish);
        if (waiters?.size === 0) projectEventWaiters.delete(projectId);
        resolve();
      };
      const waiters = projectEventWaiters.get(projectId) ?? new Set();
      waiters.add(finish);
      projectEventWaiters.set(projectId, waiters);
      const timeout = setTimeout(finish, 15_000);
      signal.addEventListener("abort", finish, { once: true });
      if (
        signal.aborted ||
        (projectEventEpoch.get(projectId) ?? 0) !== observedEpoch
      )
        finish();
    });

  /**
   * Append a live-update event to the project stream (SSE replay via
   * GET /projects/:id/events) and schedule webhook deliveries for it.
   *
   * Web clients subscribe by these EXACT type strings; keep this list in
   * sync with every emitter:
   *   - "project.created"        {project_id, name}
   *   - "asset.created"          {asset_id, version_id, job_id}
   *   - "asset.version_created"  {asset_id, version_id, version_no, job_id}
   *   - "comment.created"        {comment_id, version_id, frame_in, parent_id?}
   *   - "comment.updated"        {comment_id, version_id, frame_in}
   *   - "comment.deleted"        {comment_id, version_id}
   * Comment payloads stay small on purpose: ids plus version_id/frame_in;
   * clients refetch the comment list for full bodies.
   */
  const appendProjectEvent = async (
    projectId: string,
    type: string,
    data: unknown,
  ) => {
    const project = (
      await env.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all()
    )[0];
    const eventId = env.ids.ulid();
    const now = env.clock.now();
    await env.db
      .insert(projectEvents)
      .values({
        id: eventId,
        projectId,
        type,
        payloadJson: JSON.stringify(data),
        createdAt: now,
      })
      .run();
    wakeProjectEventStreams(projectId);
    if (project)
      await scheduleWebhookDeliveries(
        env.db,
        project.workspaceId,
        eventId,
        type,
        data,
        now,
      );
  };

  /** First 140 characters of a comment body for notification payloads. */
  const notificationPreview = (text: string): string =>
    text.length > 140 ? text.slice(0, 140) : text;

  const projectManagerIds = async (projectId: string): Promise<string[]> =>
    (
      await env.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.role, "manager"),
          ),
        )
        .all()
    ).map((row: { userId: string }) => row.userId);

  /**
   * Insert one notification row per recipient. The actor never notifies
   * themselves and recipients who muted the project are skipped.
   * notification_preferences.mode (instant/hourly/daily) shapes future email
   * digests only; in-app rows are always created regardless of mode.
   */
  const createNotifications = async (options: {
    projectId: string;
    actorUserId: string | null;
    recipients: Iterable<string | null | undefined>;
    kind: string;
    payload: Record<string, unknown>;
  }) => {
    const recipients = new Set<string>();
    for (const candidate of options.recipients)
      if (candidate) recipients.add(candidate);
    if (options.actorUserId) recipients.delete(options.actorUserId);
    if (!recipients.size) return;
    // Re-authorize every recipient against the project's CURRENT visibility.
    // A historical uploader who has since lost access (the project became
    // restricted, or they were removed or disabled) must never receive a row
    // carrying a content preview. Managers are already live-derived, but this
    // filter also covers them idempotently.
    const authorized = new Set(
      await visibleMentionIds(options.projectId, [...recipients]),
    );
    for (const userId of [...recipients])
      if (!authorized.has(userId)) recipients.delete(userId);
    if (!recipients.size) return;
    const prefRows = await env.db
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, [...recipients]))
      .all();
    const mutedByUser = new Map<string, string[]>(
      prefRows.map((row: typeof notificationPreferences.$inferSelect) => {
        const parsed = parseJsonValue(row.mutedProjectsJson);
        return [
          row.userId,
          Array.isArray(parsed) ? (parsed as string[]) : [],
        ] as const;
      }),
    );
    const now = env.clock.now();
    const payloadJson = JSON.stringify(options.payload);
    // One multi-row insert instead of a round trip per recipient.
    const values = [];
    for (const userId of recipients) {
      if (mutedByUser.get(userId)?.includes(options.projectId)) continue;
      values.push({
        id: env.ids.ulid(),
        userId,
        kind: options.kind,
        payloadJson,
        readAt: null,
        createdAt: now,
      });
    }
    if (values.length) await env.db.insert(notifications).values(values).run();
  };

  /** Distinct registered-user authors of a thread (parent plus replies). */
  const threadParticipantIds = async (parentId: string): Promise<string[]> => {
    const rows = await env.db
      .select({ authorUserId: comments.authorUserId })
      .from(comments)
      .where(
        and(
          or(eq(comments.id, parentId), eq(comments.parentId, parentId)),
          isNull(comments.deletedAt),
        ),
      )
      .all();
    return [
      ...new Set(
        rows
          .map((row: { authorUserId: string | null }) => row.authorUserId)
          .filter((id: string | null): id is string => Boolean(id)),
      ),
    ];
  };

  /** The owning project id of a version, for event emission. */
  const projectIdForVersion = async (
    versionId: string,
  ): Promise<string | undefined> => {
    const rows = await env.db
      .select({ projectId: assets.projectId })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all();
    return rows[0]?.projectId;
  };

  /**
   * Mentioned user ids that can actually see the project: enabled workspace
   * users for non-restricted projects; members and workspace admins for
   * restricted ones. Ids that fail the check are dropped silently (the
   * comment itself is never rejected over a bad mention).
   */
  const visibleMentionIds = async (
    projectId: string,
    candidates: string[] | undefined,
  ): Promise<string[]> => {
    const uniqueIds = [...new Set(candidates ?? [])].filter(Boolean);
    if (!uniqueIds.length) return [];
    const project = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all()
    )[0];
    if (!project) return [];
    const userRows = await env.db
      .select({ id: users.id, role: users.role, guest: users.guest })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, project.workspaceId),
          inArray(users.id, uniqueIds),
          isNull(users.disabledAt),
        ),
      )
      .all();
    /* Admins see everything; members see unrestricted projects; guests
       and restricted projects both require an explicit grant. Same rule
       as implicitProjectRole, expressed over a batch. */
    const visible = new Set(
      userRows
        .filter(
          (row: { role: string; guest: boolean }) =>
            row.role === "admin" ||
            (!project.restricted && row.role === "member" && !row.guest),
        )
        .map((row: { id: string }) => row.id),
    );
    const memberRows = await env.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          inArray(projectMembers.userId, uniqueIds),
        ),
      )
      .all();
    for (const row of memberRows as Array<{ userId: string }>)
      if (userRows.some((user: { id: string }) => user.id === row.userId))
        visible.add(row.userId);
    return [...visible];
  };

  /**
   * Copy unresolved, non-deleted top-level comments from one version to
   * another at the same frame with carried_from_comment_id provenance.
   * Shared by POST /versions/:id/carry-forward and the carry_forward flag
   * of POST /assets/:id/versions.
   */
  const copyUnresolvedComments = async (
    sourceVersionId: string,
    targetVersionId: string,
  ): Promise<string[]> => {
    const sourceComments = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, sourceVersionId),
          isNull(comments.deletedAt),
          isNull(comments.completedAt),
          isNull(comments.parentId),
        ),
      )
      .all();
    /* Already carried here once. Copying is now something a person can aim at
       any version from the version menu, so pressing it twice must not double
       the notes; provenance is what makes that answerable. A copy the reviewer
       later deleted stays deleted rather than coming back. */
    const alreadyCarried = new Set(
      (
        await env.db
          .select({ from: comments.carriedFromCommentId })
          .from(comments)
          .where(
            and(
              eq(comments.versionId, targetVersionId),
              isNotNull(comments.carriedFromCommentId),
            ),
          )
          .all()
      )
        .map((row) => row.from)
        .filter((from): from is string => from !== null),
    );
    /* Re-anchor where the host can see the pictures: frames follow the
       footage across a recut instead of the arithmetic. An unavailable or
       unconvinced matcher changes nothing. */
    let remap: ((frame: number) => number | null) | null = null;
    if (env.frameMatcher && sourceComments.length) {
      try {
        remap = await env.frameMatcher(sourceVersionId, targetVersionId);
      } catch {
        remap = null;
      }
    }
    const copied: string[] = [];
    for (const sourceComment of sourceComments as Array<
      typeof comments.$inferSelect
    >) {
      if (alreadyCarried.has(sourceComment.id)) continue;
      const id = env.ids.ulid();
      let frameIn = sourceComment.frameIn;
      let frameOut = sourceComment.frameOut;
      if (remap && frameIn !== null) {
        const moved = remap(frameIn);
        if (moved !== null && moved !== frameIn) {
          if (frameOut !== null)
            frameOut = Math.max(moved, frameOut + (moved - frameIn));
          frameIn = moved;
        }
      }
      await env.db
        .insert(comments)
        .values({
          id,
          versionId: targetVersionId,
          parentId: null,
          authorUserId: sourceComment.authorUserId,
          authorName: sourceComment.authorName,
          authorEmail: sourceComment.authorEmail,
          viewerKey: sourceComment.viewerKey,
          frameIn,
          frameOut,
          bodyText: sourceComment.bodyText,
          annotationJson: sourceComment.annotationJson,
          pinXyJson: sourceComment.pinXyJson,
          pageNo: sourceComment.pageNo,
          internal: sourceComment.internal,
          completedAt: null,
          completedBy: null,
          carriedFromCommentId: sourceComment.id,
          deletedAt: null,
          createdAt: env.clock.now(),
          editedAt: null,
        })
        .run();
      copied.push(id);
    }
    return copied;
  };

  // Any bucket older than this is definitely outside its own window (it must
  // be >= the longest window any hitRateLimit caller uses, currently the
  // 15 minute password-reset window), so deleting it opportunistically can
  // never reset a still-live counter for another key.
  const RATE_LIMIT_RETENTION_MS = 15 * 60 * 1000;

  /* A hash of a random secret nobody knows, made once at first login. When an
     email has no account we still verify the submitted password against this,
     so a missing user costs the same time as a wrong password -- otherwise the
     no-user path (which skips the deliberately slow KDF) is measurably faster
     and reveals which emails have accounts. */
  let decoyHash: Promise<string> | null = null;
  const spendVerifyBudget = async (password: string): Promise<void> => {
    decoyHash ??= env.hasher.hash(base64UrlEncode(randomBytes(24)));
    await env.hasher.verify(password, await decoyHash);
  };

  const hitRateLimit = async (key: string, limit: number, windowMs: number) => {
    const now = env.clock.now();
    // Opportunistic cleanup keeps rate_limits from growing without bound: on
    // every increment, drop rows whose window closed long enough ago that no
    // live counter can be lost. Bounded to stale rows only.
    await env.db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStart, now - RATE_LIMIT_RETENTION_MS))
      .run();
    const rows = await env.db
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, key))
      .limit(1)
      .all();
    const current = rows[0];
    if (!current || now - current.windowStart >= windowMs) {
      await env.db
        .insert(rateLimits)
        .values({ key, windowStart: now, count: 1 })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: { windowStart: now, count: 1 },
        })
        .run();
      return;
    }
    if (current.count >= limit)
      throw errors.rateLimited(
        Math.ceil((windowMs - (now - current.windowStart)) / 1000),
      );
    /* Increment in SQL, not read-modify-write: concurrent requests in one
       window would otherwise each read the same count and write count+1, losing
       updates and admitting more than `limit`. The WHERE re-checks the window
       so a row that rolled over between the read and here is not bumped as if it
       were still the old window. */
    await env.db
      .update(rateLimits)
      .set({ count: sql`${rateLimits.count} + 1` })
      .where(
        and(
          eq(rateLimits.key, key),
          eq(rateLimits.windowStart, current.windowStart),
        ),
      )
      .run();
  };

  const passwordError = () =>
    errors.validation(
      "Password must be at least 10 characters and not a common password.",
    );
  const assertPassword = (password: string) => {
    if (
      password.length < 10 ||
      [
        "password",
        "password123",
        "1234567890",
        "qwertyuiop",
        "letmein123",
      ].includes(password.toLowerCase())
    )
      throw passwordError();
  };

  const base62 = (size: number): string => {
    const alphabet =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const bytes = randomBytes(size);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join(
      "",
    );
  };

  const requireBlobStore = (): MultipartBlobStore => {
    const store = env.blobStore as MultipartBlobStore | undefined;
    if (!store || typeof store.putPart !== "function")
      throw errors.internal("Blob storage is not configured.");
    return store;
  };

  // Enforces a byte cap while streaming so chunked bodies cannot bypass
  // content-length checks; the consumer sees the 413 as a stream error.
  const limitStream = (
    source: ReadableStream<Uint8Array>,
    maxBytes: number,
  ): ReadableStream<Uint8Array> => {
    let total = 0;
    return source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBytes) controller.error(errors.payloadTooLarge());
          else controller.enqueue(chunk);
        },
      }),
    );
  };

  const uploadWire = (upload: typeof uploadSessions.$inferSelect) => ({
    id: upload.id,
    project_id: upload.projectId,
    client_filename: upload.clientFilename,
    relative_path: upload.relativePath,
    size: upload.size,
    checksum_crc32c: upload.checksumCrc32c,
    status: upload.status,
    created_at: upload.createdAt,
    completed_at: upload.completedAt,
  });

  /* A cover is put straight into an <img>, so "is this an image" means "will a
     browser draw it", not "is it pictorial". assetKind() calls EXR, DPX and TIFF
     images -- correctly, for footage -- and no browser renders any of them, so
     accepting one would set a cover that silently never appears. This list
     matches what blobContentType can actually label. */
  const isImageFilename = (filename: string): boolean =>
    ["png", "jpg", "jpeg", "webp", "gif"].includes(
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
    if (
      ["jpg", "jpeg", "png", "tif", "tiff", "webp", "exr", "dpx"].includes(
        extension ?? "",
      )
    )
      return "image";
    if (extension === "pdf") return "pdf";
    return "file";
  };

  const assetWire = (asset: typeof assets.$inferSelect) => ({
    id: asset.id,
    public_id: asset.publicId ?? asset.id,
    project_id: asset.projectId,
    folder_id: asset.folderId,
    name: asset.name,
    kind: asset.kind,
    current_version_id: asset.currentVersionId,
    status: asset.status,
    description: asset.description,
    tags: Array.isArray(parseJsonValue(asset.tagsJson))
      ? parseJsonValue(asset.tagsJson)
      : [],
    /* Whether a picture was chosen for this asset. The client builds
       /assets/:id/thumbnail?v=updated_at from it; no signed URL is needed
       because every internal surface that shows it is already authenticated. */
    has_thumbnail: Boolean(asset.thumbnailBlobKey),
    deleted_at: asset.deletedAt,
    created_at: asset.createdAt,
    updated_at: asset.updatedAt,
  });

  const versionWire = (version: typeof assetVersions.$inferSelect) => ({
    id: version.id,
    asset_id: version.assetId,
    version_no: version.versionNo,
    original_filename: version.originalFilename,
    size: version.size,
    checksum_crc32c: version.checksumCrc32c,
    uploaded_by: version.uploadedBy,
    media_info: parseJsonObject(version.mediaInfoJson),
    source_timecode_start: version.sourceTimecodeStart,
    source_start_frame: version.sourceStartFrame,
    frame_rate_num: version.frameRateNum,
    frame_rate_den: version.frameRateDen,
    drop_frame: Boolean(version.dropFrame),
    duration_frames: version.durationFrames,
    color: parseJsonObject(version.colorJson),
    transcode_status: version.transcodeStatus,
    created_at: version.createdAt,
  });

  /* The same shape as versionWire, but stripped of the two heavy JSON blobs a
     browsing card never reads. A card's Format cell needs only the video
     stream's codec and dimensions, so media_info collapses to that one stream
     summary; the full ffprobe output (every stream, format tags, bitrates --
     multiple KB per asset) and the colour-grading metadata stay in the review
     room's own version fetch. Field names and types are unchanged, so the wire
     contract and the client type are untouched. */
  const listCardVersion = (version: typeof assetVersions.$inferSelect) => {
    const full = versionWire(version);
    const info = full.media_info;
    const streams = Array.isArray(info.streams)
      ? (info.streams as Array<Record<string, unknown>>)
      : [];
    const video =
      streams.find((stream) => stream.codec_type === "video") ?? streams[0];
    return {
      ...full,
      media_info: video
        ? {
            streams: [
              {
                codec_type: video.codec_type,
                codec_name: video.codec_name,
                width: video.width,
                height: video.height,
              },
            ],
          }
        : {},
      color: {},
    };
  };

  const jobWire = (job: typeof jobs.$inferSelect) => {
    const payload = parseJsonObject(job.payloadJson);
    const summary: Record<string, unknown> = {};
    for (const key of [
      "workspace_id",
      "project_id",
      "asset_id",
      "version_id",
    ]) {
      if (payload[key] !== undefined) summary[key] = payload[key];
    }
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.maxAttempts,
      run_after: job.runAfter,
      created_at: job.createdAt,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      error: job.error,
      payload: summary,
    };
  };

  const exportWire = (job: typeof exportJobs.$inferSelect) => ({
    id: job.id,
    project_id: job.projectId,
    format: job.format,
    filters: parseJsonObject(job.filtersJson),
    timecode_base: job.timecodeBase,
    status: job.status,
    error: job.error,
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    requested_by: job.requestedBy,
  });

  const commentWire = (comment: typeof comments.$inferSelect) => ({
    id: comment.id,
    version_id: comment.versionId,
    parent_id: comment.parentId,
    author_user_id: comment.authorUserId,
    author_name: comment.authorName,
    author_email: comment.authorEmail,
    frame_in: comment.frameIn,
    frame_out: comment.frameOut,
    body_text: comment.bodyText,
    annotation: comment.annotationJson
      ? parseJsonObject(comment.annotationJson)
      : null,
    pin_xy: comment.pinXyJson ? parseJsonObject(comment.pinXyJson) : null,
    page_no: comment.pageNo,
    internal: Boolean(comment.internal),
    completed_at: comment.completedAt,
    completed_by: comment.completedBy,
    carried_from_comment_id: comment.carriedFromCommentId,
    deleted_at: comment.deletedAt,
    created_at: comment.createdAt,
    edited_at: comment.editedAt,
    // Derived from body_text on every read, never a column.
    tags: extractHashtags(comment.bodyText),
  });

  /* A comment's files, in bulk: one query for a whole thread, so listing
     comments never costs a query per row. */
  const attachmentWire = (row: typeof commentAttachments.$inferSelect) => ({
    id: row.id,
    filename: row.filename,
    size: row.size,
    content_type: row.contentType,
  });
  const attachmentsFor = async (
    commentIds: string[],
  ): Promise<Map<string, ReturnType<typeof attachmentWire>[]>> => {
    const grouped = new Map<string, ReturnType<typeof attachmentWire>[]>();
    if (!commentIds.length) return grouped;
    const rows = (await env.db
      .select()
      .from(commentAttachments)
      .where(inArray(commentAttachments.commentId, commentIds))
      .all()) as Array<typeof commentAttachments.$inferSelect>;
    for (const row of rows) {
      const list = grouped.get(row.commentId) ?? [];
      list.push(attachmentWire(row));
      grouped.set(row.commentId, list);
    }
    return grouped;
  };

  // Public (share viewer) projection of a comment: drops author_email and
  // author_user_id so external viewers never learn the registered identity
  // behind a comment. author_name is the only author field exposed.
  const publicCommentWire = (comment: typeof comments.$inferSelect) => {
    const wire: Record<string, unknown> = { ...commentWire(comment) };
    delete wire.author_user_id;
    delete wire.author_email;
    return wire;
  };

  const shareLogoUrl = (share: typeof shares.$inferSelect): string | null => {
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    return typeof brand.logo_key === "string"
      ? `/api/v1/s/${share.slug}/logo?v=${encodeURIComponent(brand.logo_key.split("/").pop() ?? "")}`
      : null;
  };

  /* The brand as clients of the wire read it: the logo travels as a URL,
     never as a blob key. */
  const brandWire = (
    share: typeof shares.$inferSelect,
  ): Record<string, unknown> | null => {
    if (!share.brandJson) return null;
    const brand = parseJsonObject(share.brandJson);
    delete brand.logo_key;
    return Object.keys(brand).length ? brand : null;
  };

  const shareWire = (share: typeof shares.$inferSelect) => ({
    id: share.id,
    public_id: share.publicId ?? share.id,
    project_id: share.projectId,
    folder_id: share.folderId,
    slug: share.slug,
    kind: share.kind,
    title: share.title,
    layout: share.layout,
    expires_at: share.expiresAt,
    allow_download: share.allowDownload,
    allow_comments: Boolean(share.allowComments),
    allow_approvals: Boolean(share.allowApprovals),
    show_all_versions: Boolean(share.showAllVersions),
    watermark_spec: share.watermarkSpecJson
      ? parseJsonObject(share.watermarkSpecJson)
      : null,
    brand: brandWire(share),
    logo_url: shareLogoUrl(share),
    created_by: share.createdBy,
    revoked_at: share.revokedAt,
    created_at: share.createdAt,
  });

  // Client-safe share projection for public (unauthenticated) share pages.
  // Unlike shareWire it never exposes passphrase_hash, watermark_spec_hash,
  // the full watermark spec, created_by, project_id, or camelCase drizzle
  // keys: watermarking is reported only as a boolean presence flag.
  const publicShareWire = (share: typeof shares.$inferSelect) => ({
    id: share.id,
    slug: share.slug,
    kind: share.kind,
    title: share.title,
    layout: share.layout,
    allow_download: share.allowDownload,
    allow_comments: Boolean(share.allowComments),
    allow_approvals: Boolean(share.allowApprovals),
    show_all_versions: Boolean(share.showAllVersions),
    expires_at: share.expiresAt,
    revoked_at: share.revokedAt,
    watermark: shareIsWatermarked(share),
    brand: brandWire(share),
    logo_url: shareLogoUrl(share),
  });

  // Share viewers expose only their display identity; the signed viewer_key
  // never leaves the server.
  const publicViewerWire = (viewer: typeof shareViewers.$inferSelect) => ({
    id: viewer.id,
    name: viewer.name,
    email: viewer.email,
  });

  const currentWorkspace = async (c: { get: (key: "user") => ActorUser }) =>
    workspaceFor(c.get("user").workspaceId);

  /* Liveness: the process is up and serving. Readiness: it can also reach the
     database, which liveness deliberately does not check -- an orchestrator
     holds traffic off a replica whose DB is unreachable (locked, disk full)
     without killing it, since the process itself is fine. */
  api.get("/healthz", (c) => c.json({ status: "ok", version: env.version }));
  api.get("/readyz", async (c) => {
    try {
      await env.db.run(sql`select 1`);
      return c.json({ status: "ready", version: env.version });
    } catch {
      return c.json({ status: "not_ready" }, 503);
    }
  });

  // Public pre-auth bootstrap for the web shell: exactly these three fields
  // and nothing else (no ids, no emails, no settings), so nothing leaks
  // beyond what the login and setup pages need.
  api.get("/bootstrap", async (c) => {
    const existingUsers = await env.db
      .select({ id: users.id })
      .from(users)
      .limit(1)
      .all();
    const setupRequired = existingUsers.length === 0;
    const workspace = setupRequired
      ? undefined
      : (
          await env.db
            .select({ name: workspaces.name })
            .from(workspaces)
            .limit(1)
            .all()
        )[0];
    return c.json({
      oidc_enabled: Boolean(
        env.config.OIDC_ISSUER &&
        env.config.OIDC_CLIENT_ID &&
        env.config.OIDC_CLIENT_SECRET,
      ),
      setup_required: setupRequired,
      workspace_name: workspace?.name ?? null,
    });
  });

  api.post("/setup", async (c) => {
    const existing = await env.db
      .select({ id: users.id })
      .from(users)
      .limit(1)
      .all();
    if (existing.length) throw errors.notFound("Setup is already complete.");
    const body = await jsonBody(c, bodies.setup);
    assertPassword(body.password);
    const now = env.clock.now();
    const workspaceId = env.ids.ulid();
    const userId = env.ids.ulid();
    await env.db
      .insert(workspaces)
      .values({
        id: workspaceId,
        name: body.workspace_name,
        settingsJson: "{}",
        createdAt: now,
      })
      .run();
    await env.db
      .insert(users)
      .values({
        id: userId,
        workspaceId,
        email: body.email.trim().toLowerCase(),
        name: body.name.trim(),
        role: "admin",
        passwordHash: await env.hasher.hash(body.password),
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await audit(
      workspaceId,
      userId,
      "setup.complete",
      `workspace:${workspaceId}`,
    );
    const created = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .all()
    )[0];
    if (!created) throw errors.internal();
    c.set("user", created);
    c.set("authType", "session");
    await createSession(env, userId, c);
    return c.json({ user: userWire(created) }, 201);
  });

  api.post("/auth/login", async (c) => {
    const body = await jsonBody(c, bodies.login);
    const ip = clientIp(c, env);
    await hitRateLimit(
      `login:email:${body.email.toLowerCase()}`,
      10,
      5 * 60 * 1000,
    );
    await hitRateLimit(`login:ip:${ip}`, 10, 5 * 60 * 1000);
    const rows = await env.db
      .select()
      .from(users)
      .where(eq(users.email, body.email.trim().toLowerCase()))
      .limit(1)
      .all();
    const user = rows[0];
    if (!user || user.disabledAt || !user.passwordHash) {
      /* Spend the same KDF time a real verify would, so a missing or disabled
         account is not faster to probe than a wrong password. */
      await spendVerifyBudget(body.password);
      throw errors.invalidCredentials();
    }
    if (!(await env.hasher.verify(body.password, user.passwordHash))) {
      await audit(
        user.workspaceId,
        user.id,
        "user.login_failed",
        `user:${user.id}`,
      );
      throw errors.invalidCredentials();
    }
    /* A correct password made under an older iteration count is re-hashed to
       the current floor here, transparently, so the store drifts upward as
       people sign in rather than staying at whatever it was provisioned with. */
    if (env.hasher.needsRehash(user.passwordHash)) {
      const upgraded = await env.hasher.hash(body.password);
      await env.db
        .update(users)
        .set({ passwordHash: upgraded })
        .where(eq(users.id, user.id))
        .run();
    }
    /* With TOTP verified, the password alone gets a five-minute, single
       purpose challenge token, never a session. The token proves the first
       factor to the /auth/login/totp step and nothing else. */
    if (user.totpVerifiedAt && user.totpSecret) {
      const mfaToken = await new SignJWT({ purpose: "mfa" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.id)
        .setExpirationTime("5m")
        .setIssuedAt()
        .sign(utf8(env.config.SECRET_KEY));
      return c.json({ mfa_required: true, mfa_token: mfaToken });
    }
    await createSession(env, user.id, c);
    c.set("user", user);
    c.set("authType", "session");
    await audit(user.workspaceId, user.id, "user.login", `user:${user.id}`);
    return c.json({ user: userWire(user) });
  });

  /* The second factor. Backup codes are accepted in place of a TOTP code
     and burn on use. */
  api.post("/auth/login/totp", async (c) => {
    const body = await jsonBody(c, bodies.loginTotp);
    const ip = clientIp(c, env);
    await hitRateLimit(`login_totp:ip:${ip}`, 10, 5 * 60 * 1000);
    let subject: string;
    try {
      const { payload } = await jwtVerify(
        body.mfa_token,
        utf8(env.config.SECRET_KEY),
      );
      if (payload.purpose !== "mfa" || typeof payload.sub !== "string")
        throw errors.invalidCredentials();
      subject = payload.sub;
    } catch {
      throw errors.invalidCredentials();
    }
    await hitRateLimit(`login_totp:user:${subject}`, 10, 5 * 60 * 1000);
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, subject))
        .limit(1)
        .all()
    )[0];
    if (!user || user.disabledAt || !user.totpSecret || !user.totpVerifiedAt)
      throw errors.invalidCredentials();
    const code = body.code.trim();
    let passed = await verifyTotp(user.totpSecret, code, env.clock.now());
    if (!passed && /^[A-Za-z2-7]{10}$/.test(code)) {
      const hashed = await sha256Hex(code.toUpperCase());
      const stored = JSON.parse(user.totpBackupCodesJson) as string[];
      if (stored.includes(hashed)) {
        passed = true;
        await env.db
          .update(users)
          .set({
            totpBackupCodesJson: JSON.stringify(
              stored.filter((entry) => entry !== hashed),
            ),
          })
          .where(eq(users.id, user.id))
          .run();
      }
    }
    if (!passed) {
      await audit(
        user.workspaceId,
        user.id,
        "user.login_totp_failed",
        `user:${user.id}`,
      );
      throw errors.invalidCredentials();
    }
    await createSession(env, user.id, c);
    c.set("user", user);
    c.set("authType", "session");
    await audit(user.workspaceId, user.id, "user.login", `user:${user.id}`);
    return c.json({ user: userWire(user) });
  });

  api.post("/auth/logout", requireAuth, async (c) => {
    const user = userFromContext(c);
    const token = getCookie(c, SESSION_COOKIE);
    if (token)
      await env.db
        .delete(sessions)
        .where(eq(sessions.tokenHash, await sha256Hex(token)))
        .run();
    clearSessionCookie(c);
    await audit(user.workspaceId, user.id, "user.logout", `user:${user.id}`);
    return c.body(null, 204);
  });

  // Password reset request. ALWAYS 204: whether the email exists, is
  // disabled, or has no password must be indistinguishable to the caller
  // (no account enumeration). Rate limited like login: per email and per IP.
  api.post("/auth/reset-request", async (c) => {
    const body = await jsonBody(c, bodies.resetRequest);
    const email = body.email.trim().toLowerCase();
    const ip = clientIp(c, env);
    await hitRateLimit(`pwreset:email:${email}`, 5, 15 * 60 * 1000);
    await hitRateLimit(`pwreset:ip:${ip}`, 5, 15 * 60 * 1000);
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .all()
    )[0];
    if (user && !user.disabledAt) {
      const token = base64UrlEncode(randomBytes(32));
      const now = env.clock.now();
      await env.db
        .insert(passwordResets)
        .values({
          id: env.ids.ulid(),
          userId: user.id,
          tokenHash: await sha256Hex(token),
          createdAt: now,
          expiresAt: now + 60 * 60 * 1000,
          usedAt: null,
        })
        .run();
      if (mailControl && (await mailStatus()).state === "ready") {
        await mailControl.send({
          to: user.email,
          subject: "Reset your Onelight password",
          text: [
            `A password reset was requested for ${user.email}.`,
            "",
            "Reset your password within the next hour:",
            `${env.config.PUBLIC_URL.replace(/\/$/, "")}/reset/${token}`,
            "",
            "If you did not request this, you can ignore this message.",
          ].join("\n"),
        });
        await audit(
          user.workspaceId,
          user.id,
          "password_reset.request",
          `user:${user.id}`,
        );
      } else {
        // No mailer is configured: the token row exists but nothing was
        // delivered. Record that so operators can see why resets stall.
        await audit(
          user.workspaceId,
          user.id,
          "password_reset.request",
          `user:${user.id}`,
          { mail: "unconfigured" },
        );
      }
    }
    return c.body(null, 204);
  });

  api.post("/auth/reset", async (c) => {
    const body = await jsonBody(c, bodies.resetComplete);
    const reset = (
      await env.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, await sha256Hex(body.token)))
        .limit(1)
        .all()
    )[0];
    const now = env.clock.now();
    if (!reset || reset.usedAt || reset.expiresAt <= now)
      throw errors.validation("Reset token is invalid or has expired.");
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, reset.userId))
        .limit(1)
        .all()
    )[0];
    if (!user || user.disabledAt)
      throw errors.validation("Reset token is invalid or has expired.");
    // Password policy runs after token validation but BEFORE the token is
    // consumed, so a weak password does not burn the link.
    assertPassword(body.password);
    await env.db
      .update(users)
      .set({
        passwordHash: await env.hasher.hash(body.password),
        updatedAt: now,
      })
      .where(eq(users.id, user.id))
      .run();
    await env.db
      .update(passwordResets)
      .set({ usedAt: now })
      .where(eq(passwordResets.id, reset.id))
      .run();
    // Every session dies: a reset is the recovery path from a compromised
    // credential, so nothing issued under the old password survives.
    await env.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
    await audit(
      user.workspaceId,
      user.id,
      "password_reset.complete",
      `user:${user.id}`,
    );
    return c.body(null, 204);
  });

  api.get("/auth/session", (c) => {
    const user = c.get("user");
    if (!user) throw errors.unauthorized();
    return c.json({ user: userWire(user), auth: c.get("authType") });
  });

  api.get("/workspace", requireAuth, async (c) => {
    const workspace = await currentWorkspace(c);
    return c.json({
      id: workspace.id,
      name: workspace.name,
      settings: parseJsonObject(workspace.settingsJson),
      oidc_enabled: Boolean(env.config.OIDC_ISSUER),
    });
  });

  // What the workspace weighs on disk, summed from the sizes the DB already
  // tracks -- no blob walk, so it answers instantly at any library size.
  // Originals include trashed assets, whose bytes stay on disk until the
  // purge sweep collects them; asset_count is live assets only.
  api.get("/workspace/usage", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const projectRows = await env.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.workspaceId, actor.workspaceId))
      .all();
    const originalRows = await env.db
      .select({
        projectId: assets.projectId,
        bytes: sql<number>`coalesce(sum(${assetVersions.size}), 0)`,
        versions: sql<number>`count(*)`,
      })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(eq(projects.workspaceId, actor.workspaceId))
      .groupBy(assets.projectId)
      .all();
    const renditionRows = await env.db
      .select({
        projectId: assets.projectId,
        bytes: sql<number>`coalesce(sum(${renditions.size}), 0)`,
      })
      .from(renditions)
      .innerJoin(assetVersions, eq(renditions.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(eq(projects.workspaceId, actor.workspaceId))
      .groupBy(assets.projectId)
      .all();
    const assetRows = await env.db
      .select({
        projectId: assets.projectId,
        count: sql<number>`count(*)`,
      })
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          isNull(assets.deletedAt),
        ),
      )
      .groupBy(assets.projectId)
      .all();
    const originalsBy = new Map(
      originalRows.map((row) => [row.projectId, row]),
    );
    const renditionsBy = new Map(
      renditionRows.map((row) => [row.projectId, row.bytes]),
    );
    const assetsBy = new Map(
      assetRows.map((row) => [row.projectId, row.count]),
    );
    const perProject = projectRows.map((project) => ({
      id: project.id,
      name: project.name,
      originals_bytes: originalsBy.get(project.id)?.bytes ?? 0,
      renditions_bytes: renditionsBy.get(project.id) ?? 0,
      asset_count: assetsBy.get(project.id) ?? 0,
      version_count: originalsBy.get(project.id)?.versions ?? 0,
    }));
    return c.json({
      totals: {
        originals_bytes: perProject.reduce(
          (sum, row) => sum + row.originals_bytes,
          0,
        ),
        renditions_bytes: perProject.reduce(
          (sum, row) => sum + row.renditions_bytes,
          0,
        ),
        asset_count: perProject.reduce((sum, row) => sum + row.asset_count, 0),
        version_count: perProject.reduce(
          (sum, row) => sum + row.version_count,
          0,
        ),
      },
      // Null on object storage, where capacity is not a meaningful number.
      disk: env.diskInfo ? await env.diskInfo() : null,
      projects: perProject,
    });
  });

  /* One admin page's worth of operational truth: version and uptime, the
     database and its snapshots, blob capacity, and every queue's depth. The
     host-only facts (db size, backups) come through env.systemInfo and are
     null where the host cannot know them (Workers). */
  api.get("/admin/system", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const countBy = <T extends string>(
      rows: Array<{ status: T; count: number }>,
    ): Record<string, number> =>
      Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const jobRows = await env.db
      .select({ status: jobs.status, count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        sql`json_extract(${jobs.payloadJson}, '$.workspace_id') = ${actor.workspaceId}`,
      )
      .groupBy(jobs.status)
      .all();
    const exportRows = await env.db
      .select({ status: exportJobs.status, count: sql<number>`count(*)` })
      .from(exportJobs)
      .where(eq(exportJobs.workspaceId, actor.workspaceId))
      .groupBy(exportJobs.status)
      .all();
    const deliveryRows = await env.db
      .select({
        status: webhookDeliveries.status,
        count: sql<number>`count(*)`,
      })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(eq(webhooks.workspaceId, actor.workspaceId))
      .groupBy(webhookDeliveries.status)
      .all();
    const host = env.systemInfo
      ? await env.systemInfo()
      : { db_size_bytes: null, backups: null };
    return c.json({
      version: env.version,
      started_at: env.startedAt ?? null,
      db_size_bytes: host.db_size_bytes,
      backups: host.backups,
      disk: env.diskInfo ? await env.diskInfo() : null,
      mail: await mailStatus(),
      media_jobs: countBy(jobRows),
      export_jobs: countBy(exportRows),
      webhook_deliveries: countBy(deliveryRows),
    });
  });

  /* A test email is the only way an operator can tell a configured
     transport from a working one without waiting for a notification to
     fail silently. It goes to the caller's own address on purpose: the
     admin pressing the button is the person watching the inbox. */
  api.post("/admin/system/test-email", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const status = await mailStatus();
    if (!mailControl || status.state !== "ready")
      throw errors.conflict(
        status.state === "error" && status.detail
          ? `Email is misconfigured: ${status.detail}`
          : "Email is not configured: set it up under Settings, or set SMTP_URL plus MAIL_FROM in the environment.",
      );
    try {
      await mailControl.send({
        to: actor.email,
        subject: "Onelight test email",
        text: [
          "This is a test email from your Onelight instance.",
          "",
          "If you are reading it, outgoing email works.",
        ].join("\n"),
      });
    } catch (caught) {
      throw errors.conflict(
        `The mail transport refused the message: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    return c.json({ sent: true, to: actor.email });
  });

  /* ---- mail settings (admin, session only): the SMTP transport, editable
     from the UI and stored in app_settings under the "mail" key. Stored
     settings take precedence over the environment; DELETE falls back to
     the environment. The password never leaves the server: projections
     carry has_pass, and a URL is masked of its credential. ---- */

  const MAIL_SETTINGS_KEY = "mail";
  const MAIL_POLICY_KEY = "mail_policy";

  /* What the instance sends when email works. Password resets are not a
     policy: a reset that silently cannot arrive is a lockout. */
  type MailPolicy = { invites: boolean; digests: boolean };
  const readMailPolicy = async (): Promise<MailPolicy> => {
    const rows = await env.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, MAIL_POLICY_KEY))
      .all();
    const row = rows[0];
    if (!row) return { invites: true, digests: true };
    try {
      const parsed = JSON.parse(row.valueJson) as Partial<MailPolicy>;
      return {
        invites: parsed.invites !== false,
        digests: parsed.digests !== false,
      };
    } catch {
      return { invites: true, digests: true };
    }
  };
  const writeMailPolicy = async (
    policy: MailPolicy,
    actorId: string,
  ): Promise<void> => {
    const now = env.clock.now();
    await env.db
      .insert(appSettings)
      .values({
        key: MAIL_POLICY_KEY,
        valueJson: JSON.stringify(policy),
        updatedAt: now,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          valueJson: JSON.stringify(policy),
          updatedAt: now,
          updatedBy: actorId,
        },
      })
      .run();
  };

  const readStoredMail = async (): Promise<StoredMailSettings | null> => {
    const rows = await env.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, MAIL_SETTINGS_KEY))
      .all();
    const row = rows[0];
    if (!row) return null;
    try {
      return JSON.parse(row.valueJson) as StoredMailSettings;
    } catch {
      return null;
    }
  };

  const maskedMailUrl = (
    raw: string,
  ): { url: string; hadCredential: boolean } => {
    try {
      const url = new URL(raw);
      const hadCredential = url.password.length > 0;
      if (hadCredential) url.password = "";
      return { url: url.toString(), hadCredential };
    } catch {
      return { url: raw, hadCredential: false };
    }
  };

  const mailSettingsWire = (stored: StoredMailSettings) => {
    const masked = stored.smtp_url ? maskedMailUrl(stored.smtp_url) : null;
    return {
      smtp_url: masked ? masked.url : null,
      host: stored.host,
      port: stored.port,
      user: stored.user,
      has_pass: Boolean(stored.pass) || Boolean(masked?.hadCredential),
      secure: stored.secure,
      mail_from: stored.mail_from,
    };
  };

  const mailSettingsResponse = async (c: Context<{ Variables: Variables }>) => {
    const stored = await readStoredMail();
    return c.json({
      stored: stored ? mailSettingsWire(stored) : null,
      active: await mailStatus(),
      policy: await readMailPolicy(),
    });
  };

  api.get("/admin/settings/mail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    return mailSettingsResponse(c);
  });

  api.put("/admin/settings/mail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    /* SMTP credentials are as sensitive as a second factor: an API token
       must not be able to redirect the instance's outgoing mail. */
    if (c.get("authType") !== "session") throw errors.forbidden();
    const body = await jsonBody(c, bodies.mailSettingsPut);
    if (body.policy) {
      const prior = await readMailPolicy();
      await writeMailPolicy(
        {
          invites: body.policy.invites ?? prior.invites,
          digests: body.policy.digests ?? prior.digests,
        },
        actor.id,
      );
      /* A policy-only PUT leaves the transport untouched. */
      if (
        body.smtp_url === undefined &&
        body.host === undefined &&
        body.mail_from === undefined &&
        body.port === undefined &&
        body.user === undefined &&
        body.pass === undefined &&
        body.secure === undefined
      ) {
        await audit(
          actor.workspaceId,
          actor.id,
          "settings.mail.update",
          "settings:mail",
        );
        return mailSettingsResponse(c);
      }
    }
    const prior = await readStoredMail();
    const next: StoredMailSettings = {
      smtp_url: body.smtp_url ?? null,
      host: body.host ?? null,
      port: body.port ?? null,
      user: body.user ?? null,
      /* An omitted password keeps the stored one, so editing the host does
         not force retyping the secret; explicit null clears it. */
      pass: body.pass === undefined ? (prior?.pass ?? null) : body.pass,
      secure: body.secure ?? null,
      mail_from: body.mail_from ?? null,
    };
    const parsed = parseSmtpConfig(mailSettingsToInput(next));
    if (parsed === null)
      throw errors.validation(
        "Provide SMTP_URL or SMTP_HOST together with MAIL_FROM; to fall back to the environment, remove the settings instead.",
      );
    if (isSmtpConfigError(parsed)) throw errors.validation(parsed.error);
    const now = env.clock.now();
    await env.db
      .insert(appSettings)
      .values({
        key: MAIL_SETTINGS_KEY,
        valueJson: JSON.stringify(next),
        updatedAt: now,
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          valueJson: JSON.stringify(next),
          updatedAt: now,
          updatedBy: actor.id,
        },
      })
      .run();
    env.mail?.reload();
    await audit(
      actor.workspaceId,
      actor.id,
      "settings.mail.update",
      "settings:mail",
    );
    return mailSettingsResponse(c);
  });

  api.delete("/admin/settings/mail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    if (c.get("authType") !== "session") throw errors.forbidden();
    await env.db
      .delete(appSettings)
      .where(eq(appSettings.key, MAIL_SETTINGS_KEY))
      .run();
    env.mail?.reload();
    await audit(
      actor.workspaceId,
      actor.id,
      "settings.mail.clear",
      "settings:mail",
    );
    return c.body(null, 204);
  });

  api.patch("/workspace", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.workspacePatch);
    if (body.settings && Object.keys(body.settings).length)
      throw errors.validation(
        "Workspace settings are not available in this phase.",
      );
    await env.db
      .update(workspaces)
      .set({ ...(body.name ? { name: body.name.trim() } : {}) })
      .where(eq(workspaces.id, user.workspaceId))
      .run();
    await audit(
      user.workspaceId,
      user.id,
      "workspace.update",
      `workspace:${user.workspaceId}`,
    );
    const workspace = await currentWorkspace(c);
    return c.json({
      id: workspace.id,
      name: workspace.name,
      settings: parseJsonObject(workspace.settingsJson),
      oidc_enabled: Boolean(env.config.OIDC_ISSUER),
    });
  });

  /* ---- avatars ---- */

  const AVATAR_TYPES: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const AVATAR_MAX_BYTES = 512 * 1024;

  /* TOTP enrolment. Beginning (or re-beginning) stores an unverified secret
     that changes nothing about login until a code proves the authenticator
     has it; verification activates the factor and hands over the backup
     codes exactly once. Session auth only: an API token must not be able to
     rotate the account's second factor. */
  api.post("/users/me/totp", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    if (user.totpVerifiedAt)
      throw errors.validation(
        "Two-factor is already on. Turn it off before re-enrolling.",
      );
    const secret = generateTotpSecret();
    await env.db
      .update(users)
      .set({ totpSecret: secret, totpVerifiedAt: null })
      .where(eq(users.id, user.id))
      .run();
    return c.json({ secret, otpauth_url: otpauthUrl(secret, user.email) }, 201);
  });

  api.post("/users/me/totp/verify", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    const body = await jsonBody(c, bodies.totpCode);
    if (!user.totpSecret || user.totpVerifiedAt)
      throw errors.validation("There is no enrolment waiting for a code.");
    if (!(await verifyTotp(user.totpSecret, body.code, env.clock.now())))
      throw errors.validation("That code does not match. Try the next one.");
    const backupCodes = generateBackupCodes();
    const hashed = await Promise.all(
      backupCodes.map((code) => sha256Hex(code)),
    );
    await env.db
      .update(users)
      .set({
        totpVerifiedAt: env.clock.now(),
        totpBackupCodesJson: JSON.stringify(hashed),
      })
      .where(eq(users.id, user.id))
      .run();
    await audit(
      user.workspaceId,
      user.id,
      "user.totp_enabled",
      `user:${user.id}`,
    );
    return c.json({ backup_codes: backupCodes });
  });

  api.delete("/users/me/totp", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    const body = await jsonBody(c, bodies.totpCode);
    if (!user.totpSecret || !user.totpVerifiedAt)
      throw errors.validation("Two-factor is not on.");
    let passed = await verifyTotp(user.totpSecret, body.code, env.clock.now());
    if (!passed && /^[A-Za-z2-7]{10}$/.test(body.code.trim())) {
      const stored = JSON.parse(user.totpBackupCodesJson) as string[];
      passed = stored.includes(await sha256Hex(body.code.trim().toUpperCase()));
    }
    if (!passed)
      throw errors.validation("Turning two-factor off needs a valid code.");
    await env.db
      .update(users)
      .set({
        totpSecret: null,
        totpVerifiedAt: null,
        totpBackupCodesJson: "[]",
      })
      .where(eq(users.id, user.id))
      .run();
    await audit(
      user.workspaceId,
      user.id,
      "user.totp_disabled",
      `user:${user.id}`,
    );
    return c.body(null, 204);
  });

  api.put("/users/me/avatar", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const contentType =
      (c.req.header("content-type") ?? "").split(";")[0] ?? "";
    const extension = AVATAR_TYPES[contentType];
    if (!extension)
      throw errors.validation("The avatar must be a PNG, JPEG, or WebP.");
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) throw errors.validation("The avatar is empty.");
    if (bytes.byteLength > AVATAR_MAX_BYTES)
      throw errors.validation("The avatar must be under 512 KB.");
    // One key per user and format; a format change strands the old blob,
    // which the GC reconciliation is for.
    const key = `avatars/${user.id}.${extension}`;
    await env.blobStore.putStream(
      key,
      new Response(bytes).body as ReadableStream,
      {
        contentType,
        size: bytes.byteLength,
      },
    );
    const now = env.clock.now();
    await env.db
      .update(users)
      .set({ avatarKey: key, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    return c.json({
      avatar_url: `/api/v1/users/${user.id}/avatar?v=${String(now)}`,
    });
  });

  api.delete("/users/me/avatar", requireAuth, async (c) => {
    const user = userFromContext(c);
    await deleteBlobQuietly(user.avatarKey);
    await env.db
      .update(users)
      .set({ avatarKey: null, updatedAt: env.clock.now() })
      .where(eq(users.id, user.id))
      .run();
    return c.body(null, 204);
  });

  api.get("/users/:id/avatar", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (!env.blobStore) throw errors.notFound();
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, c.req.param("id")),
            eq(users.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!target?.avatarKey) throw errors.notFound();
    const extension = target.avatarKey.split(".").pop() ?? "png";
    const contentType =
      Object.entries(AVATAR_TYPES).find(([, ext]) => ext === extension)?.[0] ??
      "image/png";
    let stream: ReadableStream;
    try {
      stream = await env.blobStore.getStream(target.avatarKey);
    } catch {
      /* The pointer outlived its blob (a GC sweep, a restore from a database
         backup taken after the blob was gone). Reconcile rather than serving a
         broken image forever: clearing the column makes userWire stop emitting
         an avatar_url and the initials stand in cleanly. */
      await env.db
        .update(users)
        .set({ avatarKey: null, updatedAt: env.clock.now() })
        .where(eq(users.id, target.id))
        .run();
      throw errors.notFound();
    }
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  });

  api.get("/users", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const rows = await env.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.workspaceId, user.workspaceId),
          cursor ? lt(users.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(users.id))
      .limit(limit + 1)
      .all();
    return c.json(pageResult(rows, limit, userWire));
  });

  api.get("/users/me", requireAuth, (c) =>
    c.json(userWire(userFromContext(c))),
  );

  api.patch("/users/me", requireAuth, async (c) => {
    const user = userFromContext(c);
    const body = await jsonBody(c, bodies.usersMePatch);
    const update: {
      name?: string;
      email?: string;
      passwordHash?: string;
      updatedAt: number;
    } = { updatedAt: env.clock.now() };
    if (body.name) update.name = body.name.trim();
    if (body.email) {
      /* The address is the credential's name, so changing it takes the
         credential. SSO accounts have no password and keep the address the
         identity provider asserts. */
      if (c.get("authType") !== "session") throw errors.forbidden();
      if (!user.passwordHash)
        throw errors.validation(
          "This account signs in through SSO; its address belongs to the identity provider.",
        );
      if (!(await env.hasher.verify(body.email.password, user.passwordHash)))
        throw errors.invalidCredentials();
      const nextEmail = body.email.value.trim().toLowerCase();
      if (nextEmail !== user.email) {
        const taken = (
          await env.db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.workspaceId, user.workspaceId),
                eq(users.email, nextEmail),
                ne(users.id, user.id),
              ),
            )
            .limit(1)
            .all()
        )[0];
        if (taken)
          throw errors.validation(
            "That address already belongs to another account here.",
          );
        update.email = nextEmail;
        await audit(
          user.workspaceId,
          user.id,
          "user.email_changed",
          `user:${user.id}`,
          { from: user.email, to: nextEmail },
        );
      }
    }
    if (body.password) {
      assertPassword(body.password.new);
      if (
        user.passwordHash &&
        !(await env.hasher.verify(body.password.current, user.passwordHash))
      )
        throw errors.invalidCredentials();
      update.passwordHash = await env.hasher.hash(body.password.new);
      const sessionToken = getCookie(c, SESSION_COOKIE);
      if (sessionToken)
        await env.db
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, user.id),
              ne(sessions.tokenHash, await sha256Hex(sessionToken)),
            ),
          )
          .run();
    }
    await env.db.update(users).set(update).where(eq(users.id, user.id)).run();
    const updated = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(user.workspaceId, user.id, "user.update", `user:${user.id}`);
    return c.json(userWire(updated));
  });

  /* Deactivation, self-service: the account stops signing in and its
     sessions and API tokens die, but the rows stay -- notes keep their
     author, and an admin can re-enable from Members. The last active admin
     cannot deactivate; a workspace must always have someone with the keys. */
  api.delete("/users/me", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    const body = await jsonBody(c, bodies.usersMeDelete);
    if (!user.passwordHash)
      throw errors.validation(
        "This account signs in through SSO; ask an admin to disable it.",
      );
    if (!(await env.hasher.verify(body.password, user.passwordHash)))
      throw errors.invalidCredentials();
    if (user.totpVerifiedAt && user.totpSecret) {
      const code = (body.code ?? "").trim();
      let passed = await verifyTotp(user.totpSecret, code, env.clock.now());
      if (!passed && /^[A-Za-z2-7]{10}$/.test(code)) {
        const stored = JSON.parse(user.totpBackupCodesJson) as string[];
        passed = stored.includes(await sha256Hex(code.toUpperCase()));
      }
      if (!passed)
        throw errors.validation(
          "Deactivating this account needs a two-factor code.",
        );
    }
    if (user.role === "admin") {
      const otherAdmin = (
        await env.db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.workspaceId, user.workspaceId),
              eq(users.role, "admin"),
              isNull(users.disabledAt),
              ne(users.id, user.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!otherAdmin)
        throw errors.validation(
          "You are the last active admin; the workspace needs one.",
        );
    }
    const now = env.clock.now();
    await env.db
      .update(users)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    await env.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
    await env.db.delete(apiTokens).where(eq(apiTokens.userId, user.id)).run();
    await audit(
      user.workspaceId,
      user.id,
      "user.deactivated_self",
      `user:${user.id}`,
    );
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  api.patch("/users/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.userPatch);
    const targetId = c.req.param("id");
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(eq(users.id, targetId), eq(users.workspaceId, actor.workspaceId)),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound();
    if (
      ((body.role !== undefined && body.role !== "admin") ||
        body.disabled === true) &&
      target.role === "admin"
    ) {
      const admins = await env.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.workspaceId, actor.workspaceId),
            eq(users.role, "admin"),
            isNull(users.disabledAt),
          ),
        )
        .all();
      if (admins.length <= 1)
        throw errors.conflict(
          "The last administrator cannot be demoted or disabled.",
        );
    }
    await env.db
      .update(users)
      .set({
        ...(body.role
          ? {
              role: body.role === "guest" ? ("member" as const) : body.role,
              guest: body.role === "guest",
            }
          : {}),
        ...(body.disabled === undefined
          ? {}
          : { disabledAt: body.disabled ? env.clock.now() : null }),
        updatedAt: env.clock.now(),
      })
      .where(eq(users.id, target.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, target.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      actor.workspaceId,
      actor.id,
      body.disabled ? "user.disable" : "user.update",
      `user:${target.id}`,
    );
    return c.json(userWire(updated));
  });

  api.delete("/users/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const targetId = c.req.param("id");
    if (targetId === actor.id)
      throw errors.conflict("You cannot delete your own account.");
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(eq(users.id, targetId), eq(users.workspaceId, actor.workspaceId)),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound();
    if (target.role === "admin") {
      const admins = await env.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.workspaceId, actor.workspaceId),
            eq(users.role, "admin"),
            isNull(users.disabledAt),
          ),
        )
        .all();
      if (admins.length <= 1)
        throw errors.conflict("The last administrator cannot be deleted.");
    }
    const created = await env.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.createdBy, target.id))
      .limit(1)
      .all();
    const invited = await env.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.invitedBy, target.id))
      .limit(1)
      .all();
    if (created.length || invited.length)
      throw errors.conflict(
        "This user is referenced by project or invite records. Disable the user instead.",
      );
    /* Free the avatar before the row goes: the avatar-delete route frees it,
       but user delete did not, leaking one blob per deleted user. */
    await deleteBlobQuietly(target.avatarKey);
    await env.db.delete(users).where(eq(users.id, target.id)).run();
    await audit(
      actor.workspaceId,
      actor.id,
      "user.delete",
      `user:${target.id}`,
    );
    return c.body(null, 204);
  });

  api.post("/invites", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.inviteCreate);
    const email = body.email.trim().toLowerCase();
    const existingUser = await env.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.workspaceId, actor.workspaceId), eq(users.email, email)),
      )
      .limit(1)
      .all();
    if (existingUser.length)
      throw errors.conflict("A user with that email already exists.");
    const projectGrants = body.project_grants ?? [];
    const projectsForGrant = projectGrants.length
      ? await env.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.workspaceId, actor.workspaceId))
          .all()
      : [];
    if (projectsForGrant.length !== projectGrants.length) {
      const valid = new Set(
        projectsForGrant.map((project: { id: string }) => project.id),
      );
      if (projectGrants.some((grant) => !valid.has(grant.project_id)))
        throw errors.validation(
          "Every project grant must reference a project in this workspace.",
        );
    }
    const pending = await env.db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, actor.workspaceId),
          eq(invites.email, email),
          isNull(invites.acceptedAt),
        ),
      )
      .limit(1)
      .all();
    if (pending.length)
      throw errors.conflict("An invite for that email is already pending.");
    const rawToken = `oli_${base64UrlEncode(randomBytes(24))}`;
    const now = env.clock.now();
    const inviteId = env.ids.ulid();
    await env.db
      .insert(invites)
      .values({
        id: inviteId,
        workspaceId: actor.workspaceId,
        email,
        /* Guests are stored as members plus the flag; the wire speaks the
           three-role vocabulary (see the users schema note). */
        role: body.role === "guest" ? "member" : body.role,
        guest: body.role === "guest",
        tokenHash: await sha256Hex(rawToken),
        invitedBy: actor.id,
        projectGrantsJson: JSON.stringify(projectGrants),
        createdAt: now,
        expiresAt: now + days(7),
        acceptedAt: null,
      })
      .run();
    await audit(
      actor.workspaceId,
      actor.id,
      "invite.create",
      `invite:${inviteId}`,
    );
    const acceptUrl = `${env.config.PUBLIC_URL.replace(/\/$/, "")}/invite/${rawToken}`;
    /* The invitation goes to the invitee when the transport works and the
       policy allows; the link stays in the response either way, because
       the admin may be the delivery channel. */
    let emailed = false;
    if (mailControl && (await mailStatus()).state === "ready") {
      const policy = await readMailPolicy();
      if (policy.invites) {
        const workspace = await workspaceFor(actor.workspaceId);
        try {
          await mailControl.send({
            to: email,
            subject: `${actor.name} invited you to ${workspace?.name ?? "Onelight"}`,
            text: [
              `${actor.name} invited you to review work in ${workspace?.name ?? "their workspace"} on Onelight.`,
              "",
              "Create your account here (the link works for seven days):",
              acceptUrl,
            ].join("\n"),
          });
          emailed = true;
        } catch {
          /* Undeliverable is not a failed invite: the link still works. */
        }
      }
    }
    return c.json(
      {
        invite: {
          id: inviteId,
          email,
          role: body.role,
          project_grants: projectGrants,
          invited_by: actor.id,
          created_at: now,
          expires_at: now + days(7),
        },
        accept_url: acceptUrl,
        emailed,
      },
      201,
    );
  });

  api.get("/invites", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const now = env.clock.now();
    const rows = await env.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, actor.workspaceId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
          cursor ? lt(invites.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(invites.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(rows, limit, (invite: typeof invites.$inferSelect) => ({
        id: invite.id,
        email: invite.email,
        role: invite.guest ? "guest" : invite.role,
        project_grants: JSON.parse(invite.projectGrantsJson),
        invited_by: invite.invitedBy,
        created_at: invite.createdAt,
        expires_at: invite.expiresAt,
      })),
    );
  });

  api.delete("/invites/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const invite = (
      await env.db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.id, c.req.param("id")),
            eq(invites.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!invite) throw errors.notFound();
    await env.db.delete(invites).where(eq(invites.id, invite.id)).run();
    await audit(
      actor.workspaceId,
      actor.id,
      "invite.revoke",
      `invite:${invite.id}`,
    );
    return c.body(null, 204);
  });

  const inviteByToken = async (token: string) => {
    const rows = await env.db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, await sha256Hex(token)))
      .limit(1)
      .all();
    const invite = rows[0];
    if (!invite || invite.acceptedAt || invite.expiresAt <= env.clock.now())
      throw errors.notFound("Invite is expired or no longer available.");
    return invite;
  };

  api.post("/invites/lookup", async (c) => {
    const ip = clientIp(c, env);
    await hitRateLimit(`invite_lookup:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.inviteLookup);
    const invite = await inviteByToken(body.token);
    const workspace = await workspaceFor(invite.workspaceId);
    return c.json({ email: invite.email, workspace_name: workspace.name });
  });

  api.post("/invites/accept", async (c) => {
    const ip = clientIp(c, env);
    await hitRateLimit(`invite_accept:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.inviteAccept);
    assertPassword(body.password);
    const invite = await inviteByToken(body.token);
    const existing = await env.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, invite.workspaceId),
          eq(users.email, invite.email),
        ),
      )
      .limit(1)
      .all();
    if (existing.length)
      throw errors.conflict("An account already exists for this invite email.");
    const now = env.clock.now();
    const userId = env.ids.ulid();
    await env.db
      .insert(users)
      .values({
        id: userId,
        workspaceId: invite.workspaceId,
        email: invite.email,
        name: body.name.trim(),
        role: invite.role,
        guest: invite.guest,
        passwordHash: await env.hasher.hash(body.password),
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const grants = JSON.parse(invite.projectGrantsJson) as Array<{
      project_id: string;
      role: "manager" | "editor" | "commenter" | "viewer";
    }>;
    for (const grant of grants) {
      await env.db
        .insert(projectMembers)
        .values({
          projectId: grant.project_id,
          userId,
          role: grant.role,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    await env.db
      .update(invites)
      .set({ acceptedAt: now })
      .where(eq(invites.id, invite.id))
      .run();
    await audit(
      invite.workspaceId,
      userId,
      "invite.accept",
      `invite:${invite.id}`,
    );
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .all()
    )[0];
    if (!user) throw errors.internal();
    c.set("user", user);
    c.set("authType", "session");
    await createSession(env, userId, c);
    return c.json({ user: userWire(user) }, 201);
  });

  api.get("/tokens", requireAuth, async (c) => {
    const user = userFromContext(c);
    const rows = await env.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, user.id))
      .orderBy(desc(apiTokens.id))
      .all();
    return c.json({
      items: rows.map((token: typeof apiTokens.$inferSelect) => ({
        id: token.id,
        name: token.name,
        token_prefix: token.tokenPrefix,
        created_at: token.createdAt,
        last_used_at: token.lastUsedAt,
      })),
    });
  });

  api.post("/tokens", requireAuth, async (c) => {
    const user = userFromContext(c);
    const body = await jsonBody(c, bodies.tokenCreate);
    const raw = `olt_${base62(32)}`;
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(apiTokens)
      .values({
        id,
        userId: user.id,
        name: body.name.trim(),
        tokenHash: await sha256Hex(raw),
        tokenPrefix: raw.slice(0, 12),
        createdAt: now,
        lastUsedAt: null,
      })
      .run();
    await audit(user.workspaceId, user.id, "token.create", `token:${id}`);
    return c.json(
      {
        id,
        name: body.name.trim(),
        token_prefix: raw.slice(0, 12),
        token: raw,
        created_at: now,
        last_used_at: null,
      },
      201,
    );
  });

  api.delete("/tokens/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    const token = (
      await env.db
        .select()
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.id, c.req.param("id")),
            eq(apiTokens.userId, user.id),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!token) throw errors.notFound();
    await env.db.delete(apiTokens).where(eq(apiTokens.id, token.id)).run();
    await audit(user.workspaceId, user.id, "token.revoke", `token:${token.id}`);
    return c.body(null, 204);
  });

  api.get("/projects", requireAuth, async (c) => {
    const user = userFromContext(c);
    const limit = getLimit(c.req.query("limit"));
    const status = c.req.query("status") === "archived" ? "archived" : "active";
    // Scan in batches: restricted projects invisible to the caller must not
    // consume page slots or terminate pagination early, so keep fetching
    // until the page fills or the table is exhausted.
    let cursor = cursorParam(c.req.query("cursor"));
    const items: Array<Awaited<ReturnType<typeof projectWire>>> = [];
    let nextCursor: string | null = null;
    scan: for (;;) {
      const rows = await env.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, user.workspaceId),
            eq(projects.status, status),
            cursor ? lt(projects.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(projects.id))
        .limit(limit + 1)
        .all();
      const more = rows.length > limit;
      const batch = rows.slice(0, limit);
      const facts = await projectListContext(batch, user.id);
      for (const [index, project] of batch.entries()) {
        const wire = await projectWire(
          project,
          user.id,
          user.role,
          facts.get(project.id),
        );
        if (!wire.my_role) continue;
        items.push(wire);
        if (items.length === limit) {
          if (more || index < batch.length - 1)
            nextCursor = encodeCursor(project.id);
          break scan;
        }
      }
      if (!more) break;
      cursor = batch[batch.length - 1]?.id;
    }
    return c.json({ items, next_cursor: nextCursor });
  });

  api.post("/projects", requireAuth, async (c) => {
    const user = userFromContext(c);
    /* Guests work inside what they were granted; they do not open rooms. */
    if (user.role === "guest") throw errors.forbidden();
    const body = await jsonBody(c, bodies.projectCreate);
    const existing = await env.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, user.workspaceId))
      .all();
    const palette =
      body.palette ??
      PALETTES[existing.length % PALETTES.length] ??
      PALETTES[0];
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(projects)
      .values({
        id,
        publicId: await newProjectPublicId(),
        workspaceId: user.workspaceId,
        name: body.name.trim(),
        status: "active",
        palette,
        restricted: body.restricted,
        settingsJson: "{}",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await env.db
      .insert(projectMembers)
      .values({
        projectId: id,
        userId: user.id,
        role: "manager",
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    const project = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.internal();
    await appendProjectEvent(id, "project.created", {
      project_id: id,
      name: project.name,
    });
    await audit(user.workspaceId, user.id, "project.create", `project:${id}`);
    return c.json(await projectWire(project, user.id, user.role), 201);
  });

  api.get("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    const { project } = await requireProject(
      await projectParam(c.req.param("id")),
      user,
      "viewer",
    );
    return c.json(await projectWire(project, user.id, user.role));
  });

  /* A connection carrying Last-Event-ID is catching up and gets everything it
     missed. A connection without one is a new subscriber that has just loaded
     its state over REST, and replaying the log to it re-announces every asset
     ever created as though it were news. That is how a trashed asset climbed
     back into the browser's list on every page load: the original
     asset.created replayed, and the client added the row back.

     So a first connection is handed a cursor and nothing else: the id of the
     newest event, which the browser stores and echoes back as Last-Event-ID
     when the stream reconnects, putting it on the catch-up path above with
     nothing missed in between. The cursor is an event type no client
     subscribes to, since its only job is to seed that buffer. "0" sorts below
     every ULID, so a project with no events yet still receives what comes
     next rather than being pinned to an id that never arrives. */
  api.get("/projects/:id/events", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "viewer");
    const lastEventId = c.req.header("last-event-id");
    const eventsAfter = (cursor: string) =>
      env.db
        .select()
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, projectId),
            gt(projectEvents.id, cursor),
          ),
        )
        .orderBy(asc(projectEvents.id))
        .limit(500)
        .all();
    const rows = lastEventId ? await eventsAfter(lastEventId) : [];
    const cursor = lastEventId
      ? null
      : ((
          await env.db
            .select({ id: projectEvents.id })
            .from(projectEvents)
            .where(eq(projectEvents.projectId, projectId))
            .orderBy(desc(projectEvents.id))
            .limit(1)
            .all()
        )[0]?.id ?? "0");
    const live = c.req.header("accept")?.includes("text/event-stream") ?? false;
    return streamSSE(c, async (stream) => {
      let sentCursor = lastEventId ?? cursor ?? "0";
      if (cursor !== null)
        await stream.writeSSE({
          id: cursor,
          event: "stream.cursor",
          data: "{}",
        });
      for (const event of rows) {
        await stream.writeSSE({
          id: event.id,
          event: event.type,
          data: event.payloadJson,
        });
        sentCursor = event.id;
      }
      if (!live) return;
      while (!stream.closed && !c.req.raw.signal.aborted) {
        const observedEpoch = projectEventEpoch.get(projectId) ?? 0;
        const nextRows = await eventsAfter(sentCursor);
        for (const event of nextRows) {
          await stream.writeSSE({
            id: event.id,
            event: event.type,
            data: event.payloadJson,
          });
          sentCursor = event.id;
        }
        if (nextRows.length === 500) continue;
        await stream.write(": keepalive\n\n");
        await waitForProjectEvent(projectId, observedEpoch, c.req.raw.signal);
      }
    });
  });

  api.patch("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    // allowArchived: the read-only rule applies to project content, not the
    // project record itself; without it an archived project could never be
    // unarchived.
    const { project } = await requireProject(
      c.req.param("id"),
      user,
      "manager",
      {
        allowArchived: true,
      },
    );
    const body = await jsonBody(c, bodies.projectPatch);
    if (body.cover_asset_id && body.cover_upload_id)
      throw errors.validation(
        "A project has one cover: set cover_asset_id or cover_upload_id, not both.",
      );
    let coverUpload: typeof projectCoverUploads.$inferSelect | undefined;
    if (body.cover_upload_id) {
      coverUpload = (
        await env.db
          .select()
          .from(projectCoverUploads)
          .where(
            and(
              eq(projectCoverUploads.id, body.cover_upload_id),
              eq(projectCoverUploads.projectId, project.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!coverUpload)
        throw errors.validation(
          "cover_upload_id must name a picture uploaded to this project.",
        );
    }
    if (body.cover_asset_id) {
      // Validated here rather than trusted: the wire read filters a bad cover
      // out silently, which would turn a typo into a cover that never appears
      // and never explains itself.
      const cover = (
        await env.db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.id, body.cover_asset_id),
              eq(assets.projectId, project.id),
              isNull(assets.deletedAt),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!cover)
        throw errors.validation(
          "cover_asset_id must name an asset in this project.",
        );
    }
    await env.db
      .update(projects)
      .set({
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.palette ? { palette: body.palette } : {}),
        // The kinds of cover are alternatives, so setting one clears the
        // others; without this, clearing a picked asset would silently fall
        // back to an upload chosen weeks ago.
        ...(body.cover_asset_id === undefined
          ? {}
          : { coverAssetId: body.cover_asset_id, coverBlobKey: null }),
        ...(coverUpload
          ? { coverBlobKey: coverUpload.blobKey, coverAssetId: null }
          : {}),
        ...(body.restricted === undefined
          ? {}
          : { restricted: body.restricted }),
        ...(body.status ? { status: body.status } : {}),
        /* Merged into whatever else the settings blob holds rather than
           replacing it: this is one switch among however many the project
           grows, and a write that clobbered its neighbours would be a bug
           waiting for the second setting to exist. */
        ...(body.record_transfer_ips === undefined
          ? {}
          : {
              settingsJson: JSON.stringify({
                ...parseJsonObject(project.settingsJson),
                record_transfer_ips: body.record_transfer_ips,
              }),
            }),
        updatedAt: env.clock.now(),
      })
      .where(eq(projects.id, project.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, project.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      user.workspaceId,
      user.id,
      body.status === "archived" ? "project.archive" : "project.update",
      `project:${project.id}`,
    );
    return c.json(await projectWire(updated, user.id, user.role));
  });

  /* Set an uploaded picture as the project's cover.
     Deliberately not an asset: a cover is not a deliverable, nobody filed it in
     the project, and it should not appear in the file list, in search, or in a
     share. It also skips the transcode entirely -- the poster pipeline exists to
     make a still out of footage, and this is already a still. */
  api.post("/projects/:id/cover", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "manager",
    );
    const body = await jsonBody(c, bodies.projectCoverPut);
    const upload = await findUpload(body.upload_id, actor);
    if (upload.projectId !== project.id || upload.status !== "completed")
      throw errors.validation("Upload must be completed for this project.");
    if (!isImageFilename(upload.clientFilename))
      throw errors.validation("A cover must be an image.");
    const now = env.clock.now();
    /* Shelve it as well as use it: an uploaded picture stays an option after
       something else is chosen, instead of having to be uploaded again. The
       unique index makes re-uploading the same blob a no-op rather than a
       duplicate option. */
    await env.db
      .insert(projectCoverUploads)
      .values({
        id: env.ids.ulid(),
        projectId: project.id,
        blobKey: upload.blobKey,
        filename: upload.clientFilename,
        createdBy: actor.id,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    await env.db
      .update(projects)
      .set({
        coverBlobKey: upload.blobKey,
        coverAssetId: null,
        updatedAt: now,
      })
      .where(eq(projects.id, project.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, project.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      actor.workspaceId,
      actor.id,
      "project.update",
      `project:${project.id}`,
    );
    return c.json(await projectWire(updated, actor.id, actor.role));
  });

  /* The pictures uploaded for this project, current one included. */
  api.get("/projects/:id/covers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "viewer",
    );
    const rows = await env.db
      .select()
      .from(projectCoverUploads)
      .where(eq(projectCoverUploads.projectId, project.id))
      .orderBy(desc(projectCoverUploads.id))
      .all();
    return c.json({
      items: await Promise.all(
        rows.map(async (row: typeof projectCoverUploads.$inferSelect) => ({
          id: row.id,
          filename: row.filename,
          url: await privateMediaUrl({ projectId: project.id }, row.blobKey),
          current: row.blobKey === project.coverBlobKey,
          created_at: row.createdAt,
        })),
      ),
    });
  });

  /* Forget an uploaded picture. If it is the cover in force, the project falls
     back to its generated one rather than keeping a cover whose file is about
     to be swept. */
  api.delete("/projects/:id/covers/:uploadId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "manager",
    );
    const row = (
      await env.db
        .select()
        .from(projectCoverUploads)
        .where(
          and(
            eq(projectCoverUploads.id, c.req.param("uploadId")),
            eq(projectCoverUploads.projectId, project.id),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!row) throw errors.notFound("That cover was not found.");
    await env.db
      .delete(projectCoverUploads)
      .where(eq(projectCoverUploads.id, row.id))
      .run();
    if (project.coverBlobKey === row.blobKey)
      await env.db
        .update(projects)
        .set({ coverBlobKey: null, updatedAt: env.clock.now() })
        .where(eq(projects.id, project.id))
        .run();
    return c.body(null, 204);
  });

  api.delete("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const project = (
      await env.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, c.req.param("id")),
            eq(projects.workspaceId, user.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.notFound();
    /* Free the project's blobs before the row cascade removes the columns that
       name them. The FK cascade deletes the rows; nothing deletes the objects,
       so without this a project delete stranded every original, proxy, poster,
       sprite, cover and logo on disk until a GC that is off by default caught
       up. Deletes are best-effort; the GC remains the backstop for any miss. */
    await deleteProjectBlobs(project);
    await env.db.delete(projects).where(eq(projects.id, project.id)).run();
    await audit(
      user.workspaceId,
      user.id,
      "project.delete",
      `project:${project.id}`,
    );
    return c.body(null, 204);
  });

  api.get("/projects/:id/members", requireAuth, async (c) => {
    const user = userFromContext(c);
    await requireProject(c.req.param("id"), user, "viewer");
    const rows = await env.db
      .select({ user: users, member: projectMembers })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, c.req.param("id")))
      .all();
    return c.json({
      items: rows.map(
        (row: {
          user: ActorUser;
          member: typeof projectMembers.$inferSelect;
        }) => ({ user: userWire(row.user), role: row.member.role }),
      ),
    });
  });

  api.put("/projects/:id/members/:userId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.memberPut);
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, c.req.param("userId")),
            eq(users.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound("User was not found.");
    const existing = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, c.req.param("id")),
          eq(projectMembers.userId, target.id),
        ),
      )
      .limit(1)
      .all();
    /* Demoting the current manager: guard atomically inside the UPDATE (see the
       member-remove path) so two concurrent demotes cannot both pass a separate
       count check and strip the project of every manager. A workspace admin
       bypasses it. Any other transition (a plain add, or a promotion) takes the
       normal upsert. */
    const guardDemote =
      existing[0]?.role === "manager" &&
      body.role !== "manager" &&
      actor.role !== "admin";
    if (guardDemote) {
      await env.db
        .update(projectMembers)
        .set({ role: body.role })
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.userId, target.id),
            sql`(select count(*) from ${projectMembers} where ${projectMembers.projectId} = ${c.req.param("id")} and ${projectMembers.role} = 'manager') > 1`,
          ),
        )
        .run();
      const stillManager = await env.db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.userId, target.id),
          ),
        )
        .limit(1)
        .all();
      if (stillManager[0]?.role === "manager")
        throw errors.conflict("The last project manager cannot be demoted.");
    } else {
      await env.db
        .insert(projectMembers)
        .values({
          projectId: c.req.param("id"),
          userId: target.id,
          role: body.role,
          createdAt: env.clock.now(),
        })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: { role: body.role },
        })
        .run();
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "project.member_set",
      `project:${c.req.param("id")}`,
      { user_id: target.id, role: body.role },
    );
    return c.json({ user: userWire(target), role: body.role });
  });

  api.delete("/projects/:id/members/:userId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "manager");
    const existing = (
      await env.db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.userId, c.req.param("userId")),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!existing) throw errors.notFound();
    /* The last-manager guard lives inside the DELETE, not in a separate SELECT
       before it: SQLite serializes writes and re-evaluates the correlated count
       per statement, so two concurrent removals of the two remaining managers
       cannot both pass a check-then-act and leave the project with zero. A
       workspace admin bypasses the guard. */
    const guardManager = existing.role === "manager" && actor.role !== "admin";
    await env.db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, existing.projectId),
          eq(projectMembers.userId, existing.userId),
          guardManager
            ? sql`(select count(*) from ${projectMembers} where ${projectMembers.projectId} = ${existing.projectId} and ${projectMembers.role} = 'manager') > 1`
            : undefined,
        ),
      )
      .run();
    if (guardManager) {
      const survivor = await env.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, existing.projectId),
            eq(projectMembers.userId, existing.userId),
          ),
        )
        .limit(1)
        .all();
      // The guard blocked the delete: the row is still there, so this was the
      // last manager.
      if (survivor.length)
        throw errors.conflict("The last project manager cannot be removed.");
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "project.member_remove",
      `project:${existing.projectId}`,
      { user_id: existing.userId },
    );
    return c.body(null, 204);
  });

  const folderDepth = async (
    projectId: string,
    parentId: string | null,
  ): Promise<number> => {
    let depth = 1;
    let current = parentId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current))
        throw errors.validation("Folder parent cycle detected.");
      seen.add(current);
      const parent = (
        await env.db
          .select()
          .from(folders)
          .where(eq(folders.id, current))
          .limit(1)
          .all()
      )[0];
      if (!parent || parent.projectId !== projectId)
        throw errors.validation(
          "Folder parent must belong to the same project.",
        );
      depth += 1;
      current = parent.parentId;
      if (depth > 10)
        throw errors.validation("Folder depth cannot exceed 10 levels.");
    }
    return depth;
  };

  /**
   * Height of a folder's subtree (the folder itself counts 1). Moves must
   * respect the depth cap for the DEEPEST descendant, not just the moved
   * node; capped at the limit since anything deeper already fails.
   */
  const folderSubtreeHeight = async (folderId: string): Promise<number> => {
    let height = 1;
    let frontier = [folderId];
    while (frontier.length) {
      const children = await env.db
        .select({ id: folders.id })
        .from(folders)
        .where(inArray(folders.parentId, frontier))
        .all();
      if (!children.length) break;
      height += 1;
      if (height > 10) break;
      frontier = children.map((child: { id: string }) => child.id);
    }
    return height;
  };

  api.get("/projects/:id/folders", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "viewer");
    const parent = c.req.query("parent_id") ?? null;
    // Two trees share this table; a caller asking for one must never be handed
    // rows from the other.
    const kind = c.req.query("kind") === "shares" ? "shares" : "assets";
    const rows = await env.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.projectId, c.req.param("id")),
          eq(folders.kind, kind),
          parent ? eq(folders.parentId, parent) : isNull(folders.parentId),
        ),
      )
      .orderBy(asc(folders.name))
      .all();
    return c.json({
      items: rows.map((folder: typeof folders.$inferSelect) => ({
        id: folder.id,
        project_id: folder.projectId,
        parent_id: folder.parentId,
        kind: folder.kind,
        name: folder.name,
        created_at: folder.createdAt,
      })),
    });
  });

  api.post("/projects/:id/folders", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.folderCreate);
    await folderDepth(c.req.param("id"), body.parent_id ?? null);
    // A child inherits its parent's tree: nothing may straddle the two, and a
    // caller should not have to restate what the parent already decides.
    const parentKind = body.parent_id
      ? (
          await env.db
            .select({ kind: folders.kind })
            .from(folders)
            .where(eq(folders.id, body.parent_id))
            .limit(1)
            .all()
        )[0]?.kind
      : undefined;
    const kind = parentKind ?? body.kind ?? "assets";
    const now = env.clock.now();
    const id = env.ids.ulid();
    try {
      await env.db
        .insert(folders)
        .values({
          id,
          projectId: c.req.param("id"),
          parentId: body.parent_id ?? null,
          kind,
          name: body.name.trim(),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw errors.conflict(
          "A sibling folder with that name already exists.",
        );
      throw error;
    }
    await audit(actor.workspaceId, actor.id, "folder.create", `folder:${id}`);
    return c.json(
      {
        id,
        project_id: c.req.param("id"),
        parent_id: body.parent_id ?? null,
        kind,
        name: body.name.trim(),
        created_at: now,
      },
      201,
    );
  });

  api.patch("/folders/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const folder = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!folder) throw errors.notFound();
    await requireProject(folder.projectId, actor, "editor");
    const body = await jsonBody(c, bodies.folderPatch);
    const parentId =
      body.parent_id === undefined ? folder.parentId : body.parent_id;
    if (parentId === folder.id)
      throw errors.validation("A folder cannot be its own parent.");
    if (parentId) {
      const parent = (
        await env.db
          .select({ kind: folders.kind })
          .from(folders)
          .where(eq(folders.id, parentId))
          .limit(1)
          .all()
      )[0];
      if (!parent)
        throw errors.validation("That parent folder does not exist.");
      // Moving a share folder into the asset tree would put shares somewhere
      // only assets are read from: they would simply vanish from the rail.
      if (parent.kind !== folder.kind)
        throw errors.validation(
          "A folder cannot be moved into the other tree.",
        );
    }
    const newDepth = await folderDepth(folder.projectId, parentId ?? null);
    // The cap applies to the deepest DESCENDANT after the move, not just
    // the moved folder itself.
    if (newDepth + (await folderSubtreeHeight(folder.id)) - 1 > 10)
      throw errors.validation("Folder depth cannot exceed 10 levels.");
    let current = parentId;
    while (current) {
      if (current === folder.id)
        throw errors.validation(
          "A folder cannot be moved into its own subtree.",
        );
      const parent = (
        await env.db
          .select({ parentId: folders.parentId })
          .from(folders)
          .where(eq(folders.id, current))
          .limit(1)
          .all()
      )[0];
      current = parent?.parentId ?? null;
    }
    try {
      await env.db
        .update(folders)
        .set({
          ...(body.name ? { name: body.name.trim() } : {}),
          parentId: parentId ?? null,
          updatedAt: env.clock.now(),
        })
        .where(eq(folders.id, folder.id))
        .run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw errors.conflict(
          "A sibling folder with that name already exists.",
        );
      throw error;
    }
    const updated = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, folder.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      actor.workspaceId,
      actor.id,
      body.parent_id === undefined ? "folder.rename" : "folder.move",
      `folder:${folder.id}`,
    );
    return c.json({
      id: updated.id,
      project_id: updated.projectId,
      parent_id: updated.parentId,
      kind: updated.kind,
      name: updated.name,
      created_at: updated.createdAt,
    });
  });

  api.delete("/folders/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const folder = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!folder) throw errors.notFound();
    await requireProject(folder.projectId, actor, "editor");
    await env.db.delete(folders).where(eq(folders.id, folder.id)).run();
    await audit(
      actor.workspaceId,
      actor.id,
      "folder.delete",
      `folder:${folder.id}`,
    );
    return c.body(null, 204);
  });

  const versionForActor = async (
    id: string,
    actor: ActorUser,
    minimum: "viewer" | "commenter" | "editor" | "manager" = "viewer",
  ) => {
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, id))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound("Version was not found.");
    await assetForActor(version.assetId, actor, minimum);
    return version;
  };

  const validateCommentAnchor = (body: {
    frame_in?: number | undefined;
    frame_out?: number | undefined;
    annotation?: unknown;
  }) => {
    if (body.frame_in !== undefined && body.frame_in < 0)
      throw errors.validation("Frame anchors must be non-negative.");
    if (
      body.frame_out !== undefined &&
      body.frame_in !== undefined &&
      body.frame_out < body.frame_in
    )
      throw errors.validation(
        "frame_out must be greater than or equal to frame_in.",
      );
    if (
      body.annotation !== undefined &&
      JSON.stringify(body.annotation).length > 262_144
    )
      throw errors.validation("Annotation payload is too large.");
  };

  api.get("/versions/:id/comments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor);
    const limit = getLimit(c.req.query("limit"));
    const cursor = commentCursorParam(c.req.query("cursor"));
    // Composite keyset over (COALESCE(frame_in, -1) ASC, id DESC): a plain id
    // cursor would drop or duplicate rows across pages under this ordering.
    const frameKey = sql<number>`coalesce(${comments.frameIn}, -1)`;
    const rows = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, version.id),
          isNull(comments.deletedAt),
          cursor
            ? or(
                gt(frameKey, cursor.f),
                and(eq(frameKey, cursor.f), lt(comments.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(frameKey), desc(comments.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const attached = await attachmentsFor(
      page.map((comment: typeof comments.$inferSelect) => comment.id),
    );
    return c.json({
      items: page.map((comment: typeof comments.$inferSelect) => ({
        ...commentWire(comment),
        attachments: attached.get(comment.id) ?? [],
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCommentCursor(last.frameIn ?? -1, last.id)
          : null,
    });
  });

  api.post("/versions/:id/comments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(c, bodies.commentCreate);
    validateCommentAnchor(body);
    if (
      version.durationFrames !== null &&
      version.durationFrames !== undefined &&
      body.frame_in !== undefined &&
      body.frame_in >= version.durationFrames
    )
      throw errors.validation("Frame anchor is outside the version.");
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: version.id,
        parentId: null,
        authorUserId: actor.id,
        authorName: actor.name,
        authorEmail: actor.email,
        viewerKey: null,
        frameIn: body.frame_in ?? null,
        frameOut: body.frame_out ?? null,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson:
          body.pin_xy === undefined ? null : JSON.stringify(body.pin_xy),
        pageNo: body.page_no ?? null,
        internal: body.internal,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: now,
        editedAt: null,
      })
      .run();
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!comment) throw errors.internal();
    // New top-level comments notify the version uploader and the project
    // managers (never the commenting actor).
    const commentedAsset = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, version.assetId))
        .limit(1)
        .all()
    )[0];
    if (commentedAsset) {
      const payload = {
        project_id: commentedAsset.projectId,
        asset_id: commentedAsset.id,
        asset_name: commentedAsset.name,
        version_id: version.id,
        comment_id: id,
        actor_name: actor.name,
        preview: notificationPreview(body.body_text.trim()),
      };
      // Mention dedup: a mentioned user gets exactly one notification for
      // this comment and it is the mention (comment.mention wins over
      // comment.created for the same comment).
      const mentioned = await visibleMentionIds(
        commentedAsset.projectId,
        body.mentions,
      );
      if (mentioned.length)
        await createNotifications({
          projectId: commentedAsset.projectId,
          actorUserId: actor.id,
          recipients: mentioned,
          kind: "comment.mention",
          payload,
        });
      const mentionedSet = new Set(mentioned);
      await createNotifications({
        projectId: commentedAsset.projectId,
        actorUserId: actor.id,
        recipients: [
          version.uploadedBy,
          ...(await projectManagerIds(commentedAsset.projectId)),
        ].filter((recipient) => recipient && !mentionedSet.has(recipient)),
        kind: "comment.created",
        payload,
      });
      await appendProjectEvent(commentedAsset.projectId, "comment.created", {
        comment_id: id,
        version_id: version.id,
        frame_in: comment.frameIn,
      });
    }
    return c.json(commentWire(comment), 201);
  });

  /* Markers exported from an NLE come back as comments: the round trip. The
     file's timecodes resolve against the version's own rate and start frame,
     markers landing outside the version are counted rather than fatal, and no
     notifications fan out (a marker file is not a conversation). */
  api.post("/versions/:id/comments/import", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(c, bodies.commentsImport);
    const options = {
      rate: {
        num: version.frameRateNum ?? 24,
        den: version.frameRateDen ?? 1,
      },
      startFrame:
        body.timecode_base === "source" ? (version.sourceStartFrame ?? 0) : 0,
      dropFrame: Boolean(version.dropFrame),
      timecodeBase: body.timecode_base,
    };
    const markers =
      body.format === "resolve_edl"
        ? parseResolveEdl(body.content, options)
        : parseMarkersCsv(body.content);
    if (!markers.length)
      throw errors.validation(
        "No markers were found in the file. Onelight reads the Resolve marker EDL and its own CSV.",
      );
    if (markers.length > 2000)
      throw errors.validation("The file holds more than 2000 markers.");
    const duration = version.durationFrames;
    let imported = 0;
    let skipped = 0;
    const now = env.clock.now();
    for (const marker of markers) {
      if (duration !== null && duration !== undefined) {
        if (marker.frameIn >= duration) {
          skipped += 1;
          continue;
        }
        if (marker.frameOut !== null && marker.frameOut >= duration)
          marker.frameOut = duration - 1;
      }
      await env.db
        .insert(comments)
        .values({
          id: env.ids.ulid(),
          versionId: version.id,
          parentId: null,
          authorUserId: actor.id,
          authorName: actor.name,
          authorEmail: actor.email,
          viewerKey: null,
          frameIn: marker.frameIn,
          frameOut: marker.frameOut,
          bodyText: marker.bodyText,
          annotationJson: null,
          pinXyJson: null,
          pageNo: null,
          internal: false,
          completedAt: null,
          completedBy: null,
          carriedFromCommentId: null,
          deletedAt: null,
          createdAt: now,
          editedAt: null,
        })
        .run();
      imported += 1;
    }
    return c.json({ imported, skipped }, 201);
  });

  const commentForActor = async (
    id: string,
    actor: ActorUser,
    minimum: "viewer" | "commenter" = "viewer",
  ) => {
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!comment) throw errors.notFound("Comment was not found.");
    await versionForActor(comment.versionId, actor, minimum);
    return comment;
  };

  // Authors may edit and delete their own comments; project managers can
  // moderate any comment in their project (phase-2 section 2). Admins hold
  // manager implicitly inside requireProject.
  const requireCommentAuthorOrModerator = async (
    comment: typeof comments.$inferSelect,
    actor: ActorUser,
  ) => {
    if (comment.authorUserId === actor.id) return;
    const version = (
      await env.db
        .select({ assetId: assetVersions.assetId })
        .from(assetVersions)
        .where(eq(assetVersions.id, comment.versionId))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound("Comment was not found.");
    const asset = (
      await env.db
        .select({ projectId: assets.projectId })
        .from(assets)
        .where(eq(assets.id, version.assetId))
        .limit(1)
        .all()
    )[0];
    if (!asset) throw errors.notFound("Comment was not found.");
    await requireProject(asset.projectId, actor, "manager");
  };

  const attachmentFileFrom = async (
    c: Context<{ Variables: Variables }>,
  ): Promise<File> => {
    if (!env.blobStore || !c.req.raw.body)
      throw errors.internal("Blob storage is not configured.");
    const declaredLength = c.req.header("content-length");
    if (!declaredLength)
      throw errors.validation(
        "Attachment uploads require a content-length header.",
      );
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_COMMENT_ATTACHMENT_BYTES + 1_048_576
    )
      throw errors.payloadTooLarge();
    const form = await c.req.parseBody();
    const candidate = form.file;
    if (!candidate || typeof candidate === "string")
      throw errors.validation("A file field is required.");
    const file = candidate as File;
    if (file.size < 1 || file.size > MAX_COMMENT_ATTACHMENT_BYTES)
      throw errors.payloadTooLarge();
    return file;
  };

  const assertAttachmentCapacity = async (
    commentId: string,
    incomingBytes: number,
  ): Promise<void> => {
    const usage = (
      await env.db
        .select({
          count: sql<number>`count(*)`,
          bytes: sql<number>`coalesce(sum(${commentAttachments.size}), 0)`,
        })
        .from(commentAttachments)
        .where(eq(commentAttachments.commentId, commentId))
        .all()
    )[0];
    if (Number(usage?.count ?? 0) >= MAX_COMMENT_ATTACHMENTS)
      throw errors.conflict(
        `A comment can have at most ${String(MAX_COMMENT_ATTACHMENTS)} attachments.`,
      );
    if (
      Number(usage?.bytes ?? 0) + incomingBytes >
      MAX_COMMENT_ATTACHMENT_TOTAL_BYTES
    )
      throw errors.payloadTooLarge();
  };

  const storeCommentAttachment = async (
    comment: typeof comments.$inferSelect,
    workspaceId: string,
    file: File,
  ) => {
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    await assertAttachmentCapacity(comment.id, file.size);
    const attachmentId = env.ids.ulid();
    const filename =
      file.name.replace(/[\\/]/g, "_").slice(0, 500) || "attachment";
    const blobKey = `${workspaceId}/comments/${comment.id}/${attachmentId}-${filename}`;
    const stream = new Response(file.stream()).body;
    if (!stream)
      throw errors.internal("Attachment stream could not be opened.");
    await env.blobStore.putStream(blobKey, stream, {
      contentType: file.type || "application/octet-stream",
      size: file.size,
    });
    try {
      await env.db
        .insert(commentAttachments)
        .values({
          id: attachmentId,
          commentId: comment.id,
          blobKey,
          filename,
          size: file.size,
          contentType: file.type || "application/octet-stream",
          checksumSha256: "",
        })
        .run();
    } catch (error) {
      await deleteBlobQuietly(blobKey);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("comment attachment count limit"))
        throw errors.conflict(
          `A comment can have at most ${String(MAX_COMMENT_ATTACHMENTS)} attachments.`,
        );
      if (
        message.includes("comment attachment byte limit") ||
        message.includes("comment attachment size is invalid")
      )
        throw errors.payloadTooLarge();
      throw error;
    }
    return {
      id: attachmentId,
      comment_id: comment.id,
      filename,
      size: file.size,
    };
  };

  const deleteAttachmentsForComment = async (commentId: string) => {
    const rows = await env.db
      .select()
      .from(commentAttachments)
      .where(eq(commentAttachments.commentId, commentId))
      .all();
    for (const attachment of rows) await deleteBlobQuietly(attachment.blobKey);
    if (rows.length)
      await env.db
        .delete(commentAttachments)
        .where(eq(commentAttachments.commentId, commentId))
        .run();
  };

  api.patch("/comments/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await requireCommentAuthorOrModerator(comment, actor);
    const body = await jsonBody(c, bodies.commentPatch);
    validateCommentAnchor(body);
    /* A PATCH writes frame_in and frame_out independently, so the body-only
       guard above misses an inversion made against the STORED other end: a
       comment at [100,200] patched with just {frame_out:50} would persist an
       inverted range. Validate the effective range -- the merge of the body
       over what is already there -- including the version-bound check the
       create path does. */
    const effIn = body.frame_in === undefined ? comment.frameIn : body.frame_in;
    const effOut =
      body.frame_out === undefined ? comment.frameOut : body.frame_out;
    if (effIn !== null && effIn < 0)
      throw errors.validation("Frame anchors must be non-negative.");
    if (effIn !== null && effOut !== null && effOut < effIn)
      throw errors.validation(
        "frame_out must be greater than or equal to frame_in.",
      );
    if (
      effIn !== null &&
      (body.frame_in !== undefined || body.frame_out !== undefined)
    ) {
      const versionRow = (
        await env.db
          .select({ durationFrames: assetVersions.durationFrames })
          .from(assetVersions)
          .where(eq(assetVersions.id, comment.versionId))
          .limit(1)
          .all()
      )[0];
      if (
        versionRow?.durationFrames != null &&
        effIn >= versionRow.durationFrames
      )
        throw errors.validation("Frame anchor is outside the version.");
    }
    await env.db
      .update(comments)
      .set({
        ...(body.body_text ? { bodyText: body.body_text.trim() } : {}),
        ...(body.frame_in === undefined ? {} : { frameIn: body.frame_in }),
        ...(body.frame_out === undefined ? {} : { frameOut: body.frame_out }),
        ...(body.annotation === undefined
          ? {}
          : { annotationJson: JSON.stringify(body.annotation) }),
        ...(body.pin_xy === undefined
          ? {}
          : { pinXyJson: JSON.stringify(body.pin_xy) }),
        editedAt: env.clock.now(),
      })
      .where(eq(comments.id, comment.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    const patchedProjectId = await projectIdForVersion(updated.versionId);
    if (patchedProjectId)
      await appendProjectEvent(patchedProjectId, "comment.updated", {
        comment_id: updated.id,
        version_id: updated.versionId,
        frame_in: updated.frameIn,
      });
    return c.json(commentWire(updated));
  });

  api.delete("/comments/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await requireCommentAuthorOrModerator(comment, actor);
    await deleteAttachmentsForComment(comment.id);
    await env.db
      .update(comments)
      .set({ deletedAt: env.clock.now() })
      .where(eq(comments.id, comment.id))
      .run();
    const deletedProjectId = await projectIdForVersion(comment.versionId);
    if (deletedProjectId)
      await appendProjectEvent(deletedProjectId, "comment.deleted", {
        comment_id: comment.id,
        version_id: comment.versionId,
      });
    return c.body(null, 204);
  });

  api.post("/comments/:id/attachments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await requireCommentAuthorOrModerator(comment, actor);
    return c.json(
      await storeCommentAttachment(
        comment,
        actor.workspaceId,
        await attachmentFileFrom(c),
      ),
      201,
    );
  });

  api.get("/comments/:id/attachments/:attachmentId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(c.req.param("id"), actor);
    const attachment = (
      await env.db
        .select()
        .from(commentAttachments)
        .where(
          and(
            eq(commentAttachments.id, c.req.param("attachmentId")),
            eq(commentAttachments.commentId, comment.id),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!attachment || !env.blobStore) throw errors.notFound();
    return c.json({
      url: await privateMediaUrl(
        { versionId: comment.versionId },
        attachment.blobKey,
        attachmentDisposition(attachment.filename),
      ),
      expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
  });

  api.delete(
    "/comments/:id/attachments/:attachmentId",
    requireAuth,
    async (c) => {
      const actor = userFromContext(c);
      const comment = await commentForActor(
        c.req.param("id"),
        actor,
        "commenter",
      );
      await requireCommentAuthorOrModerator(comment, actor);
      const attachment = (
        await env.db
          .select()
          .from(commentAttachments)
          .where(
            and(
              eq(commentAttachments.id, c.req.param("attachmentId")),
              eq(commentAttachments.commentId, comment.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!attachment) throw errors.notFound();
      await deleteBlobQuietly(attachment.blobKey);
      await env.db
        .delete(commentAttachments)
        .where(eq(commentAttachments.id, attachment.id))
        .run();
      return c.body(null, 204);
    },
  );

  api.post("/comments/:id/replies", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const parent = await commentForActor(c.req.param("id"), actor, "commenter");
    if (parent.parentId) throw errors.validation("Replies cannot be nested.");
    const body = await jsonBody(c, bodies.replyCreate);
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: parent.versionId,
        parentId: parent.id,
        authorUserId: actor.id,
        authorName: actor.name,
        authorEmail: actor.email,
        viewerKey: null,
        frameIn: parent.frameIn,
        frameOut: parent.frameOut,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson: null,
        pageNo: null,
        internal: parent.internal,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: now,
        editedAt: null,
      })
      .run();
    const reply = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!reply) throw errors.internal();
    // Replies notify the parent author and the other thread participants
    // with a user account (share viewers have none), never the actor.
    const repliedVersion = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, parent.versionId))
        .limit(1)
        .all()
    )[0];
    const repliedAsset = repliedVersion
      ? (
          await env.db
            .select()
            .from(assets)
            .where(eq(assets.id, repliedVersion.assetId))
            .limit(1)
            .all()
        )[0]
      : undefined;
    if (repliedAsset) {
      const payload = {
        project_id: repliedAsset.projectId,
        asset_id: repliedAsset.id,
        asset_name: repliedAsset.name,
        version_id: parent.versionId,
        comment_id: id,
        parent_comment_id: parent.id,
        actor_name: actor.name,
        preview: notificationPreview(body.body_text.trim()),
      };
      // Mention dedup, same rule as top-level comments: mention wins.
      const mentioned = await visibleMentionIds(
        repliedAsset.projectId,
        body.mentions,
      );
      if (mentioned.length)
        await createNotifications({
          projectId: repliedAsset.projectId,
          actorUserId: actor.id,
          recipients: mentioned,
          kind: "comment.mention",
          payload,
        });
      const mentionedSet = new Set(mentioned);
      await createNotifications({
        projectId: repliedAsset.projectId,
        actorUserId: actor.id,
        recipients: (await threadParticipantIds(parent.id)).filter(
          (participant) => !mentionedSet.has(participant),
        ),
        kind: "comment.reply",
        payload,
      });
      await appendProjectEvent(repliedAsset.projectId, "comment.created", {
        comment_id: id,
        version_id: parent.versionId,
        frame_in: parent.frameIn,
        parent_id: parent.id,
      });
    }
    return c.json(commentWire(reply), 201);
  });

  api.post("/comments/:id/complete", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await env.db
      .update(comments)
      .set({ completedAt: env.clock.now(), completedBy: actor.id })
      .where(eq(comments.id, comment.id))
      .run();
    const completed = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!completed) throw errors.notFound();
    const completedProjectId = await projectIdForVersion(completed.versionId);
    if (completedProjectId)
      await appendProjectEvent(completedProjectId, "comment.updated", {
        comment_id: completed.id,
        version_id: completed.versionId,
        frame_in: completed.frameIn,
      });
    return c.json(commentWire(completed));
  });

  /* Resolving was one-way: completedAt could be set and never cleared, so a
     note resolved by mistake -- or reopened because the fix did not hold, which
     is the ordinary life of a note -- was stuck resolved forever. The inverse of
     POST /complete is DELETE /complete. */
  api.delete("/comments/:id/complete", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await env.db
      .update(comments)
      .set({ completedAt: null, completedBy: null })
      .where(eq(comments.id, comment.id))
      .run();
    const reopened = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!reopened) throw errors.notFound();
    const reopenedProjectId = await projectIdForVersion(reopened.versionId);
    if (reopenedProjectId)
      await appendProjectEvent(reopenedProjectId, "comment.updated", {
        comment_id: reopened.id,
        version_id: reopened.versionId,
        frame_in: reopened.frameIn,
      });
    return c.json(commentWire(reopened));
  });

  api.post("/comments/:id/reactions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(c, bodies.reactionCreate);
    await env.db
      .insert(commentReactions)
      .values({
        commentId: comment.id,
        userId: actor.id,
        code: body.code,
        createdAt: env.clock.now(),
      })
      .onConflictDoNothing()
      .run();
    return c.body(null, 204);
  });

  api.delete("/comments/:id/reactions/:code", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await env.db
      .delete(commentReactions)
      .where(
        and(
          eq(commentReactions.commentId, comment.id),
          eq(commentReactions.userId, actor.id),
          eq(commentReactions.code, c.req.param("code")),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  api.post("/versions/:id/carry-forward", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const target = await versionForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.carryForward);
    const source = await versionForActor(body.from_version_id, actor, "viewer");
    const copied = await copyUnresolvedComments(source.id, target.id);
    return c.json({ items: copied });
  });

  /** Approval changes notify the current version uploader and the project
      managers (never the actor who changed the status). */
  const notifyApprovalChange = async (options: {
    asset: typeof assets.$inferSelect;
    status: string;
    actorUserId: string | null;
    actorName: string;
  }) => {
    const currentVersion = options.asset.currentVersionId
      ? (
          await env.db
            .select({ uploadedBy: assetVersions.uploadedBy })
            .from(assetVersions)
            .where(eq(assetVersions.id, options.asset.currentVersionId))
            .limit(1)
            .all()
        )[0]
      : undefined;
    await createNotifications({
      projectId: options.asset.projectId,
      actorUserId: options.actorUserId,
      recipients: [
        currentVersion?.uploadedBy,
        ...(await projectManagerIds(options.asset.projectId)),
      ],
      kind: "approval.updated",
      payload: {
        project_id: options.asset.projectId,
        asset_id: options.asset.id,
        asset_name: options.asset.name,
        ...(options.asset.currentVersionId
          ? { version_id: options.asset.currentVersionId }
          : {}),
        status: options.status,
        actor_name: options.actorName,
        preview: `Status set to ${options.status.replace(/_/g, " ")}`,
      },
    });
  };

  api.patch("/assets/:id/approval", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.approvalPatch);
    await env.db
      .update(assets)
      .set({ status: body.status, updatedAt: env.clock.now() })
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
    await notifyApprovalChange({
      asset: updated,
      status: body.status,
      actorUserId: actor.id,
      actorName: actor.name,
    });
    return c.json(assetWire(updated));
  });

  api.get("/notifications", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    // Transcode failures are recorded by the out-of-process worker pump,
    // which sets transcode_status='failed' but writes no notification rows.
    // On the first read that observes a newly failed version in the actor's
    // workspace, materialize real notification rows ONCE for the uploader and
    // current managers, then stamp failure_notified_at so the work never
    // repeats (no per-request json_extract scan). The scan is index-served
    // (asset_versions_failed_idx) and failed versions are rare.
    const newlyFailed = await env.db
      .select({ version: assetVersions, asset: assets })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          eq(assetVersions.transcodeStatus, "failed"),
          isNull(assetVersions.failureNotifiedAt),
          isNull(assets.deletedAt),
          isNull(assetVersions.deletedAt),
        ),
      )
      .orderBy(desc(assetVersions.id))
      .limit(100)
      .all();
    for (const row of newlyFailed as Array<{
      version: typeof assetVersions.$inferSelect;
      asset: typeof assets.$inferSelect;
    }>) {
      await createNotifications({
        projectId: row.asset.projectId,
        actorUserId: null,
        recipients: [
          row.version.uploadedBy,
          ...(await projectManagerIds(row.asset.projectId)),
        ],
        kind: "transcode.failed",
        payload: {
          project_id: row.asset.projectId,
          asset_id: row.asset.id,
          asset_name: row.asset.name,
          version_id: row.version.id,
          preview: `Transcode failed for ${row.asset.name}`,
        },
      });
      await env.db
        .update(assetVersions)
        .set({ failureNotifiedAt: env.clock.now() })
        .where(eq(assetVersions.id, row.version.id))
        .run();
    }
    const rows = await env.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, actor.id),
          cursor ? lt(notifications.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(
        rows,
        limit,
        (notification: typeof notifications.$inferSelect) => ({
          id: notification.id,
          kind: notification.kind,
          payload: parseJsonObject(notification.payloadJson),
          read_at: notification.readAt,
          created_at: notification.createdAt,
        }),
      ),
    );
  });

  api.post("/notifications/read", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.notificationsRead);
    await env.db
      .update(notifications)
      .set({ readAt: env.clock.now() })
      .where(
        and(
          eq(notifications.userId, actor.id),
          or(...body.ids.map((id) => eq(notifications.id, id))),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  api.get("/notifications/preferences", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const existing = (
      await env.db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, actor.id))
        .limit(1)
        .all()
    )[0];
    return c.json(
      existing
        ? {
            mode: existing.mode,
            muted_projects: JSON.parse(existing.mutedProjectsJson),
          }
        : { mode: "instant", muted_projects: [] },
    );
  });

  api.patch("/notifications/preferences", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.notificationPreferencesPatch);
    await env.db
      .insert(notificationPreferences)
      .values({
        userId: actor.id,
        mode: body.mode,
        mutedProjectsJson: JSON.stringify(body.muted_projects),
        updatedAt: env.clock.now(),
      })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: {
          mode: body.mode,
          mutedProjectsJson: JSON.stringify(body.muted_projects),
          updatedAt: env.clock.now(),
        },
      })
      .run();
    return c.json({ mode: body.mode, muted_projects: body.muted_projects });
  });

  api.get("/sessions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const rows = await env.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, actor.id))
      .orderBy(desc(sessions.lastSeenAt))
      .all();
    return c.json({
      items: rows.map((session: typeof sessions.$inferSelect) => ({
        id: session.id,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
        last_seen_at: session.lastSeenAt,
        ip: session.ip,
        user_agent: session.userAgent,
      })),
    });
  });

  api.delete("/sessions/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await env.db
      .delete(sessions)
      .where(
        and(eq(sessions.id, c.req.param("id")), eq(sessions.userId, actor.id)),
      )
      .run();
    return c.body(null, 204);
  });

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
              sql`${projects.name} LIKE ${pattern} ESCAPE '\\'`,
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
              sql`${shares.title} LIKE ${pattern} ESCAPE '\\'`,
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
              sql`${assets.name} LIKE ${pattern} ESCAPE '\\'`,
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
            sql`${comments.bodyText} LIKE ${commentPattern} ESCAPE '\\'`,
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
                    sql`(${users.name} LIKE ${pattern} ESCAPE '\\' OR ${users.email} LIKE ${pattern} ESCAPE '\\')`,
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

  const shareBySlug = async (slug: string) => {
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.slug, slug))
        .limit(1)
        .all()
    )[0];
    if (
      !share ||
      share.revokedAt ||
      (share.expiresAt !== null && share.expiresAt <= env.clock.now())
    )
      throw errors.notFound("Share is unavailable.");
    return share;
  };

  const shareCookie = (shareId: string): string => `ol_share_${shareId}`;

  const issueViewer = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
    name: string | undefined,
    email: string | undefined,
  ) => {
    const viewerKey = base64UrlEncode(randomBytes(18));
    const now = env.clock.now();
    const viewerId = env.ids.ulid();
    await env.db
      .insert(shareViewers)
      .values({
        id: viewerId,
        shareId: share.id,
        viewerKey,
        name: name?.trim() || null,
        email: email?.trim().toLowerCase() || null,
        firstSeenAt: now,
        lastSeenAt: now,
        userAgent: c.req.header("user-agent") ?? null,
        viewStateJson: "{}",
      })
      .run();
    const signed = await new SignJWT({
      share_id: share.id,
      viewer_key: viewerKey,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    setCookie(c, shareCookie(share.id), signed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: env.config.cookieSecure,
      maxAge: 86_400,
      path: "/",
    });
    return { viewerId, viewerKey };
  };

  const viewerFor = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
  ) => {
    const signed = getCookie(c, shareCookie(share.id));
    if (!signed) return undefined;
    try {
      const verified = await jwtVerify(
        signed,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.share_id !== share.id ||
        typeof verified.payload.viewer_key !== "string"
      )
        return undefined;
      const viewer = (
        await env.db
          .select()
          .from(shareViewers)
          .where(
            and(
              eq(shareViewers.shareId, share.id),
              eq(shareViewers.viewerKey, verified.payload.viewer_key),
            ),
          )
          .limit(1)
          .all()
      )[0];
      const now = env.clock.now();
      if (viewer && viewer.lastSeenAt <= now - PRESENCE_WRITE_INTERVAL_MS)
        await env.db
          .update(shareViewers)
          .set({ lastSeenAt: now })
          .where(
            and(
              eq(shareViewers.id, viewer.id),
              lt(shareViewers.lastSeenAt, now - PRESENCE_WRITE_INTERVAL_MS + 1),
            ),
          )
          .run();
      return viewer;
    } catch {
      return undefined;
    }
  };

  /* Download URLs live twelve hours so an interrupted multi-hundred-GB pull
     can resume long after it started; playback URLs stay short. A token
     carrying an attachment disposition IS a download, so the TTL follows
     the disposition and no call site can get it wrong. */
  const DOWNLOAD_TOKEN_TTL = "12h";
  const DOWNLOAD_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

  const issueMediaToken = async (
    share: typeof shares.$inferSelect,
    assetId: string,
    versionId: string,
    blobKey: string,
    disposition?: string,
  ) =>
    new SignJWT({
      share_id: share.id,
      asset_id: assetId,
      version_id: versionId,
      blob_key: blobKey,
      ...(disposition ? { disposition } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(disposition ? DOWNLOAD_TOKEN_TTL : "15m")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));

  const publicMediaUrl = async (
    share: typeof shares.$inferSelect,
    assetId: string,
    versionId: string,
    blobKey: string,
    disposition?: string,
  ) =>
    /* Origin-relative on purpose: the page fetches these from whatever origin
       it was loaded on, so the same deployment works via LAN IP and the public
       domain without PUBLIC_URL having to match the request. Links that leave
       the browser (emails, OG tags, the copyable share URL) still use
       PUBLIC_URL. */
    `/s/${share.slug}/assets/${assetId}/media/file?token=${encodeURIComponent(await issueMediaToken(share, assetId, versionId, blobKey, disposition))}`;

  /**
   * The watermarked rendition this share may serve for a version: kind
   * "watermarked", registered for this share, and carrying the share's
   * CURRENT watermark_spec_hash in its meta. A spec change invalidates the
   * old rendition immediately (its hash no longer matches) even before the
   * superseded row is cleaned up.
   */
  const watermarkedRenditionFor = async (
    share: typeof shares.$inferSelect,
    versionId: string,
  ): Promise<typeof renditions.$inferSelect | undefined> => {
    if (!share.watermarkSpecHash) return undefined;
    const rows = await env.db
      .select()
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, versionId),
          eq(renditions.kind, "watermarked"),
          eq(renditions.shareId, share.id),
        ),
      )
      .all();
    return rows.find(
      (rendition: typeof renditions.$inferSelect) =>
        parseJsonObject(rendition.metaJson).spec_hash ===
        share.watermarkSpecHash,
    );
  };

  const shareIsWatermarked = (share: typeof shares.$inferSelect): boolean =>
    Boolean(share.watermarkSpecJson && share.watermarkSpecHash);

  const attachmentDisposition = (filename: string): string =>
    `attachment; filename="${filename.replace(/[\r\n"]/g, "")}"`;

  // The disposition value comes from a verified JWT claim only, but it is
  // sanitized again before reaching the header: CR/LF and control characters
  // are stripped and the value must match the shape we issue, with quotes
  // forbidden inside the filename.
  const sanitizeDisposition = (value: string): string | undefined => {
    const cleaned = value.replace(/[^\t\x20-\x7e]/g, "");
    const match = /^(attachment|inline)(?:; filename="([^"\\]*)")?$/.exec(
      cleaned,
    );
    if (!match) return undefined;
    return match[2] !== undefined
      ? `${match[1]}; filename="${match[2]}"`
      : match[1];
  };

  /* What the blob belongs to. The claim is not consulted when serving --
     blob_key is what authorizes -- but a token should not misdescribe its own
     subject: an export is not a version, and a project cover has no version at
     all. */
  type MediaScope =
    { versionId: string } | { projectId: string } | { exportId: string };

  const mediaScopeClaim = (scope: MediaScope): Record<string, string> =>
    "versionId" in scope
      ? { version_id: scope.versionId }
      : "projectId" in scope
        ? { project_id: scope.projectId }
        : { export_id: scope.exportId };

  const issuePrivateMediaToken = async (
    scope: MediaScope,
    blobKey: string,
    disposition?: string,
  ) =>
    new SignJWT({
      ...mediaScopeClaim(scope),
      blob_key: blobKey,
      ...(disposition ? { disposition } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(disposition ? DOWNLOAD_TOKEN_TTL : "15m")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));

  const privateMediaUrl = async (
    scope: MediaScope,
    blobKey: string,
    disposition?: string,
  ) =>
    /* Origin-relative for the same reason as publicMediaUrl above. */
    `/api/v1/media/${blobKey.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(await issuePrivateMediaToken(scope, blobKey, disposition))}`;

  /* These must match what the worker actually writes. The sidecars are PNG
     (media.ts writes poster.png, sprite.png, audio_peaks.png) and were served
     as image/jpeg, and audio_peaks was not listed at all -- so the waveform
     fell through to application/octet-stream, which no browser will render. */
  const renditionKindContentTypes: Record<string, string> = {
    proxy_2160: "video/mp4",
    proxy_1080: "video/mp4",
    proxy_540: "video/mp4",
    hdr_hevc: "video/mp4",
    hdr_av1: "video/mp4",
    watermarked: "video/mp4",
    proxy_audio: "audio/mp4",
    poster: "image/png",
    sprite: "image/png",
    audio_peaks: "image/png",
    spectrogram: "image/png",
    still_tiles: "image/png",
    /* Peak data is a binary sidecar the player fetches and parses, not
       anything a browser renders on its own. */
    waveform_data: "application/octet-stream",
  };

  /* Last resort before application/octet-stream: the key's own extension. A
     rendition kind added to the worker but forgotten above should still serve
     as something a browser can display, rather than silently download. */
  const extensionContentTypes: Record<string, string> = {
    mp4: "video/mp4",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    vtt: "text/vtt",
  };

  const blobContentType = async (key: string): Promise<string> => {
    const attachment = (
      await env.db
        .select({ contentType: commentAttachments.contentType })
        .from(commentAttachments)
        .where(eq(commentAttachments.blobKey, key))
        .limit(1)
        .all()
    )[0];
    if (attachment?.contentType) return attachment.contentType;
    const rendition = (
      await env.db
        .select({ kind: renditions.kind, metaJson: renditions.metaJson })
        .from(renditions)
        .where(eq(renditions.blobKey, key))
        .limit(1)
        .all()
    )[0];
    if (rendition) {
      const meta = parseJsonObject(rendition.metaJson);
      if (typeof meta.content_type === "string") return meta.content_type;
      const mapped = renditionKindContentTypes[rendition.kind];
      if (mapped) return mapped;
    }
    const extension = key.split(".").pop()?.toLowerCase();
    return (
      (extension ? extensionContentTypes[extension] : undefined) ??
      "application/octet-stream"
    );
  };

  const parseRangeHeader = (
    header: string,
    size: number,
  ): { start: number; end: number } | "unsatisfiable" | undefined => {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return undefined;
    const [, startRaw, endRaw] = match;
    if (!startRaw && !endRaw) return undefined;
    if (!startRaw) {
      const suffix = Number(endRaw);
      if (suffix < 1 || size === 0) return "unsatisfiable";
      return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(startRaw);
    const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
    if (start >= size || start > end) return "unsatisfiable";
    return { start, end };
  };

  const serveBlob = async (
    c: Context<{ Variables: Variables }>,
    key: string,
    disposition?: string,
  ) => {
    const store = env.blobStore;
    if (!store) throw errors.internal("Blob storage is not configured.");
    c.header("accept-ranges", "bytes");
    c.header("content-type", await blobContentType(key));
    if (disposition) c.header("content-disposition", disposition);
    /* Blobs are immutable per key, so the key is a permanent strong
       validator. Without an ETag, browsers restart an interrupted download
       from zero instead of asking for the remaining bytes. */
    const etag = `"b${(await sha256Hex(key)).slice(0, 24)}"`;
    c.header("etag", etag);
    let size: number | undefined;
    if (typeof store.head === "function") {
      try {
        size = (await store.head(key)).size;
      } catch {
        throw errors.notFound("Media was not found.");
      }
    }
    const rangeHeader = c.req.header("range");
    const ifRange = c.req.header("if-range");
    if (
      rangeHeader !== undefined &&
      size !== undefined &&
      (ifRange === undefined || ifRange === etag)
    ) {
      const range = parseRangeHeader(rangeHeader, size);
      if (range === "unsatisfiable") {
        c.header("content-range", `bytes */${size}`);
        return c.body(null, 416);
      }
      if (range) {
        c.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
        c.header("content-length", String(range.end - range.start + 1));
        return c.body(
          await store.getStream(key, { start: range.start, end: range.end }),
          206,
        );
      }
    }
    if (size !== undefined) c.header("content-length", String(size));
    return c.body(await store.getStream(key), 200);
  };

  /* CRCs computed while a zip streams, remembered for resumes: with them a
     Range request skips straight to the interrupted byte instead of
     re-reading every entry to rebuild the central directory's checksums.
     Keyed by blob key, which is immutable, and bluntly reset when large. */
  const zipCrcCache = new Map<string, number>();
  const rememberZipCrc = (key: string, crc: number): void => {
    if (zipCrcCache.size >= 100_000) zipCrcCache.clear();
    zipCrcCache.set(key, crc);
  };

  const truncateTo = (
    stream: ReadableStream<Uint8Array>,
    limit: number,
  ): ReadableStream<Uint8Array> => {
    const reader = stream.getReader();
    let remaining = limit;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (remaining <= 0) {
          controller.close();
          await reader.cancel();
          return;
        }
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        if (next.value.length <= remaining) {
          remaining -= next.value.length;
          controller.enqueue(next.value);
        } else {
          controller.enqueue(next.value.subarray(0, remaining));
          remaining = 0;
          await reader.cancel();
          controller.close();
        }
      },
      async cancel() {
        await reader.cancel();
      },
    });
  };

  /* The deterministic layout gives the archive an exact length and a stable
     identity before a byte is written, so a hundreds-of-GB zip serves with
     a real Content-Length, an ETag, and honest 206 resumes. */
  const serveZip = async (
    c: Context<{ Variables: Variables }>,
    entries: ZipEntry[],
    zipName: string,
  ): Promise<Response> => {
    const total = zipLength(entries);
    const identity = entries
      .map((entry) => `${entry.cacheKey ?? entry.name}:${entry.size}`)
      .join("|");
    const etag = `"z${(await sha256Hex(identity)).slice(0, 24)}"`;
    const base: Record<string, string> = {
      "content-type": "application/zip",
      "content-disposition": attachmentDisposition(zipName),
      "accept-ranges": "bytes",
      etag,
    };
    const rangeHeader = c.req.header("range");
    const ifRange = c.req.header("if-range");
    if (rangeHeader && (ifRange === undefined || ifRange === etag)) {
      const range = parseRangeHeader(rangeHeader, total);
      if (range === "unsatisfiable")
        return new Response(null, {
          status: 416,
          headers: { ...base, "content-range": `bytes */${total}` },
        });
      if (range) {
        const length = range.end - range.start + 1;
        let stream = zipStreamFrom(entries, range.start, {
          crcs: zipCrcCache,
          onCrc: rememberZipCrc,
        });
        if (range.end < total - 1) stream = truncateTo(stream, length);
        return new Response(stream, {
          status: 206,
          headers: {
            ...base,
            "content-range": `bytes ${range.start}-${range.end}/${total}`,
            "content-length": String(length),
          },
        });
      }
    }
    /* The full build also runs through the resume path so it warms the CRC
       cache; from byte zero the two are the same stream. */
    return new Response(
      zipStreamFrom(entries, 0, { crcs: zipCrcCache, onCrc: rememberZipCrc }),
      { headers: { ...base, "content-length": String(total) } },
    );
  };

  api.post("/shares", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.shareCreate);
    await requireProject(body.project_id, actor, "manager");
    const allowedAssets = await env.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(eq(assets.projectId, body.project_id), isNull(assets.deletedAt)),
      )
      .all();
    const allowed = new Set(
      allowedAssets.map((asset: { id: string }) => asset.id),
    );
    if (body.asset_ids.some((id) => !allowed.has(id)))
      throw errors.validation("Every shared asset must belong to the project.");
    const id = env.ids.ulid();
    // The link reads like what it opens: the title, then 14 base62 chars
    // (about 83 bits) so the URL stays the secret it is documented to be.
    const readable = body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
    const slug = readable ? `${readable}-${base62(14)}` : base62(22);
    const now = env.clock.now();
    const watermarkJson = body.watermark_spec
      ? JSON.stringify(body.watermark_spec)
      : null;
    await env.db
      .insert(shares)
      .values({
        id,
        publicId: await newSharePublicId(),
        projectId: body.project_id,
        slug,
        kind: body.kind,
        title: body.title.trim(),
        layout: body.layout,
        passphraseHash: body.passphrase
          ? await env.hasher.hash(body.passphrase)
          : null,
        expiresAt: body.expires_at ?? null,
        allowDownload: body.allow_download,
        allowComments: body.allow_comments,
        allowApprovals: body.allow_approvals ?? body.kind !== "presentation",
        showAllVersions: body.show_all_versions,
        watermarkSpecJson: watermarkJson,
        watermarkSpecHash: watermarkJson
          ? await sha256Hex(watermarkJson)
          : null,
        brandJson: body.brand ? JSON.stringify(body.brand) : null,
        createdBy: actor.id,
        folderId: body.folder_id ?? null,
        revokedAt: null,
        createdAt: now,
      })
      .run();
    for (const [index, assetId] of body.asset_ids.entries())
      await env.db
        .insert(shareAssets)
        .values({ shareId: id, assetId, sortOrder: index })
        .run();
    const share = (
      await env.db.select().from(shares).where(eq(shares.id, id)).limit(1).all()
    )[0];
    if (!share) throw errors.internal();
    return c.json(
      {
        share: shareWire(share),
        url: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/s/${slug}`,
      },
      201,
    );
  });

  api.get("/shares", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.query("project_id");
    if (projectId) await requireProject(projectId, actor, "viewer");
    const rows = await env.db
      .select()
      .from(shares)
      .innerJoin(projects, eq(shares.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          projectId ? eq(shares.projectId, projectId) : undefined,
        ),
      )
      .orderBy(desc(shares.id))
      .all();
    return c.json({
      items: rows.map((row: { shares: typeof shares.$inferSelect }) =>
        shareWire(row.shares),
      ),
    });
  });

  api.get("/shares/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, await shareParam(c.req.param("id"))))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "viewer");
    const links = await env.db
      .select()
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .orderBy(asc(shareAssets.sortOrder))
      .all();
    return c.json({
      ...shareWire(share),
      assets: links.map((link: typeof shareAssets.$inferSelect) => ({
        share_id: link.shareId,
        asset_id: link.assetId,
        sort_order: link.sortOrder,
      })),
    });
  });

  // Share viewer roster: who opened the share and when. Restricted to the
  // share owner or a project manager; the signed viewer_key never leaves
  // the server.
  api.get("/shares/:id/viewers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    // requireProject 404s cross-workspace and non-member-on-restricted
    // callers before the owner-or-manager rule applies.
    const { role } = await requireProject(share.projectId, actor, "viewer");
    if (share.createdBy !== actor.id && !projectRoleAtLeast(role, "manager"))
      throw errors.forbidden();
    const rows = await env.db
      .select()
      .from(shareViewers)
      .where(eq(shareViewers.shareId, share.id))
      .orderBy(desc(shareViewers.id))
      .all();
    return c.json({
      items: rows.map((viewer: typeof shareViewers.$inferSelect) => ({
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        first_seen_at: viewer.firstSeenAt,
        last_seen_at: viewer.lastSeenAt,
        user_agent: viewer.userAgent,
      })),
    });
  });

  api.patch("/shares/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.sharePatch);
    if (body.folder_id) {
      const folder = (
        await env.db
          .select({ projectId: folders.projectId, kind: folders.kind })
          .from(folders)
          .where(eq(folders.id, body.folder_id))
          .limit(1)
          .all()
      )[0];
      if (
        !folder ||
        folder.projectId !== share.projectId ||
        folder.kind !== "shares"
      )
        throw errors.validation(
          "folder_id must name a shares folder in this project.",
        );
    }
    const watermarkJson =
      body.watermark_spec === undefined
        ? share.watermarkSpecJson
        : body.watermark_spec
          ? JSON.stringify(body.watermark_spec)
          : null;
    await env.db
      .update(shares)
      .set({
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.layout ? { layout: body.layout } : {}),
        ...(body.passphrase === undefined
          ? {}
          : {
              passphraseHash: body.passphrase
                ? await env.hasher.hash(body.passphrase)
                : null,
            }),
        ...(body.expires_at === undefined
          ? {}
          : { expiresAt: body.expires_at }),
        ...(body.allow_download ? { allowDownload: body.allow_download } : {}),
        // Explicit null files a share back under the Shares root, so it must
        // not be confused with "not mentioned".
        ...(body.folder_id === undefined ? {} : { folderId: body.folder_id }),
        ...(body.allow_comments === undefined
          ? {}
          : { allowComments: body.allow_comments }),
        ...(body.allow_approvals === undefined
          ? {}
          : { allowApprovals: body.allow_approvals }),
        ...(body.show_all_versions === undefined
          ? {}
          : { showAllVersions: body.show_all_versions }),
        ...(body.watermark_spec === undefined
          ? {}
          : {
              watermarkSpecJson: watermarkJson,
              watermarkSpecHash: watermarkJson
                ? await sha256Hex(watermarkJson)
                : null,
            }),
        ...(body.brand === undefined
          ? {}
          : {
              // The logo rides the brand row but is managed by its own
              // endpoints; a colour change must not silently drop the mark.
              brandJson: (() => {
                const kept = share.brandJson
                  ? parseJsonObject(share.brandJson).logo_key
                  : undefined;
                const next = {
                  ...(body.brand ?? {}),
                  ...(typeof kept === "string" ? { logo_key: kept } : {}),
                };
                return Object.keys(next).length ? JSON.stringify(next) : null;
              })(),
            }),
        ...(body.revoked ? { revokedAt: env.clock.now() } : {}),
      })
      .where(eq(shares.id, share.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, share.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    return c.json(shareWire(updated));
  });

  /* Add assets to a share that already exists. Without this, putting one more
     clip in front of a client meant building a second share with a second link
     -- so the project page could only ever offer "create a share", never "add
     to that one". */
  api.post("/shares/:id/assets", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.shareAssetsAdd);
    const allowed = new Set(
      (
        await env.db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.projectId, share.projectId),
              isNull(assets.deletedAt),
            ),
          )
          .all()
      ).map((asset: { id: string }) => asset.id),
    );
    if (body.asset_ids.some((id) => !allowed.has(id)))
      throw errors.validation("Every shared asset must belong to the project.");
    const existing = await env.db
      .select({
        assetId: shareAssets.assetId,
        sortOrder: shareAssets.sortOrder,
      })
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .all();
    const present = new Set(
      existing.map((link: { assetId: string }) => link.assetId),
    );
    // Adding what is already there is a no-op, not a conflict: this runs from a
    // multi-select where an overlap with the share's contents is ordinary.
    let sortOrder = existing.reduce(
      (highest: number, link: { sortOrder: number }) =>
        Math.max(highest, link.sortOrder + 1),
      0,
    );
    let added = 0;
    for (const assetId of body.asset_ids) {
      if (present.has(assetId)) continue;
      await env.db
        .insert(shareAssets)
        .values({ shareId: share.id, assetId, sortOrder })
        .run();
      present.add(assetId);
      sortOrder += 1;
      added += 1;
    }
    if (added > 0)
      await audit(
        actor.workspaceId,
        actor.id,
        "share.update",
        `share:${share.id}`,
      );
    return c.json({ share: shareWire(share), added });
  });

  /* Curation: a presentation is an ordered reel, so its order is a setting.
     The body names every asset currently in the share, in the order wanted;
     naming a different set is a mistake, not a merge. */
  api.patch("/shares/:id/assets", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.shareAssetsReorder);
    const existing = (await env.db
      .select({ assetId: shareAssets.assetId })
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .all()) as Array<{ assetId: string }>;
    const current = new Set(existing.map((link) => link.assetId));
    const wanted = new Set(body.asset_ids);
    if (
      wanted.size !== body.asset_ids.length ||
      current.size !== wanted.size ||
      body.asset_ids.some((id) => !current.has(id))
    )
      throw errors.validation(
        "The order must name each asset in the share exactly once.",
      );
    for (const [index, assetId] of body.asset_ids.entries()) {
      await env.db
        .update(shareAssets)
        .set({ sortOrder: index })
        .where(
          and(
            eq(shareAssets.shareId, share.id),
            eq(shareAssets.assetId, assetId),
          ),
        )
        .run();
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "share.update",
      `share:${share.id}`,
    );
    return c.json({
      items: body.asset_ids.map((assetId, index) => ({
        asset_id: assetId,
        sort_order: index,
      })),
    });
  });

  api.delete("/shares/:id/assets/:assetId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    const link = (
      await env.db
        .select({ assetId: shareAssets.assetId })
        .from(shareAssets)
        .where(
          and(
            eq(shareAssets.shareId, share.id),
            eq(shareAssets.assetId, c.req.param("assetId")),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!link) throw errors.notFound();
    await env.db
      .delete(shareAssets)
      .where(
        and(
          eq(shareAssets.shareId, share.id),
          eq(shareAssets.assetId, link.assetId),
        ),
      )
      .run();
    await audit(
      actor.workspaceId,
      actor.id,
      "share.update",
      `share:${share.id}`,
    );
    return c.body(null, 204);
  });

  /* ---- the share's logo (brand, design doc section 11) ---- */

  const LOGO_TYPES: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  const LOGO_MAX_BYTES = 512 * 1024;

  const logoKeyOf = (share: typeof shares.$inferSelect): string | null => {
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    return typeof brand.logo_key === "string" ? brand.logo_key : null;
  };

  api.put("/shares/:id/logo", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const contentType =
      (c.req.header("content-type") ?? "").split(";")[0] ?? "";
    const extension = LOGO_TYPES[contentType];
    if (!extension)
      throw errors.validation("The logo must be a PNG, JPEG, WebP, or SVG.");
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) throw errors.validation("The logo is empty.");
    if (bytes.byteLength > LOGO_MAX_BYTES)
      throw errors.validation("The logo must be under 512 KB.");
    // A fresh key per upload, so the public URL changes and no cache can
    // serve the old mark; the replaced blob is deleted best-effort.
    const previous = logoKeyOf(share);
    const key = `${actor.workspaceId}/sharelogos/${share.id}-${env.ids.ulid()}.${extension}`;
    await env.blobStore.putStream(
      key,
      new Response(bytes).body as ReadableStream,
      { contentType, size: bytes.byteLength },
    );
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    await env.db
      .update(shares)
      .set({ brandJson: JSON.stringify({ ...brand, logo_key: key }) })
      .where(eq(shares.id, share.id))
      .run();
    await deleteBlobQuietly(previous);
    return c.json({ logo_url: `/api/v1/s/${share.slug}/logo` });
  });

  api.delete("/shares/:id/logo", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    await deleteBlobQuietly(logoKeyOf(share));
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    delete brand.logo_key;
    await env.db
      .update(shares)
      .set({
        brandJson: Object.keys(brand).length ? JSON.stringify(brand) : null,
      })
      .where(eq(shares.id, share.id))
      .run();
    return c.body(null, 204);
  });

  api.delete("/shares/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "manager");
    await env.db
      .update(shares)
      .set({ revokedAt: env.clock.now() })
      .where(eq(shares.id, share.id))
      .run();
    /* Drop the burned-in watermark renditions this share caused.
       renditions.share_id carries no foreign key -- it cannot, since a
       rendition may belong to no share at all -- so nothing else would ever
       remove them, and a revoked share can never be watched again. They were
       minutes of encoding and hundreds of megabytes each, pinned forever by a
       row that exists only to say "revoked". The blobs become unreferenced and
       the sweeper reclaims them; a later share re-renders its own. */
    await env.db
      .delete(renditions)
      .where(eq(renditions.shareId, share.id))
      .run();
    await audit(
      actor.workspaceId,
      actor.id,
      "share.revoke",
      `share:${share.id}`,
    );
    return c.body(null, 204);
  });

  api.post("/webhooks", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.webhookCreate);
    assertWebhookUrlAllowed(body.url);
    const id = env.ids.ulid();
    const secret = body.secret ?? base64UrlEncode(randomBytes(32));
    await env.db
      .insert(webhooks)
      .values({
        id,
        workspaceId: actor.workspaceId,
        url: body.url,
        secret,
        eventsJson: JSON.stringify(body.events),
        active: true,
        createdAt: env.clock.now(),
      })
      .run();
    return c.json({ id, url: body.url, events: body.events, secret }, 201);
  });

  api.get("/webhooks", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const rows = await env.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.workspaceId, actor.workspaceId))
      .all();
    return c.json({
      items: rows.map((hook: typeof webhooks.$inferSelect) => ({
        id: hook.id,
        url: hook.url,
        events: JSON.parse(hook.eventsJson),
        active: Boolean(hook.active),
        created_at: hook.createdAt,
      })),
    });
  });

  api.delete("/webhooks/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    await env.db
      .delete(webhooks)
      .where(
        and(
          eq(webhooks.id, c.req.param("id")),
          eq(webhooks.workspaceId, actor.workspaceId),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  api.post("/shares/:id/export", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "viewer");
    const body = await jsonBody(c, bodies.exportCreate);
    const id = env.ids.ulid();
    await env.db
      .insert(exportJobs)
      .values({
        id,
        workspaceId: actor.workspaceId,
        requestedBy: actor.id,
        projectId: share.projectId,
        format: body.format,
        filtersJson: JSON.stringify(body.filters),
        timecodeBase: body.timecode_base,
        status: "queued",
        resultBlobKey: null,
        error: null,
        createdAt: env.clock.now(),
        finishedAt: null,
      })
      .run();
    return c.json({ id, status: "queued" }, 202);
  });

  /* The project-scoped twin of the share export: same job, no share needed.
     This is the entry point the review page uses. */
  api.post("/projects/:id/export", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "viewer",
    );
    const body = await jsonBody(c, bodies.exportCreate);
    const id = env.ids.ulid();
    await env.db
      .insert(exportJobs)
      .values({
        id,
        workspaceId: actor.workspaceId,
        requestedBy: actor.id,
        projectId: project.id,
        format: body.format,
        filtersJson: JSON.stringify(body.filters),
        timecodeBase: body.timecode_base,
        status: "queued",
        resultBlobKey: null,
        error: null,
        createdAt: env.clock.now(),
        finishedAt: null,
      })
      .run();
    return c.json({ id, status: "queued" }, 202);
  });

  api.get("/exports/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const job = (
      await env.db
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.id, c.req.param("id")),
            eq(exportJobs.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!job) throw errors.notFound();
    await requireProject(job.projectId, actor, "viewer");
    return c.json(exportWire(job));
  });

  api.get("/exports/:id/download", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const job = (
      await env.db
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.id, c.req.param("id")),
            eq(exportJobs.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!job) throw errors.notFound();
    await requireProject(job.projectId, actor, "viewer");
    if (job.status !== "complete" || !job.resultBlobKey || !env.blobStore)
      throw errors.notFound("The export is not ready.");
    const filename = job.resultBlobKey.split("/").pop() || `export-${job.id}`;
    return c.json({
      url: await privateMediaUrl(
        { exportId: job.id },
        job.resultBlobKey,
        attachmentDisposition(filename),
      ),
      expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
  });

  api.post("/s/:slug/access", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const ip = clientIp(c, env);
    await hitRateLimit(`share_access:${share.id}:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.shareAccess);
    if (
      share.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, share.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const viewer = await issueViewer(c, share, body.name, body.email);
    return c.json({
      share: publicShareWire(share),
      viewer_key: viewer.viewerKey,
    });
  });

  type PublicShareAsset = typeof assets.$inferSelect & { sort_order: number };

  const publicShare = async (
    c: Context<{ Variables: Variables }>,
    share: typeof shares.$inferSelect,
  ) => {
    const viewer = await viewerFor(c, share);
    if (share.passphraseHash && !viewer) throw errors.unauthorized();
    const links = await env.db
      .select({ asset: assets, link: shareAssets })
      .from(shareAssets)
      .innerJoin(assets, eq(shareAssets.assetId, assets.id))
      .where(eq(shareAssets.shareId, share.id))
      .orderBy(asc(shareAssets.sortOrder))
      .all();
    return {
      share,
      viewer,
      assets: links.map(
        (link: {
          asset: typeof assets.$inferSelect;
          link: typeof shareAssets.$inferSelect;
        }) => ({ ...link.asset, sort_order: link.link.sortOrder }),
      ),
    };
  };

  // Posters and sprites for a whole share listing, in one rendition query.
  //
  // The app's own grid resolves posters per asset through the internal
  // versions and renditions endpoints, which a share viewer cannot reach; a
  // share also has no reason to spend a request per tile. Poster pixels follow
  // the sidecar policy in the asset detail below: thumbnail-scale frames are
  // exposed even on a watermarked share, whose sprite already carries them.
  const posterUrlsFor = async (
    share: typeof shares.$inferSelect,
    shareAssets: PublicShareAsset[],
  ): Promise<
    Map<
      string,
      {
        poster: string | null;
        sprite: string | null;
        sprite_vtt: string | null;
      }
    >
  > => {
    const urls = new Map<
      string,
      {
        poster: string | null;
        sprite: string | null;
        sprite_vtt: string | null;
      }
    >();
    const versionIds = shareAssets
      .map((asset) => asset.currentVersionId)
      .filter((id): id is string => Boolean(id));
    if (!env.blobStore || !versionIds.length) return urls;
    // Posters and sprites in one query: the landing draws the poster and
    // hover-scrubs the sprite, both watermark-neutral sidecars.
    const sidecarRows = (await env.db
      .select()
      .from(renditions)
      .where(
        and(
          inArray(renditions.versionId, versionIds),
          inArray(renditions.kind, ["poster", "sprite"]),
          isNull(renditions.shareId),
        ),
      )
      .all()) as Array<typeof renditions.$inferSelect>;
    const postersBy = new Map<string, typeof renditions.$inferSelect>();
    const spritesBy = new Map<string, typeof renditions.$inferSelect>();
    for (const row of sidecarRows)
      (row.kind === "poster" ? postersBy : spritesBy).set(row.versionId, row);
    for (const asset of shareAssets) {
      const versionId = asset.currentVersionId;
      if (!versionId) continue;
      const poster = postersBy.get(versionId);
      const sprite = spritesBy.get(versionId);
      const spriteMeta = sprite ? parseJsonObject(sprite.metaJson) : {};
      const vttKey =
        typeof spriteMeta.vtt_blob_key === "string"
          ? spriteMeta.vtt_blob_key
          : undefined;
      /* A thumbnail chosen for the asset beats the generated poster here as
         well as inside the app: the room is the place it was chosen for. */
      const posterKey = asset.thumbnailBlobKey ?? poster?.blobKey ?? null;
      urls.set(asset.id, {
        poster: posterKey
          ? await publicMediaUrl(share, asset.id, versionId, posterKey)
          : null,
        sprite:
          sprite && vttKey
            ? await publicMediaUrl(share, asset.id, versionId, sprite.blobKey)
            : null,
        sprite_vtt:
          sprite && vttKey
            ? await publicMediaUrl(share, asset.id, versionId, vttKey)
            : null,
      });
    }
    return urls;
  };

  // Running time per asset, from the current version's probe. The stored
  // media_info keeps the probe's camelCase keys; older rows may carry snake.
  const durationsFor = async (
    shareAssets: PublicShareAsset[],
  ): Promise<Map<string, number>> => {
    const seconds = new Map<string, number>();
    const versionIds = shareAssets
      .map((asset) => asset.currentVersionId)
      .filter((id): id is string => Boolean(id));
    if (!versionIds.length) return seconds;
    const versions = (await env.db
      .select()
      .from(assetVersions)
      .where(inArray(assetVersions.id, versionIds))
      .all()) as Array<typeof assetVersions.$inferSelect>;
    const byVersion = new Map(versions.map((row) => [row.id, row]));
    for (const asset of shareAssets) {
      const version = asset.currentVersionId
        ? byVersion.get(asset.currentVersionId)
        : undefined;
      if (!version) continue;
      const info = parseJsonObject(version.mediaInfoJson);
      const frames = info.durationFrames ?? info.duration_frames;
      const num = info.frameRateNum ?? info.frame_rate_num;
      const den = info.frameRateDen ?? info.frame_rate_den;
      if (
        typeof frames === "number" &&
        frames > 0 &&
        typeof num === "number" &&
        num > 0 &&
        typeof den === "number" &&
        den > 0
      )
        seconds.set(asset.id, (frames * den) / num);
    }
    return seconds;
  };

  // The one client-safe asset projection for a share, used by both the
  // bootstrap and the assets list so the two cannot drift apart.
  const publicShareAssetsWire = async (
    share: typeof shares.$inferSelect,
    shareAssets: PublicShareAsset[],
  ) => {
    const [posters, seconds] = await Promise.all([
      posterUrlsFor(share, shareAssets),
      durationsFor(shareAssets),
    ]);
    return shareAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      status: asset.status,
      current_version_id: asset.currentVersionId,
      poster_url: posters.get(asset.id)?.poster ?? null,
      sprite_url: posters.get(asset.id)?.sprite ?? null,
      sprite_vtt_url: posters.get(asset.id)?.sprite_vtt ?? null,
      duration_seconds: seconds.get(asset.id) ?? null,
      sort_order: asset.sort_order,
    }));
  };

  // Client-safe projection of a publicShare result: raw share and viewer rows
  // are replaced by the public wire shapes and assets are reduced to the
  // fields a share client needs, so no internal columns reach the wire.
  const publicShareResponse = async (projection: {
    share: typeof shares.$inferSelect;
    viewer: typeof shareViewers.$inferSelect | undefined;
    assets: PublicShareAsset[];
  }) => ({
    share: publicShareWire(projection.share),
    viewer: projection.viewer ? publicViewerWire(projection.viewer) : null,
    assets: await publicShareAssetsWire(projection.share, projection.assets),
  });

  /* The share's logo, public by the slug's secrecy like the page itself:
     it draws on the access prompt, before any viewer exists. */
  api.get("/s/:slug/logo", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const key = logoKeyOf(share);
    if (!key || !env.blobStore) throw errors.notFound();
    const extension = key.split(".").pop() ?? "png";
    const contentType =
      Object.entries(LOGO_TYPES).find(([, ext]) => ext === extension)?.[0] ??
      "image/png";
    const stream = await env.blobStore.getStream(key);
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        /* A logo may be an SVG, and an SVG opened as a top-level document runs
           its own script -- so a manager could upload a scripted mark and lure
           a viewer to this public URL to run it in our origin. The sandbox
           directive (no allow-scripts) neutralises that on direct navigation
           while leaving <img> rendering, where SVG never executes, untouched.
           nosniff stops a mislabelled blob from being sniffed into HTML. */
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  /* The unfurl picture og.ts points crawlers at: the first asset's poster,
     public by the slug's secrecy. Passphrase-protected shares serve nothing;
     unfurls outlive chats, and the passphrase is what stands between them
     and the content. */
  api.get("/s/:slug/unfurl.png", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (share.passphraseHash !== null) throw errors.notFound();
    if (!env.blobStore) throw errors.notFound();
    const first = (
      await env.db
        .select({ assetId: shareAssets.assetId })
        .from(shareAssets)
        .where(eq(shareAssets.shareId, share.id))
        .orderBy(asc(shareAssets.sortOrder))
        .limit(1)
        .all()
    )[0];
    if (!first) throw errors.notFound();
    const asset = (
      await env.db
        .select({
          currentVersionId: assets.currentVersionId,
          thumbnailBlobKey: assets.thumbnailBlobKey,
        })
        .from(assets)
        .where(eq(assets.id, first.assetId))
        .limit(1)
        .all()
    )[0];
    if (!asset?.currentVersionId) throw errors.notFound();
    const poster = (
      await env.db
        .select({ blobKey: renditions.blobKey })
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, asset.currentVersionId),
            eq(renditions.kind, "poster"),
            isNull(renditions.shareId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    /* The chosen thumbnail is the picture of this share in every other
       surface; the link preview is not the place to disagree. */
    const key = asset.thumbnailBlobKey ?? poster?.blobKey;
    if (!key) throw errors.notFound();
    const stream = await env.blobStore.getStream(key);
    return new Response(stream, {
      headers: {
        "Content-Type": await blobContentType(key),
        "Cache-Control": "public, max-age=3600",
      },
    });
  });

  root.get("/s/:slug", async (c) =>
    c.json(
      await publicShareResponse(
        await publicShare(c, await shareBySlug(c.req.param("slug"))),
      ),
    ),
  );

  root.post("/s/:slug/access", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const ip = clientIp(c, env);
    await hitRateLimit(`share_access:${share.id}:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.shareAccess);
    if (
      share.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, share.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const viewer = await issueViewer(c, share, body.name, body.email);
    return c.json({
      share: publicShareWire(share),
      viewer_key: viewer.viewerKey,
    });
  });

  api.get("/s/:slug", async (c) =>
    c.json(
      await publicShareResponse(
        await publicShare(c, await shareBySlug(c.req.param("slug"))),
      ),
    ),
  );

  api.get("/s/:slug/assets", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    return c.json({
      items: await publicShareAssetsWire(projection.share, projection.assets),
    });
  });

  api.get("/s/:slug/assets/:assetId", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) => candidate.id === c.req.param("assetId"),
    );
    if (!asset) throw errors.notFound();
    const versions = await env.db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, asset.id))
      .orderBy(desc(assetVersions.versionNo))
      .all();
    const visibleVersions = projection.share.showAllVersions
      ? versions
      : versions.slice(0, 1);
    const share = projection.share;
    const watermarked = shareIsWatermarked(share);
    /* proxy_audio rides the same list: for an audio asset it is the whole
       ladder, and a room that can play a video source can play this one. */
    const proxyKinds = ["proxy_540", "proxy_1080", "proxy_2160", "proxy_audio"];
    const items = [];
    for (const version of visibleVersions) {
      const versionRenditions = await env.db
        .select()
        .from(renditions)
        .where(
          and(eq(renditions.versionId, version.id), isNull(renditions.shareId)),
        )
        .all();
      // Playable ladder with signed URLs, watermark-aware: a watermarked
      // share exposes only the burned rendition for the current spec hash
      // (currently 1080-based, so the ladder is that single rung); an
      // unwatermarked share exposes every proxy rung that exists.
      const sources: Array<{
        kind: string;
        url: string;
        size: number;
        height: number | null;
      }> = [];
      let watermarkState: "ready" | "processing" | null = null;
      const heightOf = (meta: Record<string, unknown>): number | null =>
        typeof meta.height === "number" ? meta.height : null;
      if (watermarked) {
        const burned = await watermarkedRenditionFor(share, version.id);
        watermarkState = burned ? "ready" : "processing";
        if (burned && env.blobStore)
          sources.push({
            kind: "watermarked",
            url: await publicMediaUrl(
              share,
              asset.id,
              version.id,
              burned.blobKey,
            ),
            size: burned.size,
            height: heightOf(parseJsonObject(burned.metaJson)),
          });
      } else if (env.blobStore) {
        for (const rendition of versionRenditions as Array<
          typeof renditions.$inferSelect
        >) {
          if (!proxyKinds.includes(rendition.kind)) continue;
          sources.push({
            kind: rendition.kind,
            url: await publicMediaUrl(
              share,
              asset.id,
              version.id,
              rendition.blobKey,
            ),
            size: rendition.size,
            height: heightOf(parseJsonObject(rendition.metaJson)),
          });
        }
      }
      // Sidecars are watermark-neutral (no footage pixels beyond thumbnails).
      const spriteRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "sprite");
      const peaksRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "audio_peaks");
      const waveformRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "waveform_data");
      const spectrogramRendition = (
        versionRenditions as Array<typeof renditions.$inferSelect>
      ).find((rendition) => rendition.kind === "spectrogram");
      const spriteMeta = spriteRendition
        ? parseJsonObject(spriteRendition.metaJson)
        : {};
      const vttKey =
        typeof spriteMeta.vtt_blob_key === "string"
          ? spriteMeta.vtt_blob_key
          : undefined;
      const sidecars = {
        sprite:
          spriteRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  spriteRendition.blobKey,
                ),
                vtt_url: vttKey
                  ? await publicMediaUrl(share, asset.id, version.id, vttKey)
                  : null,
              }
            : null,
        peaks:
          peaksRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  peaksRendition.blobKey,
                ),
              }
            : null,
        waveform:
          waveformRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  waveformRendition.blobKey,
                ),
                meta: parseJsonObject(waveformRendition.metaJson),
              }
            : null,
        spectrogram:
          spectrogramRendition && env.blobStore
            ? {
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  spectrogramRendition.blobKey,
                ),
              }
            : null,
        captions: env.blobStore
          ? await Promise.all(
              (
                (await env.db
                  .select()
                  .from(captionTracks)
                  .where(eq(captionTracks.versionId, version.id))
                  .orderBy(asc(captionTracks.language))
                  .all()) as Array<typeof captionTracks.$inferSelect>
              ).map(async (track) => ({
                language: track.language,
                label: track.label,
                url: await publicMediaUrl(
                  share,
                  asset.id,
                  version.id,
                  track.blobKey,
                ),
              })),
            )
          : [],
      };
      items.push({
        id: version.id,
        version_no: version.versionNo,
        media_info: parseJsonObject(version.mediaInfoJson),
        transcode_status: version.transcodeStatus,
        renditions: versionRenditions.map(
          (rendition: typeof renditions.$inferSelect) => ({
            id: rendition.id,
            kind: rendition.kind,
            meta: parseJsonObject(rendition.metaJson),
            size: rendition.size,
          }),
        ),
        sources,
        sidecars,
        watermark: watermarkState,
      });
    }
    return c.json({
      asset: {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        status: asset.status,
      },
      versions: items,
    });
  });

  api.get("/s/:slug/assets/:assetId/comments", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset || !asset.currentVersionId) throw errors.notFound();
    const rows = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, asset.currentVersionId),
          isNull(comments.deletedAt),
          eq(comments.internal, false),
        ),
      )
      .orderBy(asc(comments.frameIn), desc(comments.id))
      .all();
    const attached = await attachmentsFor(
      rows.map((comment: typeof comments.$inferSelect) => comment.id),
    );
    return c.json({
      items: rows.map((comment: typeof comments.$inferSelect) => ({
        ...publicCommentWire(comment),
        attachments: attached.get(comment.id) ?? [],
        /* Whether this viewer wrote it: the room shows Edit and Delete only
           where the server would allow them. The key itself never leaves. */
        mine:
          comment.viewerKey !== null &&
          comment.viewerKey === projection.viewer?.viewerKey,
      })),
    });
  });

  api.post("/s/:slug/assets/:assetId/comments", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    const ip = clientIp(c, env);
    await hitRateLimit(`share_comment:${share.id}:${ip}`, 30, 5 * 60 * 1000);
    const projection = await publicShare(c, share);
    if (!projection.viewer || !projection.viewer.viewerKey)
      throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset || !asset.currentVersionId) throw errors.notFound();
    const body = await jsonBody(c, bodies.shareCommentCreate);
    validateCommentAnchor(body);
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: asset.currentVersionId,
        parentId: null,
        authorUserId: null,
        authorName: projection.viewer.name,
        authorEmail: projection.viewer.email,
        viewerKey: projection.viewer.viewerKey,
        frameIn: body.frame_in ?? null,
        frameOut: body.frame_out ?? null,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson: null,
        pageNo: null,
        internal: false,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: now,
        editedAt: null,
      })
      .run();
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!comment) throw errors.internal();
    // Share-viewer comments notify the same recipients as member comments;
    // the actor fields come from the named viewer (who has no user id, so
    // there is no self to exclude).
    const commentedVersion = (
      await env.db
        .select({ uploadedBy: assetVersions.uploadedBy })
        .from(assetVersions)
        .where(eq(assetVersions.id, asset.currentVersionId))
        .limit(1)
        .all()
    )[0];
    await createNotifications({
      projectId: share.projectId,
      actorUserId: null,
      recipients: [
        commentedVersion?.uploadedBy,
        ...(await projectManagerIds(share.projectId)),
      ],
      kind: "comment.created",
      payload: {
        project_id: share.projectId,
        asset_id: asset.id,
        asset_name: asset.name,
        version_id: asset.currentVersionId,
        comment_id: id,
        actor_name:
          projection.viewer.name ?? projection.viewer.email ?? "Share viewer",
        preview: notificationPreview(body.body_text.trim()),
      },
    });
    // Share-viewer comments feed the same live stream as member comments.
    await appendProjectEvent(share.projectId, "comment.created", {
      comment_id: id,
      version_id: asset.currentVersionId,
      frame_in: comment.frameIn,
    });
    return c.json(publicCommentWire(comment), 201);
  });

  const shareCommentForViewer = async (
    c: Context<{ Variables: Variables }>,
    slug: string,
    commentId: string,
  ) => {
    const share = await shareBySlug(slug);
    const projection = await publicShare(c, share);
    if (!projection.viewer) throw errors.unauthorized();
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(and(eq(comments.id, commentId), isNull(comments.deletedAt)))
        .limit(1)
        .all()
    )[0];
    if (!comment || comment.viewerKey !== projection.viewer.viewerKey)
      throw errors.forbidden(
        "Only the comment author can change this share comment.",
      );
    return { share, projection, comment };
  };

  api.patch("/s/:slug/comments/:commentId", async (c) => {
    const { share, comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    const body = await jsonBody(c, bodies.shareCommentPatch);
    validateCommentAnchor(body);
    await env.db
      .update(comments)
      .set({
        bodyText: body.body_text.trim(),
        ...(body.annotation === undefined
          ? {}
          : { annotationJson: JSON.stringify(body.annotation) }),
        editedAt: env.clock.now(),
      })
      .where(eq(comments.id, comment.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await appendProjectEvent(share.projectId, "comment.updated", {
      comment_id: updated.id,
      version_id: updated.versionId,
      frame_in: updated.frameIn,
    });
    return c.json(publicCommentWire(updated));
  });

  api.delete("/s/:slug/comments/:commentId", async (c) => {
    const { share, comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    await deleteAttachmentsForComment(comment.id);
    await env.db
      .update(comments)
      .set({ deletedAt: env.clock.now() })
      .where(eq(comments.id, comment.id))
      .run();
    await appendProjectEvent(share.projectId, "comment.deleted", {
      comment_id: comment.id,
      version_id: comment.versionId,
    });
    return c.body(null, 204);
  });

  /* A viewer's files on their own note: same ownership rule as editing it,
     same cap and shape as the internal attachment route. */
  api.post("/s/:slug/comments/:commentId/attachments", async (c) => {
    const { share, projection, comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    await hitRateLimit(
      `share_attachment:${share.id}:${projection.viewer?.viewerKey ?? clientIp(c, env)}`,
      20,
      60 * 60 * 1000,
    );
    const project = (
      await env.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, share.projectId))
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.notFound();
    return c.json(
      await storeCommentAttachment(
        comment,
        project.workspaceId,
        await attachmentFileFrom(c),
      ),
      201,
    );
  });

  /* Any viewer of the share can open a visible note's files: visibility is
     the share's own comment rule (current version, never internal), and the
     URL is share-scoped and short-lived like every other media link here. */
  api.get(
    "/s/:slug/comments/:commentId/attachments/:attachmentId",
    async (c) => {
      const projection = await publicShare(
        c,
        await shareBySlug(c.req.param("slug")),
      );
      if (!projection.viewer) throw errors.unauthorized();
      const comment = (
        await env.db
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, c.req.param("commentId")),
              isNull(comments.deletedAt),
              eq(comments.internal, false),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!comment) throw errors.notFound();
      const asset = projection.assets.find(
        (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
          candidate.currentVersionId === comment.versionId,
      );
      if (!asset) throw errors.notFound();
      const attachment = (
        await env.db
          .select()
          .from(commentAttachments)
          .where(
            and(
              eq(commentAttachments.id, c.req.param("attachmentId")),
              eq(commentAttachments.commentId, comment.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!attachment || !env.blobStore) throw errors.notFound();
      return c.json({
        url: await publicMediaUrl(
          projection.share,
          asset.id,
          comment.versionId,
          attachment.blobKey,
          attachmentDisposition(attachment.filename),
        ),
        expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
      });
    },
  );

  api.delete(
    "/s/:slug/comments/:commentId/attachments/:attachmentId",
    async (c) => {
      const { comment } = await shareCommentForViewer(
        c,
        c.req.param("slug"),
        c.req.param("commentId"),
      );
      const attachment = (
        await env.db
          .select()
          .from(commentAttachments)
          .where(
            and(
              eq(commentAttachments.id, c.req.param("attachmentId")),
              eq(commentAttachments.commentId, comment.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!attachment) throw errors.notFound();
      await deleteBlobQuietly(attachment.blobKey);
      await env.db
        .delete(commentAttachments)
        .where(eq(commentAttachments.id, attachment.id))
        .run();
      return c.body(null, 204);
    },
  );

  api.post("/s/:slug/comments/:commentId/replies", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    const projection = await publicShare(c, share);
    if (!projection.viewer) throw errors.unauthorized();
    await hitRateLimit(
      `share_comment:${share.id}:${clientIp(c, env)}`,
      30,
      5 * 60 * 1000,
    );
    const parent = (
      await env.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.id, c.req.param("commentId")),
            isNull(comments.deletedAt),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!parent) throw errors.notFound("Comment was not found.");
    // The parent must be a comment this share exposes: on the current
    // version of one of the shared assets and not internal. Without this
    // check a share viewer could reply to any comment in the database.
    const parentAsset = projection.assets.find(
      (candidate: PublicShareAsset) =>
        candidate.currentVersionId === parent.versionId,
    );
    if (!parentAsset || parent.internal)
      throw errors.notFound("Comment was not found.");
    if (parent.parentId) throw errors.validation("Replies cannot be nested.");
    const body = await jsonBody(c, bodies.shareReplyCreate);
    validateCommentAnchor(body);
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: parent.versionId,
        parentId: parent.id,
        authorUserId: null,
        authorName: projection.viewer.name,
        authorEmail: projection.viewer.email,
        viewerKey: projection.viewer.viewerKey,
        frameIn: parent.frameIn,
        frameOut: parent.frameOut,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson: null,
        pageNo: null,
        internal: false,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: env.clock.now(),
        editedAt: null,
      })
      .run();
    const reply = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!reply) throw errors.internal();
    // Share-viewer replies notify the registered-user thread participants;
    // the actor is a viewer without a user id, so no self-exclusion applies.
    await createNotifications({
      projectId: share.projectId,
      actorUserId: null,
      recipients: await threadParticipantIds(parent.id),
      kind: "comment.reply",
      payload: {
        project_id: share.projectId,
        asset_id: parentAsset.id,
        asset_name: parentAsset.name,
        version_id: parent.versionId,
        comment_id: id,
        parent_comment_id: parent.id,
        actor_name:
          projection.viewer.name ?? projection.viewer.email ?? "Share viewer",
        preview: notificationPreview(body.body_text.trim()),
      },
    });
    await appendProjectEvent(share.projectId, "comment.created", {
      comment_id: id,
      version_id: parent.versionId,
      frame_in: parent.frameIn,
      parent_id: parent.id,
    });
    return c.json(publicCommentWire(reply), 201);
  });

  api.patch("/s/:slug/approval", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowApprovals)
      throw errors.forbidden("This share does not take approval decisions.");
    const projection = await publicShare(c, share);
    if (!projection.viewer) throw errors.unauthorized();
    await hitRateLimit(
      `share_approval:${share.id}:${clientIp(c, env)}`,
      30,
      5 * 60 * 1000,
    );
    const body = await jsonBody(c, bodies.shareApprovalPatch);
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) => candidate.id === body.asset_id,
    );
    if (!asset) throw errors.notFound();
    const changed = await env.db
      .update(assets)
      .set({ status: body.status, updatedAt: env.clock.now() })
      .where(and(eq(assets.id, asset.id), ne(assets.status, body.status)))
      .returning({ id: assets.id })
      .all();
    if (!changed.length)
      return c.json({ asset_id: asset.id, status: body.status });
    await notifyApprovalChange({
      asset,
      status: body.status,
      actorUserId: null,
      actorName:
        projection.viewer.name ?? projection.viewer.email ?? "Share viewer",
    });
    return c.json({ asset_id: asset.id, status: body.status });
  });

  api.get("/s/:slug/assets/:assetId/media", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset?.currentVersionId || !env.blobStore) throw errors.notFound();
    const share = projection.share;
    if (shareIsWatermarked(share)) {
      // Watermarked shares serve ONLY the burned rendition registered for
      // this share under the current spec hash. While it is missing (still
      // rendering, or the spec just changed) the response is 202
      // {status: "processing"}; the clean proxy is never a fallback.
      const watermarked = await watermarkedRenditionFor(
        share,
        asset.currentVersionId,
      );
      if (!watermarked) return c.json({ status: "processing" }, 202);
      return c.json({
        url: await publicMediaUrl(
          share,
          asset.id,
          asset.currentVersionId,
          watermarked.blobKey,
        ),
        expires_at: env.clock.now() + 15 * 60 * 1000,
      });
    }
    /* Video serves the review proxy; a still has no proxy and serves its
       full-resolution tile instead — without this, image assets in a share
       answered 404 forever. Audio serves its own proxy for the same reason:
       the original may be a 24-bit WAV no browser will play. */
    const renditionRows = (await env.db
      .select()
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, asset.currentVersionId),
          inArray(renditions.kind, [
            "proxy_1080",
            "proxy_audio",
            "still_tiles",
          ]),
          isNull(renditions.shareId),
        ),
      )
      .all()) as Array<typeof renditions.$inferSelect>;
    /* Preference by asset kind, not by a fixed order: an audio asset must
       never be handed a still, and a video whose peaks landed first must not
       be handed anything but its proxy. */
    const preferredKind =
      asset.kind === "audio"
        ? "proxy_audio"
        : asset.kind === "image"
          ? "still_tiles"
          : "proxy_1080";
    const rendition =
      renditionRows.find((row) => row.kind === preferredKind) ??
      renditionRows[0];
    if (!rendition) throw errors.notFound("A review rendition is not ready.");
    return c.json({
      url: await publicMediaUrl(
        share,
        asset.id,
        asset.currentVersionId,
        rendition.blobKey,
      ),
      expires_at: env.clock.now() + 15 * 60 * 1000,
    });
  });

  // Share downloads, gated by allow_download. A watermarked share never
  // hands out the clean file in ANY mode: both proxy and original resolve to
  // the burned rendition (202 while it is still rendering).
  api.get("/s/:slug/assets/:assetId/download", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) => candidate.id === c.req.param("assetId"),
    );
    if (!asset) throw errors.notFound();
    const share = projection.share;
    // The policy answer precedes any storage dependency: disabled downloads
    // are 403 even when no rendition or blob store exists yet.
    if (share.allowDownload === "none")
      throw errors.forbidden("Downloads are disabled for this share.");
    if (!asset.currentVersionId || !env.blobStore) throw errors.notFound();
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, asset.currentVersionId))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound();
    const baseName =
      version.originalFilename.replace(/\.[^.]+$/, "") || "download";
    const expiresAt = env.clock.now() + DOWNLOAD_TOKEN_TTL_MS;
    if (shareIsWatermarked(share)) {
      const watermarked = await watermarkedRenditionFor(share, version.id);
      if (!watermarked) return c.json({ status: "processing" }, 202);
      return c.json({
        url: await publicMediaUrl(
          share,
          asset.id,
          version.id,
          watermarked.blobKey,
          attachmentDisposition(`${baseName}-watermarked.mp4`),
        ),
        expires_at: expiresAt,
      });
    }
    /* A proxy-only share hands out the review file for anything that has
       one. Stills and documents have no lesser form, so they hand out the
       original -- the same rule the zip bundle keeps, which this endpoint
       used not to: an image in a proxy share answered "not ready" forever
       because it was looked up as a 1080 video proxy. */
    const proxyKindForDownload =
      asset.kind === "video"
        ? "proxy_1080"
        : asset.kind === "audio"
          ? "proxy_audio"
          : null;
    if (share.allowDownload === "proxy" && proxyKindForDownload) {
      const proxy = (
        await env.db
          .select()
          .from(renditions)
          .where(
            and(
              eq(renditions.versionId, version.id),
              eq(renditions.kind, proxyKindForDownload),
              isNull(renditions.shareId),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!proxy) throw errors.notFound("A review rendition is not ready.");
      return c.json({
        url: await publicMediaUrl(
          share,
          asset.id,
          version.id,
          proxy.blobKey,
          attachmentDisposition(
            `${baseName}-proxy.${proxy.kind === "proxy_audio" ? "m4a" : "mp4"}`,
          ),
        ),
        expires_at: expiresAt,
      });
    }
    return c.json({
      url: await publicMediaUrl(
        share,
        asset.id,
        version.id,
        version.originalBlobKey,
        attachmentDisposition(version.originalFilename),
      ),
      expires_at: expiresAt,
    });
  });

  api.get("/s/:slug/assets/:assetId/media/file", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const token = c.req.query("token");
    if (!token || !env.blobStore) throw errors.unauthorized();
    let blobKey: string;
    let disposition: string | undefined;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.share_id !== share.id ||
        verified.payload.asset_id !== c.req.param("assetId") ||
        typeof verified.payload.blob_key !== "string"
      )
        throw new Error("Token claims do not match this share asset.");
      blobKey = verified.payload.blob_key;
      // Downloads carry an attachment disposition in the verified claim;
      // it is sanitized again before reaching the header.
      if (typeof verified.payload.disposition === "string")
        disposition = sanitizeDisposition(verified.payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    return serveBlob(c, blobKey, disposition);
  });

  /* ------------------------------ Transfers ------------------------------
     Links that move files in and out of a project without a seat. A package
     sends existing assets to someone; a request receives files from someone,
     landing them as assets through the same multipart engine, checksum
     verification, and probe pipeline members use. */

  /* A package hands out originals, so it takes the same authority a share
     with original downloads takes; a request only adds files, like an
     editor. */
  const transferRoleFor = (kind: "package" | "request") =>
    kind === "package" ? ("manager" as const) : ("editor" as const);

  type TransferCounts = {
    itemCount: number;
    receivedCount: number;
    receivedBytes: number;
  };

  const transferCountsFor = async (
    transferIds: string[],
  ): Promise<Map<string, TransferCounts>> => {
    const counts = new Map<string, TransferCounts>();
    if (!transferIds.length) return counts;
    for (const id of transferIds)
      counts.set(id, { itemCount: 0, receivedCount: 0, receivedBytes: 0 });
    const itemRows = await env.db
      .select({
        transferId: transferItems.transferId,
        total: sql<number>`count(*)`,
      })
      .from(transferItems)
      .where(inArray(transferItems.transferId, transferIds))
      .groupBy(transferItems.transferId)
      .all();
    for (const row of itemRows) {
      const entry = counts.get(row.transferId);
      if (entry) entry.itemCount = Number(row.total);
    }
    const receiptRows = await env.db
      .select({
        transferId: transferReceipts.transferId,
        size: uploadSessions.size,
        status: uploadSessions.status,
      })
      .from(transferReceipts)
      .innerJoin(
        uploadSessions,
        eq(transferReceipts.uploadSessionId, uploadSessions.id),
      )
      .where(inArray(transferReceipts.transferId, transferIds))
      .all();
    for (const row of receiptRows) {
      const entry = counts.get(row.transferId);
      if (!entry || row.status === "aborted" || row.status === "quarantined")
        continue;
      // In-flight bytes count toward the cap; the count is finished files.
      entry.receivedBytes += row.size;
      if (row.status === "completed") entry.receivedCount += 1;
    }
    return counts;
  };

  const transferWire = (
    row: typeof transfers.$inferSelect,
    counts?: TransferCounts,
  ) => ({
    id: row.id,
    project_id: row.projectId,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    message: row.message,
    has_passphrase: row.passphraseHash !== null,
    expires_at: row.expiresAt,
    byte_cap: row.byteCap,
    folder_id: row.folderId,
    created_by: row.createdBy,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
    item_count: counts?.itemCount ?? 0,
    received_count: counts?.receivedCount ?? 0,
    received_bytes: counts?.receivedBytes ?? 0,
  });

  const transferById = async (id: string) => {
    const row = (
      await env.db
        .select()
        .from(transfers)
        .where(eq(transfers.id, id))
        .limit(1)
        .all()
    )[0];
    if (!row) throw errors.notFound("Transfer was not found.");
    return row;
  };

  /** The destination folder must be a live assets folder of the project. */
  const requireDestinationFolder = async (
    projectId: string,
    folderId: string,
  ): Promise<void> => {
    const folder = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, folderId))
        .limit(1)
        .all()
    )[0];
    if (!folder || folder.projectId !== projectId || folder.kind !== "assets")
      throw errors.validation(
        "The destination folder must belong to the project.",
      );
  };

  api.post("/transfers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.transferCreate);
    await requireProject(body.project_id, actor, transferRoleFor(body.kind));
    if (body.kind === "package" && !body.asset_ids.length)
      throw errors.validation("A package needs at least one file.");
    if (body.kind === "request" && body.asset_ids.length)
      throw errors.validation("A request link does not carry files.");
    if (body.asset_ids.length) {
      const allowedAssets = await env.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(eq(assets.projectId, body.project_id), isNull(assets.deletedAt)),
        )
        .all();
      const allowed = new Set(
        allowedAssets.map((asset: { id: string }) => asset.id),
      );
      if (body.asset_ids.some((id) => !allowed.has(id)))
        throw errors.validation(
          "Every packaged file must belong to the project.",
        );
    }
    if (body.folder_id)
      await requireDestinationFolder(body.project_id, body.folder_id);
    const id = env.ids.ulid();
    const readable = body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
    const slug = readable ? `${readable}-${base62(14)}` : base62(22);
    const now = env.clock.now();
    await env.db
      .insert(transfers)
      .values({
        id,
        projectId: body.project_id,
        kind: body.kind,
        slug,
        title: body.title.trim(),
        message: body.message,
        passphraseHash: body.passphrase
          ? await env.hasher.hash(body.passphrase)
          : null,
        expiresAt: body.expires_at ?? null,
        byteCap:
          body.kind === "request"
            ? (body.byte_cap ?? DEFAULT_TRANSFER_REQUEST_BYTE_CAP)
            : null,
        folderId: body.kind === "request" ? (body.folder_id ?? null) : null,
        createdBy: actor.id,
        revokedAt: null,
        createdAt: now,
      })
      .run();
    for (const [index, assetId] of body.asset_ids.entries())
      await env.db
        .insert(transferItems)
        .values({ transferId: id, assetId, sortOrder: index })
        .run();
    await appendProjectEvent(body.project_id, "transfer.created", {
      transfer_id: id,
      kind: body.kind,
    });
    const row = await transferById(id);
    const counts = (await transferCountsFor([id])).get(id);
    return c.json(
      {
        transfer: transferWire(row, counts),
        url: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/t/${slug}`,
      },
      201,
    );
  });

  api.get("/transfers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.query("project_id");
    if (projectId) await requireProject(projectId, actor, "viewer");
    const rows = await env.db
      .select()
      .from(transfers)
      .innerJoin(projects, eq(transfers.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          projectId ? eq(transfers.projectId, projectId) : undefined,
        ),
      )
      .orderBy(desc(transfers.id))
      .all();
    const list = rows.map(
      (row: { transfers: typeof transfers.$inferSelect }) => row.transfers,
    );
    const counts = await transferCountsFor(
      list.map((row: typeof transfers.$inferSelect) => row.id),
    );
    return c.json({
      items: list.map((row: typeof transfers.$inferSelect) =>
        transferWire(row, counts.get(row.id)),
      ),
    });
  });

  api.get("/transfers/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(transfer.projectId, actor, "viewer");
    const itemRows = await env.db
      .select({
        link: transferItems,
        asset: assets,
        version: assetVersions,
      })
      .from(transferItems)
      .innerJoin(assets, eq(transferItems.assetId, assets.id))
      .leftJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(asc(transferItems.sortOrder))
      .all();
    const receiptRows = await env.db
      .select({ receipt: transferReceipts, upload: uploadSessions })
      .from(transferReceipts)
      .innerJoin(
        uploadSessions,
        eq(transferReceipts.uploadSessionId, uploadSessions.id),
      )
      .where(eq(transferReceipts.transferId, transfer.id))
      .orderBy(asc(transferReceipts.id))
      .all();
    const counts = (await transferCountsFor([transfer.id])).get(transfer.id);
    return c.json({
      ...transferWire(transfer, counts),
      items: itemRows.map(
        (row: {
          link: typeof transferItems.$inferSelect;
          asset: typeof assets.$inferSelect;
          version: typeof assetVersions.$inferSelect | null;
        }) => ({
          asset_id: row.asset.id,
          name: row.asset.name,
          kind: row.asset.kind,
          size: row.version?.size ?? null,
          sort_order: row.link.sortOrder,
        }),
      ),
      receipts: receiptRows.map(
        (row: {
          receipt: typeof transferReceipts.$inferSelect;
          upload: typeof uploadSessions.$inferSelect;
        }) => ({
          id: row.receipt.id,
          sender_name: row.receipt.senderName,
          filename: row.upload.clientFilename,
          size: row.upload.size,
          status: row.upload.status,
          asset_id: row.receipt.assetId,
          created_at: row.receipt.createdAt,
        }),
      ),
    });
  });

  api.patch("/transfers/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(
      transfer.projectId,
      actor,
      transferRoleFor(transfer.kind),
    );
    const body = await jsonBody(c, bodies.transferPatch);
    if (body.folder_id)
      await requireDestinationFolder(transfer.projectId, body.folder_id);
    await env.db
      .update(transfers)
      .set({
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.message !== undefined ? { message: body.message } : {}),
        ...(body.passphrase !== undefined
          ? {
              passphraseHash: body.passphrase
                ? await env.hasher.hash(body.passphrase)
                : null,
            }
          : {}),
        ...(body.expires_at !== undefined
          ? { expiresAt: body.expires_at }
          : {}),
        ...(body.byte_cap !== undefined && transfer.kind === "request"
          ? {
              byteCap: body.byte_cap ?? DEFAULT_TRANSFER_REQUEST_BYTE_CAP,
            }
          : {}),
        ...(body.folder_id !== undefined && transfer.kind === "request"
          ? { folderId: body.folder_id }
          : {}),
        ...(body.revoked !== undefined
          ? { revokedAt: body.revoked ? env.clock.now() : null }
          : {}),
      })
      .where(eq(transfers.id, transfer.id))
      .run();
    const updated = await transferById(transfer.id);
    const counts = (await transferCountsFor([transfer.id])).get(transfer.id);
    return c.json(transferWire(updated, counts));
  });

  api.delete("/transfers/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(
      transfer.projectId,
      actor,
      transferRoleFor(transfer.kind),
    );
    await env.db.delete(transfers).where(eq(transfers.id, transfer.id)).run();
    return c.body(null, 204);
  });

  /* The access record is the owner's, not the room's: a viewer on the project
     can see that a transfer exists, but who opened it and what they took is
     for whoever is answerable for the link. */
  const requireTransferAudit = async (
    c: Context<{ Variables: Variables }>,
    id: string,
  ): Promise<typeof transfers.$inferSelect> => {
    const actor = userFromContext(c);
    const transfer = await transferById(id);
    await requireProject(
      transfer.projectId,
      actor,
      transferRoleFor(transfer.kind),
    );
    return transfer;
  };

  api.get("/transfers/:id/visits", requireAuth, async (c) => {
    const transfer = await requireTransferAudit(c, c.req.param("id"));
    const visitRows = await env.db
      .select()
      .from(transferVisits)
      .where(eq(transferVisits.transferId, transfer.id))
      .orderBy(desc(transferVisits.id))
      .all();
    const downloadRows = await env.db
      .select({ visitId: transferDownloads.visitId })
      .from(transferDownloads)
      .where(eq(transferDownloads.transferId, transfer.id))
      .all();
    const takenBy = new Map<string, number>();
    for (const row of downloadRows)
      if (row.visitId)
        takenBy.set(row.visitId, (takenBy.get(row.visitId) ?? 0) + 1);
    return c.json({
      items: visitRows.map((visit) => ({
        id: visit.id,
        name: visit.name,
        first_seen_at: visit.firstSeenAt,
        last_seen_at: visit.lastSeenAt,
        user_agent: visit.userAgent,
        ip: visit.ip,
        download_count: takenBy.get(visit.id) ?? 0,
      })),
    });
  });

  api.get("/transfers/:id/downloads", requireAuth, async (c) => {
    const transfer = await requireTransferAudit(c, c.req.param("id"));
    const rows = await env.db
      .select()
      .from(transferDownloads)
      .where(eq(transferDownloads.transferId, transfer.id))
      .orderBy(desc(transferDownloads.id))
      .all();
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        visit_id: row.visitId,
        name: row.name,
        asset_id: row.assetId,
        filename: row.filename,
        kind: row.kind,
        bytes: row.bytes,
        user_agent: row.userAgent,
        ip: row.ip,
        created_at: row.createdAt,
      })),
    });
  });

  api.post("/transfers/:id/items", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    if (transfer.kind !== "package")
      throw errors.validation("Only a package carries files.");
    await requireProject(transfer.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.transferItemsAdd);
    const allowedAssets = await env.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(eq(assets.projectId, transfer.projectId), isNull(assets.deletedAt)),
      )
      .all();
    const allowed = new Set(
      allowedAssets.map((asset: { id: string }) => asset.id),
    );
    if (body.asset_ids.some((id) => !allowed.has(id)))
      throw errors.validation(
        "Every packaged file must belong to the project.",
      );
    const existing = await env.db
      .select({
        assetId: transferItems.assetId,
        sortOrder: transferItems.sortOrder,
      })
      .from(transferItems)
      .where(eq(transferItems.transferId, transfer.id))
      .all();
    const present = new Set(
      existing.map((row: { assetId: string }) => row.assetId),
    );
    let next =
      existing.reduce(
        (max: number, row: { sortOrder: number }) =>
          Math.max(max, row.sortOrder),
        -1,
      ) + 1;
    let added = 0;
    for (const assetId of body.asset_ids) {
      if (present.has(assetId)) continue;
      await env.db
        .insert(transferItems)
        .values({ transferId: transfer.id, assetId, sortOrder: next })
        .run();
      present.add(assetId);
      next += 1;
      added += 1;
    }
    const counts = (await transferCountsFor([transfer.id])).get(transfer.id);
    return c.json({ transfer: transferWire(transfer, counts), added });
  });

  api.delete("/transfers/:id/items/:assetId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(transfer.projectId, actor, "manager");
    await env.db
      .delete(transferItems)
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          eq(transferItems.assetId, c.req.param("assetId")),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  /* ------------------------- Transfers, public ------------------------- */

  const liveTransferBySlug = async (slug: string) => {
    const row = (
      await env.db
        .select()
        .from(transfers)
        .where(eq(transfers.slug, slug))
        .limit(1)
        .all()
    )[0];
    if (
      !row ||
      row.revokedAt ||
      (row.expiresAt !== null && row.expiresAt <= env.clock.now())
    )
      throw errors.notFound("Transfer is unavailable.");
    return row;
  };

  const transferCookie = (transferId: string): string =>
    `ol_transfer_${transferId}`;

  /**
   * Whether this transfer's project records the addresses of the people who
   * use its links. Off unless the project turns it on: a link handed to a
   * client should not start logging IPs because the software felt like it.
   */
  const projectRecordsIps = async (projectId: string): Promise<boolean> => {
    const project = (
      await env.db
        .select({ settingsJson: projects.settingsJson })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all()
    )[0];
    return parseJsonObject(project?.settingsJson).record_transfer_ips === true;
  };

  const issueTransferGrant = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
    name: string,
  ): Promise<void> => {
    /* The grant carries an unguessable key rather than only a name, so the
       visit it belongs to can be found again on every later request. The name
       stays in the token too: an old cookie issued before this table existed
       still identifies its holder, it just has no visit to update. */
    const grantKey = base64UrlEncode(randomBytes(18));
    const now = env.clock.now();
    await env.db
      .insert(transferVisits)
      .values({
        id: env.ids.ulid(),
        transferId: transfer.id,
        grantKey,
        name,
        userAgent: c.req.header("user-agent") ?? null,
        ip: (await projectRecordsIps(transfer.projectId))
          ? clientIp(c, env)
          : null,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    const signed = await new SignJWT({
      transfer_id: transfer.id,
      name,
      grant_key: grantKey,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    setCookie(c, transferCookie(transfer.id), signed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: env.config.cookieSecure,
      maxAge: 86_400,
      path: "/",
    });
  };

  const transferGrantFor = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
  ): Promise<{ name: string; visitId: string | null } | undefined> => {
    const signed = getCookie(c, transferCookie(transfer.id));
    if (!signed) return undefined;
    try {
      const verified = await jwtVerify(
        signed,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.transfer_id !== transfer.id ||
        typeof verified.payload.name !== "string"
      )
        return undefined;
      const grantKey =
        typeof verified.payload.grant_key === "string"
          ? verified.payload.grant_key
          : null;
      if (!grantKey) return { name: verified.payload.name, visitId: null };
      const visit = (
        await env.db
          .select()
          .from(transferVisits)
          .where(
            and(
              eq(transferVisits.transferId, transfer.id),
              eq(transferVisits.grantKey, grantKey),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!visit) return { name: verified.payload.name, visitId: null };
      const now = env.clock.now();
      if (visit.lastSeenAt <= now - PRESENCE_WRITE_INTERVAL_MS)
        await env.db
          .update(transferVisits)
          .set({ lastSeenAt: now })
          .where(
            and(
              eq(transferVisits.id, visit.id),
              lt(
                transferVisits.lastSeenAt,
                now - PRESENCE_WRITE_INTERVAL_MS + 1,
              ),
            ),
          )
          .run();
      return { name: visit.name, visitId: visit.id };
    } catch {
      return undefined;
    }
  };

  const requireTransferGrant = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
  ): Promise<{ name: string; visitId: string | null }> => {
    const grant = await transferGrantFor(c, transfer);
    if (!grant) throw errors.unauthorized();
    return grant;
  };

  /**
   * Record a file or an archive leaving. The filename is copied in rather than
   * joined out later: the record has to outlive the asset it names.
   */
  const recordTransferDownload = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
    grant: { name: string; visitId: string | null },
    entry: {
      kind: "file" | "zip";
      assetId?: string | null;
      filename?: string | null;
      bytes?: number;
    },
  ): Promise<void> => {
    await env.db
      .insert(transferDownloads)
      .values({
        id: env.ids.ulid(),
        transferId: transfer.id,
        visitId: grant.visitId,
        name: grant.name,
        assetId: entry.assetId ?? null,
        filename: entry.filename ?? "",
        kind: entry.kind,
        bytes: entry.bytes ?? 0,
        userAgent: c.req.header("user-agent") ?? null,
        ip: (await projectRecordsIps(transfer.projectId))
          ? clientIp(c, env)
          : null,
        createdAt: env.clock.now(),
      })
      .run();
  };

  const receivedBytesFor = async (transferId: string): Promise<number> =>
    (await transferCountsFor([transferId])).get(transferId)?.receivedBytes ?? 0;

  interface PackageFile {
    asset_id: string;
    name: string;
    kind: "video" | "audio" | "image" | "pdf" | "file";
    size: number | null;
    checksum_crc32c: string | null;
    version: typeof assetVersions.$inferSelect | null;
  }

  const packageFilesFor = async (
    transfer: typeof transfers.$inferSelect,
  ): Promise<PackageFile[]> => {
    const rows = await env.db
      .select({ link: transferItems, asset: assets, version: assetVersions })
      .from(transferItems)
      .innerJoin(assets, eq(transferItems.assetId, assets.id))
      .leftJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(asc(transferItems.sortOrder))
      .all();
    return rows.map(
      (row: {
        link: typeof transferItems.$inferSelect;
        asset: typeof assets.$inferSelect;
        version: typeof assetVersions.$inferSelect | null;
      }) => ({
        asset_id: row.asset.id,
        name: row.asset.name,
        kind: row.asset.kind,
        size: row.version?.size ?? null,
        checksum_crc32c: row.version?.checksumCrc32c || null,
        version: row.version,
      }),
    );
  };

  const publicTransferWire = (
    transfer: typeof transfers.$inferSelect,
    receivedBytes: number,
  ) => ({
    slug: transfer.slug,
    kind: transfer.kind,
    title: transfer.title,
    message: transfer.message,
    requires_passphrase: transfer.passphraseHash !== null,
    expires_at: transfer.expiresAt,
    byte_cap: transfer.byteCap,
    received_bytes: receivedBytes,
  });

  const publicTransferShell = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
    grantOverride?: { name: string },
  ) => {
    const grant = grantOverride ?? (await transferGrantFor(c, transfer));
    const authorized = grant !== undefined;
    const files =
      authorized && transfer.kind === "package"
        ? (await packageFilesFor(transfer)).map((file) => ({
            asset_id: file.asset_id,
            name: file.name,
            kind: file.kind,
            size: file.size,
            checksum_crc32c: file.checksum_crc32c,
          }))
        : [];
    const receivedBytes =
      transfer.kind === "request" ? await receivedBytesFor(transfer.id) : 0;
    return {
      transfer: publicTransferWire(transfer, receivedBytes),
      authorized,
      files,
    };
  };

  api.get("/t/:slug", async (c) =>
    c.json(
      await publicTransferShell(
        c,
        await liveTransferBySlug(c.req.param("slug")),
      ),
    ),
  );

  api.post("/t/:slug/access", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    const ip = clientIp(c, env);
    await hitRateLimit(
      `transfer_access:${transfer.id}:${ip}`,
      20,
      5 * 60 * 1000,
    );
    const body = await jsonBody(c, bodies.transferAccess);
    if (
      transfer.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, transfer.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const name = body.name.trim();
    await issueTransferGrant(c, transfer, name);
    return c.json(await publicTransferShell(c, transfer, { name }));
  });

  const notifyTransferDownloaded = async (
    transfer: typeof transfers.$inferSelect,
    name: string,
    file: string | null,
  ): Promise<void> => {
    await createNotifications({
      projectId: transfer.projectId,
      actorUserId: null,
      recipients: [transfer.createdBy],
      kind: "transfer.downloaded",
      payload: {
        transfer_id: transfer.id,
        transfer_title: transfer.title,
        project_id: transfer.projectId,
        name,
        file,
      },
    });
    await appendProjectEvent(transfer.projectId, "transfer.downloaded", {
      transfer_id: transfer.id,
      name,
      file,
    });
  };

  api.post("/t/:slug/files/:assetId/download", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    if (transfer.kind !== "package") throw errors.notFound();
    const grant = await requireTransferGrant(c, transfer);
    const file = (await packageFilesFor(transfer)).find(
      (candidate) => candidate.asset_id === c.req.param("assetId"),
    );
    if (!file || !file.version) throw errors.notFound();
    const token = await new SignJWT({
      transfer_id: transfer.id,
      blob_key: file.version.originalBlobKey,
      disposition: attachmentDisposition(file.version.originalFilename),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(DOWNLOAD_TOKEN_TTL)
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    await notifyTransferDownloaded(transfer, grant.name, file.name);
    await recordTransferDownload(c, transfer, grant, {
      kind: "file",
      assetId: file.asset_id,
      filename: file.name,
      bytes: file.version.size,
    });
    return c.json({
      url: `/api/v1/t/${transfer.slug}/file?token=${encodeURIComponent(token)}`,
      expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
  });

  api.get("/t/:slug/file", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    const token = c.req.query("token");
    if (!token || !env.blobStore) throw errors.unauthorized();
    let blobKey: string;
    let disposition: string | undefined;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.transfer_id !== transfer.id ||
        typeof verified.payload.blob_key !== "string"
      )
        throw new Error("Token claims do not match this transfer.");
      blobKey = verified.payload.blob_key;
      if (typeof verified.payload.disposition === "string")
        disposition = sanitizeDisposition(verified.payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    return serveBlob(c, blobKey, disposition);
  });

  api.get("/t/:slug/zip", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    if (transfer.kind !== "package") throw errors.notFound();
    const grant = await requireTransferGrant(c, transfer);
    const store = requireBlobStore();
    const files = await packageFilesFor(transfer);
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const file of files) {
      const version = file.version;
      if (!version) continue;
      let name = zipEntryName(version.originalFilename);
      if (used.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let suffix = 2;
        while (used.has(`${stem} (${suffix})${extension}`)) suffix += 1;
        name = `${stem} (${suffix})${extension}`;
      }
      used.add(name);
      entries.push({
        name,
        size: version.size,
        modifiedAt: version.createdAt,
        cacheKey: version.originalBlobKey,
        open: () => store.getStream(version.originalBlobKey),
        openRange: (from) =>
          store.getStream(version.originalBlobKey, { start: from }),
      });
    }
    if (!entries.length) throw errors.notFound("The package has no files.");
    /* A Range request is the same download resuming, not a second one. */
    if (!c.req.header("range")) {
      await notifyTransferDownloaded(transfer, grant.name, null);
      await recordTransferDownload(c, transfer, grant, {
        kind: "zip",
        filename: `${transfer.title} (${String(entries.length)} ${entries.length === 1 ? "file" : "files"})`,
        bytes: entries.reduce((total, entry) => total + entry.size, 0),
      });
    }
    const zipName = `${
      transfer.title
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "package"
    }.zip`;
    return serveZip(c, entries, zipName);
  });

  const transferUploadWire = (upload: typeof uploadSessions.$inferSelect) => ({
    id: upload.id,
    filename: upload.clientFilename,
    relative_path: upload.relativePath,
    size: upload.size,
    checksum_crc32c: upload.checksumCrc32c,
    status: upload.status,
    created_at: upload.createdAt,
    completed_at: upload.completedAt,
  });

  /** The upload must be one this transfer's link created. */
  const findTransferUpload = async (
    transfer: typeof transfers.$inferSelect,
    uploadId: string,
  ): Promise<{
    upload: typeof uploadSessions.$inferSelect;
    receipt: typeof transferReceipts.$inferSelect;
  }> => {
    const receipt = (
      await env.db
        .select()
        .from(transferReceipts)
        .where(
          and(
            eq(transferReceipts.transferId, transfer.id),
            eq(transferReceipts.uploadSessionId, uploadId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!receipt) throw errors.notFound("Upload was not found.");
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .limit(1)
        .all()
    )[0];
    if (!upload) throw errors.notFound("Upload was not found.");
    return { upload, receipt };
  };

  api.post("/t/:slug/uploads", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    if (transfer.kind !== "request") throw errors.notFound();
    const grant = await requireTransferGrant(c, transfer);
    const ip = clientIp(c, env);
    await hitRateLimit(
      `transfer_upload:${transfer.id}:${ip}`,
      240,
      60 * 60 * 1000,
    );
    const body = await jsonBody(c, bodies.transferUploadCreate);
    if ((body.relative_path ?? "").split(/[\\/]/).includes(".."))
      throw errors.validation("Relative path cannot contain parent segments.");
    const filename = body.filename.replace(/[\\/]/g, "_");
    if (transfer.byteCap !== null) {
      const used = await receivedBytesFor(transfer.id);
      if (used + body.size > transfer.byteCap) throw errors.payloadTooLarge();
    }
    const project = (
      await env.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, transfer.projectId))
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.notFound("Transfer is unavailable.");
    const uploadId = env.ids.ulid();
    const blobKey = `${project.workspaceId}/${transfer.projectId}/uploads/${uploadId}/${filename}`;
    const now = env.clock.now();
    await env.db
      .insert(uploadSessions)
      .values({
        id: uploadId,
        workspaceId: project.workspaceId,
        projectId: transfer.projectId,
        createdBy: transfer.createdBy,
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
    try {
      await env.db
        .insert(transferReceipts)
        .values({
          id: env.ids.ulid(),
          transferId: transfer.id,
          uploadSessionId: uploadId,
          senderName: grant.name,
          assetId: null,
          createdAt: now,
        })
        .run();
    } catch (error) {
      await env.db
        .delete(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .run();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("transfer byte limit reached"))
        throw errors.payloadTooLarge();
      throw error;
    }
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .limit(1)
        .all()
    )[0];
    if (!upload) throw errors.internal();
    return c.json({ upload: transferUploadWire(upload) }, 201);
  });

  api.post("/t/:slug/uploads/:id/multipart", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    await requireTransferGrant(c, transfer);
    const { upload } = await findTransferUpload(transfer, c.req.param("id"));
    const started = await startMultipart(upload);
    return c.json({
      upload: transferUploadWire(started.upload),
      ...(started.uploadId
        ? { upload_id: started.uploadId, part_size: started.partSize }
        : {}),
    });
  });

  api.get("/t/:slug/uploads/:id/parts", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    await requireTransferGrant(c, transfer);
    const { upload } = await findTransferUpload(transfer, c.req.param("id"));
    return c.json(await listPartsResponse(upload));
  });

  api.put("/t/:slug/uploads/:id/parts/:partNo", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    await requireTransferGrant(c, transfer);
    const { upload } = await findTransferUpload(transfer, c.req.param("id"));
    c.header("etag", await storePart(c, upload));
    return c.body(null, 204);
  });

  api.post("/t/:slug/uploads/:id/complete", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    const grant = await requireTransferGrant(c, transfer);
    const found = await findTransferUpload(transfer, c.req.param("id"));
    if (found.upload.status === "completed")
      return c.json(
        {
          upload: transferUploadWire(found.upload),
          asset_id: found.receipt.assetId,
        },
        202,
      );
    const body = await jsonBody(c, bodies.uploadComplete);
    const completed = await finishUpload(found.upload, body);
    /* The received file lands as an asset immediately: media probes and
       transcodes exactly as a member upload would, so the request's yield
       is review-ready, not a pile of blobs. */
    const existingVersion = await env.db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(eq(assetVersions.uploadSessionId, completed.id))
      .limit(1)
      .all();
    let assetId = found.receipt.assetId;
    if (!existingVersion.length) {
      /* The destination folder may have been deleted since the link was
         minted; received files then land at the project root. */
      let folderId = transfer.folderId;
      if (folderId) {
        const folder = (
          await env.db
            .select({ id: folders.id })
            .from(folders)
            .where(eq(folders.id, folderId))
            .limit(1)
            .all()
        )[0];
        if (!folder) folderId = null;
      }
      const landed = await landUploadAsAsset(completed, {
        folderId,
        uploadedBy: transfer.createdBy,
      });
      assetId = landed.assetId;
      await env.db
        .update(transferReceipts)
        .set({ assetId })
        .where(eq(transferReceipts.id, found.receipt.id))
        .run();
      await createNotifications({
        projectId: transfer.projectId,
        actorUserId: null,
        recipients: [
          transfer.createdBy,
          ...(await projectManagerIds(transfer.projectId)),
        ],
        kind: "transfer.received",
        payload: {
          transfer_id: transfer.id,
          transfer_title: transfer.title,
          project_id: transfer.projectId,
          sender_name: grant.name,
          filename: completed.clientFilename,
          asset_id: assetId,
        },
      });
      await appendProjectEvent(transfer.projectId, "transfer.received", {
        transfer_id: transfer.id,
        sender_name: grant.name,
        asset_id: assetId,
      });
    }
    return c.json(
      { upload: transferUploadWire(completed), asset_id: assetId },
      202,
    );
  });

  api.post("/uploads", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.uploadCreate);
    await requireProject(body.project_id, actor, "editor");
    if ((body.relative_path ?? "").split(/[\\/]/).includes(".."))
      throw errors.validation("Relative path cannot contain parent segments.");
    const filename = body.filename.replace(/[\\/]/g, "_");
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

  const findUpload = async (
    id: string,
    actor: ActorUser,
    role: "editor" | "viewer" = "editor",
  ) => {
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, id))
        .limit(1)
        .all()
    )[0];
    if (!upload || upload.workspaceId !== actor.workspaceId)
      throw errors.notFound("Upload was not found.");
    await requireProject(upload.projectId, actor, role);
    return upload;
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

  api.post("/uploads/:id/multipart", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    return c.json(multipartResponse(await startMultipart(upload)));
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

  api.get("/uploads/:id/parts", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    return c.json(await listPartsResponse(upload));
  });

  /* The whole share as one streamed zip, under the same policy as the
     per-file downloads: none refuses, original bundles the negatives, proxy
     bundles review files (originals for stills and documents, which have no
     lesser form). A watermarked share never bundles: the burned renditions
     download one at a time, and the clean files never leave in ANY mode. */
  api.get("/s/:slug/zip", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const share = projection.share;
    if (share.allowDownload === "none")
      throw errors.forbidden("Downloads are disabled for this share.");
    if (shareIsWatermarked(share))
      throw errors.forbidden("Watermarked shares download one file at a time.");
    const store = requireBlobStore();
    const versionIds = projection.assets
      .map((asset: PublicShareAsset) => asset.currentVersionId)
      .filter((id: string | null): id is string => id !== null);
    if (!versionIds.length) throw errors.notFound("Nothing to download.");
    const versionRows = (await env.db
      .select()
      .from(assetVersions)
      .where(inArray(assetVersions.id, versionIds))
      .all()) as Array<typeof assetVersions.$inferSelect>;
    const versionsById = new Map(versionRows.map((row) => [row.id, row]));
    const proxyRows =
      share.allowDownload === "proxy"
        ? ((await env.db
            .select()
            .from(renditions)
            .where(
              and(
                inArray(renditions.versionId, versionIds),
                inArray(renditions.kind, ["proxy_1080", "proxy_audio"]),
                isNull(renditions.shareId),
              ),
            )
            .all()) as Array<typeof renditions.$inferSelect>)
        : [];
    const proxiesByVersion = new Map(
      proxyRows.map((row) => [row.versionId, row]),
    );
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const asset of projection.assets) {
      const version = asset.currentVersionId
        ? versionsById.get(asset.currentVersionId)
        : undefined;
      if (!version) continue;
      let source: { size: number; blobKey: string; filename: string };
      /* Audio bundles its proxy for the same reason video does: a proxy
         bundle that quietly shipped 24-bit WAV originals would hand out the
         masters a "proxy only" share exists to withhold. */
      if (
        share.allowDownload === "proxy" &&
        (asset.kind === "video" || asset.kind === "audio")
      ) {
        const proxy = proxiesByVersion.get(version.id);
        /* A partial archive would read as complete; refuse instead. */
        if (!proxy)
          throw errors.conflict(
            "A review rendition is still processing. Try again shortly.",
          );
        const baseName =
          version.originalFilename.replace(/\.[^.]+$/, "") || "download";
        source = {
          size: proxy.size,
          blobKey: proxy.blobKey,
          filename: `${baseName}-proxy.${proxy.kind === "proxy_audio" ? "m4a" : "mp4"}`,
        };
      } else {
        source = {
          size: version.size,
          blobKey: version.originalBlobKey,
          filename: version.originalFilename,
        };
      }
      let name = zipEntryName(source.filename);
      if (used.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let suffix = 2;
        while (used.has(`${stem} (${suffix})${extension}`)) suffix += 1;
        name = `${stem} (${suffix})${extension}`;
      }
      used.add(name);
      entries.push({
        name,
        size: source.size,
        modifiedAt: version.createdAt,
        cacheKey: source.blobKey,
        open: () => store.getStream(source.blobKey),
        openRange: (from) => store.getStream(source.blobKey, { start: from }),
      });
    }
    if (!entries.length) throw errors.notFound("Nothing to download.");
    const zipName = `${
      share.title
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "share"
    }.zip`;
    return serveZip(c, entries, zipName);
  });

  api.get("/uploads/:id/parts/:partNo/url", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const partNo = Number(c.req.param("partNo"));
    multipartPartLimit(upload, partNo);
    return c.json({ url: `/api/v1/uploads/${upload.id}/parts/${partNo}` });
  });

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

  api.put("/uploads/:id/parts/:partNo", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    c.header("etag", await storePart(c, upload));
    return c.body(null, 204);
  });

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

  /* A completed upload becomes an asset with a first version and a queued
     probe. Shared by the member attach endpoint and the transfer request
     flow, whose received files land through the exact same door. */
  const landUploadAsAsset = async (
    upload: typeof uploadSessions.$inferSelect,
    options: {
      name?: string | undefined;
      folderId: string | null;
      uploadedBy: string;
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
    await appendProjectEvent(upload.projectId, "asset.created", {
      asset_id: assetId,
      version_id: versionId,
      job_id: jobId,
    });
    return { assetId, versionId, jobId, name, createdAt: now };
  };

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
    const cursor = cursorParam(c.req.query("cursor"));
    const folderId = c.req.query("folder_id");
    /* A share reads as a folder in the browser rail, so it filters the same
       list the same way -- one endpoint, one paging rule, one permission
       check, rather than a second asset list that only shares use. The share
       must belong to this project; otherwise the filter would be a way to read
       one project's asset rows through another's permission check. */
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
          shareId
            ? inArray(
                assets.id,
                env.db
                  .select({ id: shareAssets.assetId })
                  .from(shareAssets)
                  .where(eq(shareAssets.shareId, shareId)),
              )
            : undefined,
          cursor ? lt(assets.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(assets.id))
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
              inArray(renditions.kind, ["poster", "sprite"]),
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
      const poster = kinds.find((rendition) => rendition.kind === "poster");
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
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
  });

  const assetForActor = async (
    id: string,
    actor: ActorUser,
    minimum: "viewer" | "commenter" | "editor" | "manager" = "viewer",
  ) => {
    const asset = (
      await env.db.select().from(assets).where(eq(assets.id, id)).limit(1).all()
    )[0];
    if (!asset) throw errors.notFound("Asset was not found.");
    await requireProject(asset.projectId, actor, minimum);
    return asset;
  };

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
    /* A folder move must land in an assets folder of THIS project. Without the
       check a stray id filed the asset under another project's tree (or a
       shares folder), where every folder listing -- all scoped by project --
       stopped showing it: orphaned in the UI with no way back. */
    if (body.folder_id != null)
      await requireDestinationFolder(asset.projectId, body.folder_id);
    await env.db
      .update(assets)
      .set({
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.folder_id === undefined ? {} : { folderId: body.folder_id }),
        ...(body.status ? { status: body.status } : {}),
        ...(body.description === undefined
          ? {}
          : { description: body.description }),
        ...(body.tags === undefined
          ? {}
          : { tagsJson: JSON.stringify(body.tags) }),
        updatedAt: env.clock.now(),
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

  api.delete("/assets/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    await env.db
      .update(assets)
      .set({ deletedAt: env.clock.now(), updatedAt: env.clock.now() })
      .where(eq(assets.id, asset.id))
      .run();
    return c.body(null, 204);
  });

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
      .set({ thumbnailBlobKey: upload.blobKey, updatedAt: env.clock.now() })
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
      .set({ thumbnailBlobKey: null, updatedAt: env.clock.now() })
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

  // Version stacking: attach a completed upload as the next version of an
  // existing asset. Mirrors the initial attach (probe job, storage
  // accounting, project event) and optionally carries unresolved comments
  // forward from the version that was current until this call.
  api.post("/assets/:id/versions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.versionCreate);
    const upload = await findUpload(body.upload_id, actor);
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
    const previousCurrentId = asset.currentVersionId;
    const now = env.clock.now();
    const versionId = env.ids.ulid();
    await env.db
      .insert(assetVersions)
      .values({
        id: versionId,
        assetId: asset.id,
        uploadSessionId: upload.id,
        versionNo,
        originalBlobKey: upload.blobKey,
        originalFilename: upload.clientFilename,
        size: upload.size,
        checksumCrc32c: upload.checksumCrc32c ?? "",
        uploadedBy: actor.id,
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
      .update(assets)
      .set({
        currentVersionId: versionId,
        ...(body.name ? { name: body.name.trim() } : {}),
        updatedAt: now,
      })
      .where(eq(assets.id, asset.id))
      .run();
    await env.db
      .update(projects)
      .set({ storageBytes: sql`${projects.storageBytes} + ${upload.size}` })
      .where(eq(projects.id, asset.projectId))
      .run();
    const jobId = env.ids.ulid();
    await env.db
      .insert(jobs)
      .values({
        id: jobId,
        kind: "probe",
        payloadJson: JSON.stringify({
          workspace_id: actor.workspaceId,
          project_id: asset.projectId,
          asset_id: asset.id,
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
    if (body.carry_forward && previousCurrentId)
      await copyUnresolvedComments(previousCurrentId, versionId);
    await appendProjectEvent(asset.projectId, "asset.version_created", {
      asset_id: asset.id,
      version_id: versionId,
      version_no: versionNo,
      job_id: jobId,
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
        .where(eq(assetVersions.id, versionId))
        .limit(1)
        .all()
    )[0];
    if (!updatedAsset || !newVersion) throw errors.internal();
    await createNotifications({
      projectId: asset.projectId,
      actorUserId: actor.id,
      recipients: [
        ...priorVersions.map((row: { uploadedBy: string }) => row.uploadedBy),
        ...(await projectManagerIds(asset.projectId)),
      ],
      kind: "version.created",
      payload: {
        project_id: asset.projectId,
        asset_id: asset.id,
        asset_name: updatedAsset.name,
        version_id: versionId,
        version_no: versionNo,
        actor_name: actor.name,
        preview: `Version ${versionNo} of ${updatedAsset.name}`,
      },
    });
    return c.json(
      {
        asset: assetWire(updatedAsset),
        version: versionWire(newVersion),
        job_id: jobId,
      },
      201,
    );
  });

  api.post("/assets/:id/trash", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    await env.db
      .update(assets)
      .set({ deletedAt: env.clock.now(), updatedAt: env.clock.now() })
      .where(eq(assets.id, asset.id))
      .run();
    return c.body(null, 204);
  });

  api.post("/assets/:id/restore", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    await env.db
      .update(assets)
      .set({ deletedAt: null, updatedAt: env.clock.now() })
      .where(eq(assets.id, asset.id))
      .run();
    const restored = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, asset.id))
        .limit(1)
        .all()
    )[0];
    if (!restored) throw errors.notFound();
    return c.json(assetWire(restored));
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
    });
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

  /* A folder, a selection, or the whole project as one streamed zip of
     originals. Editor for the same reason the single original is: this is
     the negative, not the screener. */
  api.get("/projects/:id/zip", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "editor");
    const store = requireBlobStore();
    const folderId = c.req.query("folder_id") ?? null;
    const wantedIds = (c.req.query("asset_ids") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    /* The folder tree, for archive paths and for expanding a folder pick
       into its descendants. */
    const folderRows = (await env.db
      .select()
      .from(folders)
      .where(and(eq(folders.projectId, projectId), eq(folders.kind, "assets")))
      .all()) as Array<typeof folders.$inferSelect>;
    const foldersById = new Map(folderRows.map((row) => [row.id, row]));
    const pathOf = (id: string | null): string[] => {
      const segments: string[] = [];
      let cursor = id;
      let guard = 0;
      while (cursor && guard < 64) {
        const row = foldersById.get(cursor);
        if (!row) break;
        segments.unshift(row.name);
        cursor = row.parentId;
        guard += 1;
      }
      return segments;
    };
    const insideWanted = (id: string | null): boolean => {
      if (!folderId) return true;
      let cursor = id;
      let guard = 0;
      while (cursor && guard < 64) {
        if (cursor === folderId) return true;
        cursor = foldersById.get(cursor)?.parentId ?? null;
        guard += 1;
      }
      return false;
    };
    if (folderId && !foldersById.has(folderId))
      throw errors.notFound("Folder was not found.");
    const rows = (await env.db
      .select({ asset: assets, version: assetVersions })
      .from(assets)
      .innerJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(and(eq(assets.projectId, projectId), isNull(assets.deletedAt)))
      .orderBy(asc(assets.id))
      .all()) as Array<{
      asset: typeof assets.$inferSelect;
      version: typeof assetVersions.$inferSelect;
    }>;
    const wanted = new Set(wantedIds);
    const chosen = rows.filter(
      (row) =>
        (wanted.size === 0 || wanted.has(row.asset.id)) &&
        insideWanted(row.asset.folderId),
    );
    if (!chosen.length) throw errors.notFound("Nothing to download.");
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const row of chosen) {
      const version = row.version;
      const directory = pathOf(row.asset.folderId)
        .map((segment) => zipEntryName(segment))
        .join("/");
      let name = zipEntryName(version.originalFilename);
      if (directory) name = `${directory}/${name}`;
      if (used.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let suffix = 2;
        while (used.has(`${stem} (${suffix})${extension}`)) suffix += 1;
        name = `${stem} (${suffix})${extension}`;
      }
      used.add(name);
      entries.push({
        name,
        size: version.size,
        modifiedAt: version.createdAt,
        cacheKey: version.originalBlobKey,
        open: () => store.getStream(version.originalBlobKey),
        openRange: (from) =>
          store.getStream(version.originalBlobKey, { start: from }),
      });
    }
    const scopeName = folderId
      ? (foldersById.get(folderId)?.name ?? "folder")
      : ((
          await env.db
            .select({ name: projects.name })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
            .all()
        )[0]?.name ?? "project");
    const zipName = `${
      scopeName
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "files"
    }.zip`;
    return serveZip(c, entries, zipName);
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
    const bytes = await c.req.arrayBuffer();
    if (!bytes.byteLength)
      throw errors.validation("The captions file is empty.");
    if (bytes.byteLength > CAPTION_MAX_BYTES)
      throw errors.validation("Captions must be under 1 MB.");
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
    await env.db
      .update(assets)
      .set({ currentVersionId: target.id, updatedAt: env.clock.now() })
      .where(eq(assets.id, version.assetId))
      .run();
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

  api.get("/jobs/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const job = (
      await env.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!job) throw errors.notFound();
    const payload = parseJsonObject(job.payloadJson);
    if (payload.workspace_id !== actor.workspaceId) throw errors.notFound();
    /* A job's status and error string belong to whoever can see its project,
       not to the whole workspace: without this a guest could read the state
       and failure message of any job in any project. Jobs that carry a
       project scope are checked against it; the few workspace-level jobs
       (no project_id) stay workspace-scoped as before. */
    if (typeof payload.project_id === "string")
      await requireProject(payload.project_id, actor, "viewer");
    return c.json(jobWire(job));
  });

  api.get("/admin/jobs", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const requestedStatus = c.req.query("status");
    const status =
      requestedStatus &&
      ["queued", "processing", "complete", "failed", "dead"].includes(
        requestedStatus,
      )
        ? (requestedStatus as typeof jobs.$inferSelect.status)
        : undefined;
    if (requestedStatus && !status)
      throw errors.validation("Job status is invalid.");
    const rows = await env.db
      .select()
      .from(jobs)
      .where(
        and(
          // Jobs carry workspace scope in their validated payload (phase-1
          // section 2); without this filter admins would see every
          // workspace's jobs.
          sql`json_extract(${jobs.payloadJson}, '$.workspace_id') = ${actor.workspaceId}`,
          cursor ? lt(jobs.id, cursor) : undefined,
          status ? eq(jobs.status, status) : undefined,
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(rows, limit, (job: typeof jobs.$inferSelect) => jobWire(job)),
    );
  });

  api.get("/media/*", requireAuth, async (c) => {
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const rawKey = c.req.path.split("/media/")[1];
    if (!rawKey) throw errors.notFound();
    const key =
      rawKey
        .split("?")[0]
        ?.split("/")
        .map((part) => decodeURIComponent(part))
        .join("/") ?? "";
    const token = c.req.query("token");
    if (!token) throw errors.unauthorized();
    let disposition: string | undefined;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      const scoped =
        typeof verified.payload.version_id === "string" ||
        typeof verified.payload.project_id === "string" ||
        typeof verified.payload.export_id === "string";
      if (verified.payload.blob_key !== key || !scoped)
        throw new Error("Token claims do not match this media key.");
      // Content-disposition comes from the verified claim only, sanitized.
      if (typeof verified.payload.disposition === "string")
        disposition = sanitizeDisposition(verified.payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    return serveBlob(c, key, disposition);
  });

  /* What is in the trash, workspace-wide: names and when, for the restore
     button. The purge sweep keeps this bounded. */
  api.get("/trash", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const rows = (await env.db
      .select({ asset: assets, projectName: projects.name })
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          isNotNull(assets.deletedAt),
        ),
      )
      .orderBy(desc(assets.deletedAt))
      .limit(500)
      .all()) as Array<{
      asset: typeof assets.$inferSelect;
      projectName: string;
    }>;
    return c.json({
      items: rows.map((row) => ({
        id: row.asset.id,
        name: row.asset.name,
        kind: row.asset.kind,
        project_id: row.asset.projectId,
        project_name: row.projectName,
        deleted_at: row.asset.deletedAt,
      })),
    });
  });

  api.get("/audit", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const action = c.req.query("action");
    const rows = await env.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, actor.workspaceId),
          action ? eq(auditLog.action, action) : undefined,
          cursor ? lt(auditLog.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(rows, limit, (entry: typeof auditLog.$inferSelect) => ({
        id: entry.id,
        actor_user_id: entry.actorUserId,
        action: entry.action,
        target: entry.target,
        meta: parseJsonObject(entry.metaJson),
        at: entry.at,
      })),
    );
  });

  const oidcEnabled = () => {
    if (
      !env.config.OIDC_ISSUER ||
      !env.config.OIDC_CLIENT_ID ||
      !env.config.OIDC_CLIENT_SECRET
    )
      throw errors.notFound("OIDC is not configured.");
    return {
      issuer: env.config.OIDC_ISSUER,
      clientId: env.config.OIDC_CLIENT_ID,
      clientSecret: env.config.OIDC_CLIENT_SECRET,
    };
  };

  api.get("/auth/oidc/start", async (c) => {
    const { issuer, clientId } = oidcEnabled();
    const discovery = await fetch(
      `${issuer}/.well-known/openid-configuration`,
    ).then(async (response) => {
      if (!response.ok) throw errors.internal("OIDC discovery failed.");
      return response.json() as Promise<{ authorization_endpoint: string }>;
    });
    const state = base64UrlEncode(randomBytes(24));
    const nonce = base64UrlEncode(randomBytes(24));
    const verifier = base64UrlEncode(randomBytes(32));
    const challenge = base64UrlEncode(await sha256(verifier));
    const signed = await new SignJWT({ state, nonce, verifier })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    setCookie(c, OIDC_COOKIE, signed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: env.config.cookieSecure,
      maxAge: 600,
      path: "/",
    });
    const redirect = new URL(discovery.authorization_endpoint);
    redirect.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/api/v1/auth/oidc/callback`,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(redirect.toString(), 302);
  });

  api.get("/auth/oidc/callback", async (c) => {
    const { issuer, clientId, clientSecret } = oidcEnabled();
    const ip = clientIp(c, env);
    await hitRateLimit(`oidc_callback:${ip}`, 20, 5 * 60 * 1000);
    const code = c.req.query("code");
    const returnedState = c.req.query("state");
    const signed = getCookie(c, OIDC_COOKIE);
    if (!code || !returnedState || !signed)
      throw errors.forbidden("OIDC callback state is missing.");
    const { payload } = await jwtVerify(
      signed,
      new TextEncoder().encode(env.config.SECRET_KEY),
    );
    if (
      payload.state !== returnedState ||
      typeof payload.verifier !== "string" ||
      typeof payload.nonce !== "string"
    )
      throw errors.forbidden("OIDC callback state is invalid.");
    const discovery = await fetch(
      `${issuer}/.well-known/openid-configuration`,
    ).then(async (response) => {
      if (!response.ok) throw errors.internal("OIDC discovery failed.");
      return response.json() as Promise<{
        token_endpoint: string;
        jwks_uri: string;
      }>;
    });
    const basic = btoa(`${clientId}:${clientSecret}`);
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/api/v1/auth/oidc/callback`,
        code_verifier: payload.verifier,
      }).toString(),
    });
    if (!tokenResponse.ok)
      throw errors.forbidden("OIDC token exchange failed.");
    const tokenBody = (await tokenResponse.json()) as { id_token?: string };
    if (!tokenBody.id_token)
      throw errors.forbidden("OIDC response did not include an ID token.");
    const verified = await jwtVerify(
      tokenBody.id_token,
      createRemoteJWKSet(new URL(discovery.jwks_uri)),
      { issuer, audience: clientId },
    );
    const claims = verified.payload;
    if (claims.nonce !== payload.nonce)
      throw errors.forbidden("OIDC nonce is invalid.");
    const subject = claims.sub;
    const email =
      typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
    if (!subject || !email)
      throw errors.forbidden(
        "OIDC account is missing a verified subject or email.",
      );
    const identity = (
      await env.db
        .select({ user: users })
        .from(identities)
        .innerJoin(users, eq(identities.userId, users.id))
        .where(
          and(eq(identities.provider, issuer), eq(identities.subject, subject)),
        )
        .limit(1)
        .all()
    )[0];
    let user = identity?.user;
    const emailVerified = claims.email_verified === true;
    if (!user && !emailVerified)
      throw errors.forbidden(
        "OIDC email must be verified before this account can be authorized.",
      );
    if (!user && emailVerified)
      user = (
        await env.db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)
          .all()
      )[0];
    if (!user && env.config.OIDC_AUTO_PROVISION) {
      const domain = email.split("@")[1]?.toLowerCase();
      if (
        env.config.oidcAllowedDomains.length &&
        (!domain || !env.config.oidcAllowedDomains.includes(domain))
      )
        throw errors.forbidden("OIDC email domain is not allowed.");
      const workspaceRows = await env.db
        .select()
        .from(workspaces)
        .limit(1)
        .all();
      const workspace = workspaceRows[0];
      if (!workspace)
        throw errors.notFound("Setup is required before OIDC login.");
      const now = env.clock.now();
      const id = env.ids.ulid();
      await env.db
        .insert(users)
        .values({
          id,
          workspaceId: workspace.id,
          email,
          name:
            typeof claims.name === "string"
              ? claims.name
              : (email.split("@")[0] ?? email),
          role: "member",
          passwordHash: null,
          disabledAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      user = (
        await env.db.select().from(users).where(eq(users.id, id)).limit(1).all()
      )[0];
    }
    if (!user || user.disabledAt)
      throw errors.forbidden("This OIDC account is not authorized.");
    const existingIdentity = await env.db
      .select({ id: identities.id })
      .from(identities)
      .where(
        and(eq(identities.provider, issuer), eq(identities.subject, subject)),
      )
      .limit(1)
      .all();
    if (!existingIdentity.length)
      await env.db
        .insert(identities)
        .values({
          id: env.ids.ulid(),
          userId: user.id,
          provider: issuer,
          subject,
          createdAt: env.clock.now(),
        })
        .run();
    await createSession(env, user.id, c);
    deleteCookie(c, OIDC_COOKIE, { path: "/" });
    await audit(user.workspaceId, user.id, "oidc.login", `user:${user.id}`);
    return c.redirect("/", 302);
  });

  // The OpenAPI document is generated from the routes registered on the Hono
  // app (the REST API is a public contract; a hand-maintained map drifts).
  // Request and response schemas come from the shared registry in schemas.ts,
  // whose request entries are the SAME zod objects the routes validate with,
  // so the document and the validators cannot drift. Built lazily at first
  // request so every route is registered.
  const openApiMethods = new Set(["get", "post", "put", "patch", "delete"]);
  const toOpenApiPath = (path: string): string =>
    path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*/g, "{path}");
  const jsonSchemaFor = (
    schema: Parameters<typeof zodToJsonSchema>[0],
  ): Record<string, unknown> => {
    const converted = zodToJsonSchema(schema, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    delete converted.$schema;
    return converted;
  };
  const errorRef = (description: string) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  });
  const binaryBody = (contentType: string) => ({
    content:
      contentType === "multipart/form-data"
        ? {
            [contentType]: {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
                required: ["file"],
              },
            },
          }
        : { [contentType]: { schema: { type: "string", format: "binary" } } },
  });
  const operationFor = (
    routePath: string,
    method: string,
    doc: RouteDoc | undefined,
  ): Record<string, unknown> => {
    const parameters: Array<Record<string, unknown>> = [];
    for (const match of routePath.matchAll(/:([A-Za-z0-9_]+)/g))
      parameters.push({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    if (routePath.includes("*"))
      parameters.push({
        name: "path",
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    for (const [name, query] of Object.entries(doc?.query ?? {}))
      parameters.push({
        name,
        in: "query",
        required: Boolean(query.required),
        description: query.description,
        schema: { type: "string" },
      });
    const responses: Record<string, unknown> = {};
    if (doc) {
      for (const [status, response] of Object.entries(doc.responses)) {
        responses[status] = {
          description: response.description,
          ...(response.schema
            ? {
                content: {
                  "application/json": {
                    schema: jsonSchemaFor(response.schema),
                  },
                },
              }
            : response.contentType
              ? binaryBody(response.contentType)
              : {}),
        };
      }
    } else {
      responses[
        method === "post" ? "201" : method === "delete" ? "204" : "200"
      ] = { description: `${method.toUpperCase()} ${routePath}` };
    }
    responses["400"] = errorRef("Validation failure");
    responses["401"] = errorRef("Authentication required");
    responses["403"] = errorRef("Forbidden");
    responses["404"] = errorRef("Not found");
    return {
      ...(doc?.summary ? { summary: doc.summary } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(doc?.request
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: jsonSchemaFor(doc.request) },
              },
            },
          }
        : doc?.requestContentType
          ? {
              requestBody: {
                required: true,
                ...binaryBody(doc.requestContentType),
              },
            }
          : {}),
      responses,
    };
  };
  let openApiDocumentCache: Record<string, unknown> | undefined;
  const buildOpenApiDocument = (): Record<string, unknown> => {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const route of api.routes) {
      const method = route.method.toLowerCase();
      if (!openApiMethods.has(method)) continue;
      if (route.path === "/openapi.json" || route.path === "/docs") continue;
      const path = toOpenApiPath(`/api/v1${route.path}`);
      const entry = (paths[path] ??= {});
      if (entry[method]) continue;
      entry[method] = operationFor(
        route.path,
        method,
        routeDocs[`${route.method} ${route.path}`],
      );
    }
    return {
      openapi: "3.1.0",
      info: { title: "Onelight API", version: env.version },
      components: { schemas: { Error: jsonSchemaFor(errorEnvelope) } },
      paths,
    };
  };
  api.get("/openapi.json", (c) => {
    openApiDocumentCache ??= buildOpenApiDocument();
    return c.json(openApiDocumentCache);
  });
  const docsHtml =
    '<!doctype html><html><head><title>Onelight API</title></head><body><h1>Onelight API</h1><p>OpenAPI document: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p></body></html>';
  api.get("/docs", (c) => c.html(docsHtml));

  root.route("/api/v1", api);
  // Phase 0 places the reference UI at /api/docs.
  root.get("/api/docs", (c) => c.html(docsHtml));
  // Forward the runtime env (the node-server socket bindings on Node) so
  // clientIp can read the real peer address for share rate limiting.
  root.all("/s/*", (c) => api.fetch(c.req.raw, c.env));
  root.get("/healthz", (c) => c.json({ status: "ok", version: env.version }));
  root.get("/readyz", async (c) => {
    try {
      await env.db.run(sql`select 1`);
      return c.json({ status: "ready", version: env.version });
    } catch {
      return c.json({ status: "not_ready" }, 503);
    }
  });
  return root;
};

export const createApp = (env: AppEnv): Hono<{ Variables: Variables }> =>
  app(env);
