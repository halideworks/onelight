import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  like,
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
import { z } from "zod";
import {
  PALETTES,
  base64UrlEncode,
  crc32cMatches,
  crc32cStream,
  days,
  errors,
  projectRoleAtLeast,
  randomBytes,
  sha256,
  sha256Hex,
} from "@onelight/core";
import type { MultipartBlobStore } from "@onelight/core";
import {
  apiTokens,
  assetVersions,
  assets,
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
  uploadParts,
  uploadSessions,
  users,
  webhooks,
  workspaces,
  notifications,
  notificationPreferences,
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
  commentCursorParam,
  cursorParam,
  encodeCommentCursor,
  encodeCursor,
  getLimit,
  jsonBody,
  mapError,
  parseJsonObject,
  parseJsonValue,
  userFromContext,
} from "./helpers.js";
import type { AppEnv, Variables } from "./types.js";
import {
  assertWebhookUrlAllowed,
  scheduleWebhookDeliveries,
} from "./webhooks.js";

const app = (env: AppEnv): Hono<{ Variables: Variables }> => {
  const root = new Hono<{ Variables: Variables }>();
  const api = new Hono<{ Variables: Variables }>();

  root.use("*", authMiddleware(env));
  root.use("*", requireOrigin(env));

  root.onError((error, c) => {
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
  });
  root.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "The requested resource was not found.",
        },
      },
      404,
    ),
  );
  root.use("*", async (c, next) => {
    c.set("requestId", env.ids.ulid());
    await next();
  });

  const userWire = (user: typeof users.$inferSelect) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    disabled_at: user.disabledAt,
    created_at: user.createdAt,
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

  const projectWire = async (
    project: typeof projects.$inferSelect,
    userId: string,
    workspaceRole: "admin" | "member",
  ) => {
    const grant = await grantFor(project.id, userId);
    const myRole =
      workspaceRole === "admin"
        ? "manager"
        : (grant ?? (project.restricted ? undefined : "viewer"));
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      palette: project.palette,
      restricted: Boolean(project.restricted),
      created_by: project.createdBy,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
      my_role: myRole,
    };
  };

  const requireProject = async (
    projectId: string,
    user: typeof users.$inferSelect,
    minimum?: "manager" | "editor" | "commenter" | "viewer",
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
    if (project.status === "archived" && minimum && minimum !== "viewer")
      throw errors.forbidden("Archived projects are read-only.");
    const role =
      user.role === "admin"
        ? "manager"
        : ((await grantFor(project.id, user.id)) ??
          (project.restricted ? undefined : "viewer"));
    if (!role || (minimum && !projectRoleAtLeast(role, minimum)))
      throw errors.forbidden();
    return { project, role };
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

  const hitRateLimit = async (key: string, limit: number, windowMs: number) => {
    const now = env.clock.now();
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
    await env.db
      .update(rateLimits)
      .set({ count: current.count + 1 })
      .where(eq(rateLimits.key, key))
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
  });

  const shareWire = (share: typeof shares.$inferSelect) => ({
    id: share.id,
    project_id: share.projectId,
    slug: share.slug,
    kind: share.kind,
    title: share.title,
    layout: share.layout,
    expires_at: share.expiresAt,
    allow_download: share.allowDownload,
    allow_comments: Boolean(share.allowComments),
    show_all_versions: Boolean(share.showAllVersions),
    watermark_spec: share.watermarkSpecJson
      ? parseJsonObject(share.watermarkSpecJson)
      : null,
    brand: share.brandJson ? parseJsonObject(share.brandJson) : null,
    created_by: share.createdBy,
    revoked_at: share.revokedAt,
    created_at: share.createdAt,
  });

  const currentWorkspace = async (c: {
    get: (key: "user") => typeof users.$inferSelect;
  }) => workspaceFor(c.get("user").workspaceId);

  api.get("/healthz", (c) => c.json({ status: "ok", version: env.version }));

  api.post("/setup", async (c) => {
    const existing = await env.db
      .select({ id: users.id })
      .from(users)
      .limit(1)
      .all();
    if (existing.length) throw errors.notFound("Setup is already complete.");
    const body = await jsonBody(
      c,
      z.object({
        workspace_name: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        email: z.string().email(),
        password: z.string(),
      }),
    );
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
    const body = await jsonBody(
      c,
      z.object({ email: z.string().email(), password: z.string() }),
    );
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
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
    if (
      !user ||
      user.disabledAt ||
      !user.passwordHash ||
      !(await env.hasher.verify(body.password, user.passwordHash))
    ) {
      if (user)
        await audit(
          user.workspaceId,
          user.id,
          "user.login_failed",
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

  api.patch("/workspace", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(200).optional(),
        settings: z.record(z.unknown()).optional(),
      }),
    );
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
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map(userWire),
      next_cursor:
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
  });

  api.get("/users/me", requireAuth, (c) =>
    c.json(userWire(userFromContext(c))),
  );

  api.patch("/users/me", requireAuth, async (c) => {
    const user = userFromContext(c);
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(200).optional(),
        password: z.object({ current: z.string(), new: z.string() }).optional(),
      }),
    );
    const update: { name?: string; passwordHash?: string; updatedAt: number } =
      { updatedAt: env.clock.now() };
    if (body.name) update.name = body.name.trim();
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

  api.patch("/users/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(
      c,
      z.object({
        role: z.enum(["admin", "member"]).optional(),
        disabled: z.boolean().optional(),
      }),
    );
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
      (body.role === "member" || body.disabled === true) &&
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
        ...(body.role ? { role: body.role } : {}),
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
    const body = await jsonBody(
      c,
      z.object({
        email: z.string().email(),
        role: z.enum(["admin", "member"]).default("member"),
        project_grants: z
          .array(
            z.object({
              project_id: z.string(),
              role: z.enum(["manager", "editor", "commenter", "viewer"]),
            }),
          )
          .default([]),
      }),
    );
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
        role: body.role,
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
        accept_url: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/invite/${rawToken}`,
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
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map((invite: typeof invites.$inferSelect) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        project_grants: JSON.parse(invite.projectGrantsJson),
        invited_by: invite.invitedBy,
        created_at: invite.createdAt,
        expires_at: invite.expiresAt,
      })),
      next_cursor:
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
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
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
    await hitRateLimit(`invite_lookup:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, z.object({ token: z.string().min(1) }));
    const invite = await inviteByToken(body.token);
    const workspace = await workspaceFor(invite.workspaceId);
    return c.json({ email: invite.email, workspace_name: workspace.name });
  });

  api.post("/invites/accept", async (c) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
    await hitRateLimit(`invite_accept:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(
      c,
      z.object({
        token: z.string().min(1),
        name: z.string().min(1).max(200),
        password: z.string(),
      }),
    );
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
    const body = await jsonBody(
      c,
      z.object({ name: z.string().min(1).max(200) }),
    );
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
    const cursor = cursorParam(c.req.query("cursor"));
    const status = c.req.query("status") === "archived" ? "archived" : "active";
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
    const visible = [];
    for (const project of rows) {
      const wire = await projectWire(project, user.id, user.role);
      if (wire.my_role) visible.push(wire);
    }
    const page = visible.slice(0, limit);
    return c.json({
      items: page,
      next_cursor:
        rows.length > limit && page.length
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
  });

  api.post("/projects", requireAuth, async (c) => {
    const user = userFromContext(c);
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(200),
        palette: z.enum(PALETTES).optional(),
        restricted: z.boolean().default(false),
      }),
    );
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
    const { project } = await requireProject(c.req.param("id"), user, "viewer");
    return c.json(await projectWire(project, user.id, user.role));
  });

  api.get("/projects/:id/events", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "viewer");
    const lastEventId = c.req.header("last-event-id");
    const rows = await env.db
      .select()
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.projectId, c.req.param("id")),
          lastEventId ? gt(projectEvents.id, lastEventId) : undefined,
        ),
      )
      .orderBy(asc(projectEvents.id))
      .limit(500)
      .all();
    return streamSSE(c, async (stream) => {
      for (const event of rows)
        await stream.writeSSE({
          id: event.id,
          event: event.type,
          data: event.payloadJson,
        });
    });
  });

  api.patch("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      user,
      "manager",
    );
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(200).optional(),
        palette: z.enum(PALETTES).optional(),
        restricted: z.boolean().optional(),
        status: z.enum(["active", "archived"]).optional(),
      }),
    );
    await env.db
      .update(projects)
      .set({
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.palette ? { palette: body.palette } : {}),
        ...(body.restricted === undefined
          ? {}
          : { restricted: body.restricted }),
        ...(body.status ? { status: body.status } : {}),
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
          user: typeof users.$inferSelect;
          member: typeof projectMembers.$inferSelect;
        }) => ({ user: userWire(row.user), role: row.member.role }),
      ),
    });
  });

  api.put("/projects/:id/members/:userId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "manager");
    const body = await jsonBody(
      c,
      z.object({ role: z.enum(["manager", "editor", "commenter", "viewer"]) }),
    );
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
    if (existing[0]?.role === "manager" && body.role !== "manager") {
      const managers = await env.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.role, "manager"),
          ),
        )
        .all();
      if (managers.length <= 1 && actor.role !== "admin")
        throw errors.conflict("The last project manager cannot be demoted.");
    }
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
    if (existing.role === "manager") {
      const managers = await env.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, existing.projectId),
            eq(projectMembers.role, "manager"),
          ),
        )
        .all();
      if (managers.length <= 1 && actor.role !== "admin")
        throw errors.conflict("The last project manager cannot be removed.");
    }
    await env.db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, existing.projectId),
          eq(projectMembers.userId, existing.userId),
        ),
      )
      .run();
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

  api.get("/projects/:id/folders", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "viewer");
    const parent = c.req.query("parent_id") ?? null;
    const rows = await env.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.projectId, c.req.param("id")),
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
        name: folder.name,
        created_at: folder.createdAt,
      })),
    });
  });

  api.post("/projects/:id/folders", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "editor");
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(200),
        parent_id: z.string().nullable().optional(),
      }),
    );
    await folderDepth(c.req.param("id"), body.parent_id ?? null);
    const now = env.clock.now();
    const id = env.ids.ulid();
    try {
      await env.db
        .insert(folders)
        .values({
          id,
          projectId: c.req.param("id"),
          parentId: body.parent_id ?? null,
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
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(200).optional(),
        parent_id: z.string().nullable().optional(),
      }),
    );
    const parentId =
      body.parent_id === undefined ? folder.parentId : body.parent_id;
    if (parentId === folder.id)
      throw errors.validation("A folder cannot be its own parent.");
    await folderDepth(folder.projectId, parentId ?? null);
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
    actor: typeof users.$inferSelect,
    minimum: "viewer" | "commenter" | "manager" = "viewer",
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
    return c.json({
      items: page.map((comment: typeof comments.$inferSelect) =>
        commentWire(comment),
      ),
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
    const body = await jsonBody(
      c,
      z.object({
        frame_in: z.number().int().nonnegative().optional(),
        frame_out: z.number().int().nonnegative().optional(),
        body_text: z.string().min(1).max(10000),
        annotation: z.unknown().optional(),
        pin_xy: z.unknown().optional(),
        page_no: z.number().int().positive().optional(),
        internal: z.boolean().default(false),
      }),
    );
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
    return c.json(commentWire(comment), 201);
  });

  const commentForActor = async (
    id: string,
    actor: typeof users.$inferSelect,
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

  api.patch("/comments/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    if (comment.authorUserId !== actor.id && actor.role !== "admin")
      throw errors.forbidden();
    const body = await jsonBody(
      c,
      z.object({
        frame_in: z.number().int().nonnegative().optional(),
        frame_out: z.number().int().nonnegative().optional(),
        body_text: z.string().min(1).max(10000).optional(),
        annotation: z.unknown().optional(),
        pin_xy: z.unknown().optional(),
      }),
    );
    validateCommentAnchor(body);
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
    return c.json(commentWire(updated));
  });

  api.delete("/comments/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    if (comment.authorUserId !== actor.id && actor.role !== "admin")
      throw errors.forbidden();
    await env.db
      .update(comments)
      .set({ deletedAt: env.clock.now() })
      .where(eq(comments.id, comment.id))
      .run();
    return c.body(null, 204);
  });

  api.post("/comments/:id/attachments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    if (!env.blobStore || !c.req.raw.body)
      throw errors.internal("Blob storage is not configured.");
    // Validate before buffering: attachments are capped at 25 MiB, and a
    // chunked body without content-length is rejected on this route.
    const maxAttachmentBytes = 25 * 1024 * 1024;
    const declaredLength = c.req.header("content-length");
    if (!declaredLength)
      throw errors.validation(
        "Attachment uploads require a content-length header.",
      );
    if (Number(declaredLength) > maxAttachmentBytes + 1_048_576)
      throw errors.payloadTooLarge();
    const form = await c.req.parseBody();
    const candidate = form.file;
    if (!candidate || typeof candidate === "string")
      throw errors.validation("A file field is required.");
    const file = candidate as File;
    if (file.size > maxAttachmentBytes) throw errors.payloadTooLarge();
    const attachmentId = env.ids.ulid();
    const filename =
      file.name.replace(/[\\/]/g, "_").slice(0, 500) || "attachment";
    const blobKey = `${actor.workspaceId}/comments/${comment.id}/${attachmentId}-${filename}`;
    const stream = new Response(file.stream()).body;
    if (!stream)
      throw errors.internal("Attachment stream could not be opened.");
    await env.blobStore.putStream(blobKey, stream, {
      contentType: file.type || "application/octet-stream",
      size: file.size,
    });
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
    return c.json(
      { id: attachmentId, comment_id: comment.id, filename, size: file.size },
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
        comment.versionId,
        attachment.blobKey,
        attachmentDisposition(attachment.filename),
      ),
      expires_at: env.clock.now() + 15 * 60 * 1000,
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
      if (env.blobStore) await env.blobStore.delete(attachment.blobKey);
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
    const body = await jsonBody(
      c,
      z.object({
        body_text: z.string().min(1).max(10000),
        annotation: z.unknown().optional(),
      }),
    );
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
    return c.json(commentWire(completed));
  });

  api.post("/comments/:id/reactions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(
      c,
      z.object({ code: z.string().regex(/^[a-z0-9_]{1,32}$/) }),
    );
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
    const body = await jsonBody(c, z.object({ from_version_id: z.string() }));
    const source = await versionForActor(body.from_version_id, actor, "viewer");
    const sourceComments = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, source.id),
          isNull(comments.deletedAt),
          isNull(comments.completedAt),
          isNull(comments.parentId),
        ),
      )
      .all();
    const copied = [];
    for (const sourceComment of sourceComments) {
      const id = env.ids.ulid();
      await env.db
        .insert(comments)
        .values({
          id,
          versionId: target.id,
          parentId: null,
          authorUserId: sourceComment.authorUserId,
          authorName: sourceComment.authorName,
          authorEmail: sourceComment.authorEmail,
          viewerKey: sourceComment.viewerKey,
          frameIn: sourceComment.frameIn,
          frameOut: sourceComment.frameOut,
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
    return c.json({ items: copied });
  });

  api.patch("/assets/:id/approval", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(
      c,
      z.object({
        status: z.enum(["none", "in_review", "approved", "changes_requested"]),
      }),
    );
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
    return c.json(assetWire(updated));
  });

  api.get("/notifications", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
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
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map((notification: typeof notifications.$inferSelect) => ({
        id: notification.id,
        kind: notification.kind,
        payload: parseJsonObject(notification.payloadJson),
        read_at: notification.readAt,
        created_at: notification.createdAt,
      })),
      next_cursor:
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
  });

  api.post("/notifications/read", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(
      c,
      z.object({ ids: z.array(z.string()).min(1) }),
    );
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
    const body = await jsonBody(
      c,
      z.object({
        mode: z.enum(["instant", "hourly", "daily"]),
        muted_projects: z.array(z.string()).default([]),
      }),
    );
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

  api.get("/search", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 2)
      throw errors.validation(
        "Search query must contain at least two characters.",
      );
    const pattern = `%${q}%`;
    const assetRows = await env.db
      .select()
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          isNull(assets.deletedAt),
          like(assets.name, pattern),
        ),
      )
      .limit(100)
      .all();
    const commentRows = await env.db
      .select()
      .from(comments)
      .innerJoin(assetVersions, eq(comments.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          isNull(comments.deletedAt),
          like(comments.bodyText, pattern),
        ),
      )
      .limit(100)
      .all();
    return c.json({
      items: [
        ...assetRows.map((row: { assets: typeof assets.$inferSelect }) => ({
          type: "asset",
          id: row.assets.id,
          name: row.assets.name,
          project_id: row.assets.projectId,
        })),
        ...commentRows.map(
          (row: {
            comments: typeof comments.$inferSelect;
            assets: typeof assets.$inferSelect;
          }) => ({
            type: "comment",
            id: row.comments.id,
            body_text: row.comments.bodyText,
            asset_id: row.assets.id,
            version_id: row.comments.versionId,
          }),
        ),
      ],
    });
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
      if (viewer)
        await env.db
          .update(shareViewers)
          .set({ lastSeenAt: env.clock.now() })
          .where(eq(shareViewers.id, viewer.id))
          .run();
      return viewer;
    } catch {
      return undefined;
    }
  };

  const issueMediaToken = async (
    share: typeof shares.$inferSelect,
    assetId: string,
    versionId: string,
    blobKey: string,
  ) =>
    new SignJWT({
      share_id: share.id,
      asset_id: assetId,
      version_id: versionId,
      blob_key: blobKey,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));

  const publicMediaUrl = async (
    share: typeof shares.$inferSelect,
    assetId: string,
    versionId: string,
    blobKey: string,
  ) =>
    `${env.config.PUBLIC_URL.replace(/\/$/, "")}/s/${share.slug}/assets/${assetId}/media/file?token=${encodeURIComponent(await issueMediaToken(share, assetId, versionId, blobKey))}`;

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

  const issuePrivateMediaToken = async (
    versionId: string,
    blobKey: string,
    disposition?: string,
  ) =>
    new SignJWT({
      version_id: versionId,
      blob_key: blobKey,
      ...(disposition ? { disposition } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));

  const privateMediaUrl = async (
    versionId: string,
    blobKey: string,
    disposition?: string,
  ) =>
    `${env.config.PUBLIC_URL.replace(/\/$/, "")}/api/v1/media/${blobKey.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(await issuePrivateMediaToken(versionId, blobKey, disposition))}`;

  const renditionKindContentTypes: Record<string, string> = {
    proxy_2160: "video/mp4",
    proxy_1080: "video/mp4",
    proxy_540: "video/mp4",
    hdr_hevc: "video/mp4",
    hdr_av1: "video/mp4",
    watermarked: "video/mp4",
    poster: "image/jpeg",
    sprite: "image/jpeg",
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
    return "application/octet-stream";
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
    let size: number | undefined;
    if (typeof store.head === "function") {
      try {
        size = (await store.head(key)).size;
      } catch {
        throw errors.notFound("Media was not found.");
      }
    }
    const rangeHeader = c.req.header("range");
    if (rangeHeader !== undefined && size !== undefined) {
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

  api.post("/shares", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(
      c,
      z.object({
        project_id: z.string(),
        kind: z.enum(["review", "presentation"]).default("review"),
        title: z.string().min(1).max(200),
        layout: z.enum(["grid", "list", "reel"]).default("grid"),
        passphrase: z.string().min(1).optional(),
        expires_at: z.number().int().positive().nullable().optional(),
        allow_download: z.enum(["none", "proxy", "original"]).default("none"),
        allow_comments: z.boolean().default(true),
        show_all_versions: z.boolean().default(false),
        watermark_spec: z.record(z.unknown()).nullable().optional(),
        brand: z.record(z.unknown()).nullable().optional(),
        asset_ids: z.array(z.string()).min(1),
      }),
    );
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
    const slug = base62(22);
    const now = env.clock.now();
    const watermarkJson = body.watermark_spec
      ? JSON.stringify(body.watermark_spec)
      : null;
    await env.db
      .insert(shares)
      .values({
        id,
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
        showAllVersions: body.show_all_versions,
        watermarkSpecJson: watermarkJson,
        watermarkSpecHash: watermarkJson
          ? await sha256Hex(watermarkJson)
          : null,
        brandJson: body.brand ? JSON.stringify(body.brand) : null,
        createdBy: actor.id,
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
        .where(eq(shares.id, c.req.param("id")))
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
    return c.json({ ...shareWire(share), assets: links });
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
    const body = await jsonBody(
      c,
      z.object({
        title: z.string().min(1).max(200).optional(),
        layout: z.enum(["grid", "list", "reel"]).optional(),
        passphrase: z.string().min(1).nullable().optional(),
        expires_at: z.number().int().positive().nullable().optional(),
        allow_download: z.enum(["none", "proxy", "original"]).optional(),
        allow_comments: z.boolean().optional(),
        show_all_versions: z.boolean().optional(),
        watermark_spec: z.record(z.unknown()).nullable().optional(),
        revoked: z.boolean().optional(),
      }),
    );
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
        ...(body.allow_comments === undefined
          ? {}
          : { allowComments: body.allow_comments }),
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
    return c.body(null, 204);
  });

  api.post("/webhooks", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(
      c,
      z.object({
        url: z.string().url(),
        secret: z.string().min(16).optional(),
        events: z.array(z.string()).min(1),
      }),
    );
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
    const body = await jsonBody(
      c,
      z.object({
        format: z.enum([
          "resolve_edl",
          "avid_txt",
          "avid_xml",
          "xmeml",
          "fcpxml",
          "csv",
          "json",
          "text",
          "pdf",
        ]),
        filters: z.record(z.unknown()).default({}),
        timecode_base: z.enum(["source", "record_run"]).default("source"),
      }),
    );
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
        job.id,
        job.resultBlobKey,
        attachmentDisposition(filename),
      ),
      expires_at: env.clock.now() + 15 * 60 * 1000,
    });
  });

  api.post("/s/:slug/access", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
    await hitRateLimit(`share_access:${share.id}:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(
      c,
      z.object({
        passphrase: z.string().optional(),
        name: z.string().min(1).max(200).optional(),
        email: z.string().email().optional(),
      }),
    );
    if (
      share.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, share.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const viewer = await issueViewer(c, share, body.name, body.email);
    return c.json({ share: shareWire(share), viewer_key: viewer.viewerKey });
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

  root.get("/s/:slug", async (c) =>
    c.json(await publicShare(c, await shareBySlug(c.req.param("slug")))),
  );

  root.post("/s/:slug/access", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
    await hitRateLimit(`share_access:${share.id}:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(
      c,
      z.object({
        passphrase: z.string().optional(),
        name: z.string().min(1).max(200).optional(),
        email: z.string().email().optional(),
      }),
    );
    if (
      share.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, share.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const viewer = await issueViewer(c, share, body.name, body.email);
    return c.json({ share: shareWire(share), viewer_key: viewer.viewerKey });
  });

  api.get("/s/:slug", async (c) =>
    c.json(await publicShare(c, await shareBySlug(c.req.param("slug")))),
  );

  api.get("/s/:slug/assets", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    return c.json({
      items: projection.assets.map((asset: PublicShareAsset) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        status: asset.status,
        current_version_id: asset.currentVersionId,
        sort_order: asset.sort_order,
      })),
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
    const items = [];
    for (const version of visibleVersions) {
      const versionRenditions = await env.db
        .select()
        .from(renditions)
        .where(
          and(eq(renditions.versionId, version.id), isNull(renditions.shareId)),
        )
        .all();
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
    return c.json({
      items: rows.map((comment: typeof comments.$inferSelect) =>
        commentWire(comment),
      ),
    });
  });

  api.post("/s/:slug/assets/:assetId/comments", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
    await hitRateLimit(`share_comment:${share.id}:${ip}`, 30, 5 * 60 * 1000);
    const projection = await publicShare(c, share);
    if (!projection.viewer || !projection.viewer.viewerKey)
      throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset || !asset.currentVersionId) throw errors.notFound();
    const body = await jsonBody(
      c,
      z.object({
        frame_in: z.number().int().nonnegative().optional(),
        frame_out: z.number().int().nonnegative().optional(),
        body_text: z.string().min(1).max(10000),
        annotation: z.unknown().optional(),
      }),
    );
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
    return c.json(commentWire(comment), 201);
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
    const { comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    const body = await jsonBody(
      c,
      z.object({
        body_text: z.string().min(1).max(10000),
        annotation: z.unknown().optional(),
      }),
    );
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
    return c.json(commentWire(updated));
  });

  api.delete("/s/:slug/comments/:commentId", async (c) => {
    const { comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    await env.db
      .update(comments)
      .set({ deletedAt: env.clock.now() })
      .where(eq(comments.id, comment.id))
      .run();
    return c.body(null, 204);
  });

  api.post("/s/:slug/comments/:commentId/replies", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    const projection = await publicShare(c, share);
    if (!projection.viewer) throw errors.unauthorized();
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
    if (!parent || parent.parentId)
      throw errors.validation("Replies cannot be nested.");
    const body = await jsonBody(
      c,
      z.object({
        body_text: z.string().min(1).max(10000),
        annotation: z.unknown().optional(),
      }),
    );
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
    return c.json(commentWire(reply), 201);
  });

  api.patch("/s/:slug/approval", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const projection = await publicShare(c, share);
    if (!projection.viewer) throw errors.unauthorized();
    const body = await jsonBody(
      c,
      z.object({
        asset_id: z.string(),
        status: z.enum(["none", "in_review", "approved", "changes_requested"]),
      }),
    );
    const asset = projection.assets.find(
      (candidate: PublicShareAsset) => candidate.id === body.asset_id,
    );
    if (!asset) throw errors.notFound();
    await env.db
      .update(assets)
      .set({ status: body.status, updatedAt: env.clock.now() })
      .where(eq(assets.id, asset.id))
      .run();
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
    const rendition = (
      await env.db
        .select()
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, asset.currentVersionId),
            eq(renditions.kind, "proxy_1080"),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!rendition) throw errors.notFound("A review rendition is not ready.");
    return c.json({
      url: await publicMediaUrl(
        projection.share,
        asset.id,
        asset.currentVersionId,
        rendition.blobKey,
      ),
      expires_at: env.clock.now() + 15 * 60 * 1000,
    });
  });

  api.get("/s/:slug/assets/:assetId/media/file", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    const token = c.req.query("token");
    if (!token || !env.blobStore) throw errors.unauthorized();
    let blobKey: string;
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
    } catch {
      throw errors.unauthorized();
    }
    return serveBlob(c, blobKey);
  });

  api.post("/uploads", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(
      c,
      z.object({
        project_id: z.string(),
        filename: z.string().min(1).max(500),
        relative_path: z.string().max(2000).default(""),
        size: z.number().int().positive(),
        checksum_crc32c: z
          .string()
          .regex(/^[A-Za-z0-9+/=_-]+$/)
          .optional(),
      }),
    );
    await requireProject(body.project_id, actor, "editor");
    if ((body.relative_path ?? "").split(/[\\/]/).includes(".."))
      throw errors.validation("Relative path cannot contain parent segments.");
    const uploadId = env.ids.ulid();
    const filename = body.filename.replace(/[\\/]/g, "_");
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
    actor: typeof users.$inferSelect,
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

  api.post("/uploads/:id/multipart", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const store = requireBlobStore();
    if (upload.status === "completed")
      return c.json({ upload: uploadWire(upload) });
    if (upload.status === "quarantined" || upload.status === "aborted")
      throw errors.conflict("This upload cannot be resumed.");
    if (upload.status === "uploading" && upload.uploadId && upload.partSize)
      return c.json({
        upload: uploadWire(upload),
        upload_id: upload.uploadId,
        part_size: upload.partSize,
      });
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
    return c.json({
      upload: uploadWire(updated),
      upload_id: created.uploadId,
      part_size: created.partSize,
    });
  });

  api.get("/uploads/:id/parts", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const rows = await env.db
      .select()
      .from(uploadParts)
      .where(eq(uploadParts.uploadId, upload.id))
      .orderBy(asc(uploadParts.partNo))
      .all();
    return c.json({
      items: rows.map((part: typeof uploadParts.$inferSelect) => ({
        part_no: part.partNo,
        etag: part.etag,
        size: part.size,
        completed_at: part.completedAt,
      })),
    });
  });

  api.get("/uploads/:id/parts/:partNo/url", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const partNo = Number(c.req.param("partNo"));
    if (!upload.uploadId || !Number.isInteger(partNo) || partNo < 1)
      throw errors.validation("Part number is invalid.");
    return c.json({ url: `/api/v1/uploads/${upload.id}/parts/${partNo}` });
  });

  api.put("/uploads/:id/parts/:partNo", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const store = requireBlobStore();
    if (!upload.uploadId || !c.req.raw.body)
      throw errors.validation("Multipart upload is not initialized.");
    const partNo = Number(c.req.param("partNo"));
    if (!Number.isInteger(partNo) || partNo < 1)
      throw errors.validation("Part number is invalid.");
    // Part bodies are capped at the session part size plus 1 MiB of slack.
    const maxPartBytes = (upload.partSize ?? 16 * 1024 * 1024) + 1_048_576;
    const declaredPartLength = Number(c.req.header("content-length") ?? 0);
    if (declaredPartLength > maxPartBytes) throw errors.payloadTooLarge();
    const result = await store.putPart(
      upload.uploadId,
      partNo,
      limitStream(c.req.raw.body, maxPartBytes),
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
    c.header("etag", result.etag);
    return c.body(null, 204);
  });

  api.post("/uploads/:id/complete", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const upload = await findUpload(c.req.param("id"), actor);
    const store = requireBlobStore();
    const body = await jsonBody(
      c,
      z.object({
        parts: z
          .array(
            z.object({
              part_no: z.number().int().positive(),
              etag: z.string(),
            }),
          )
          .min(1),
        checksum_crc32c: z.string().optional(),
      }),
    );
    if (!upload.uploadId)
      throw errors.validation("Multipart upload is not initialized.");
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
    for (const part of body.parts) {
      const persisted = persistedByNumber.get(part.part_no);
      if (!persisted || persisted.etag !== part.etag)
        throw errors.validation(
          "Every completed part must match an uploaded part.",
        );
    }
    await store.completeMultipart(
      upload.blobKey,
      upload.uploadId,
      body.parts.map((part) => ({ partNo: part.part_no, etag: part.etag })),
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
    return c.json({ upload: uploadWire(updated) }, 202);
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

  api.post("/projects/:id/assets", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "editor");
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().max(500).optional(),
        folder_id: z.string().nullable().optional(),
        upload_id: z.string(),
      }),
    );
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
    const now = env.clock.now();
    const assetId = env.ids.ulid();
    const versionId = env.ids.ulid();
    await env.db
      .insert(assets)
      .values({
        id: assetId,
        projectId: upload.projectId,
        folderId: body.folder_id ?? null,
        name: body.name?.trim() || upload.clientFilename,
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
          workspace_id: actor.workspaceId,
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
    return c.json(
      {
        id: assetId,
        name: body.name?.trim() || upload.clientFilename,
        kind: assetKind(upload.clientFilename),
        status: "none",
        current_version_id: versionId,
        version_id: versionId,
        job_id: jobId,
        created_at: now,
        updated_at: now,
      },
      201,
    );
  });

  api.get("/projects/:id/assets", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "viewer");
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const folderId = c.req.query("folder_id");
    const rows = await env.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.projectId, c.req.param("id")),
          isNull(assets.deletedAt),
          folderId ? eq(assets.folderId, folderId) : undefined,
          cursor ? lt(assets.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(assets.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map((asset: typeof assets.$inferSelect) => assetWire(asset)),
      next_cursor:
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
  });

  const assetForActor = async (
    id: string,
    actor: typeof users.$inferSelect,
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
    const asset = await assetForActor(c.req.param("id"), actor);
    return c.json(assetWire(asset));
  });

  api.patch("/assets/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "editor");
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().min(1).max(500).optional(),
        folder_id: z.string().nullable().optional(),
        status: z
          .enum(["none", "in_review", "approved", "changes_requested"])
          .optional(),
        description: z.string().max(10000).optional(),
        tags: z.array(z.string().min(1).max(100)).max(100).optional(),
      }),
    );
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

  api.get("/assets/:id/versions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor);
    const rows = await env.db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, asset.id))
      .orderBy(desc(assetVersions.versionNo))
      .all();
    return c.json({
      items: rows.map((version: typeof assetVersions.$inferSelect) =>
        versionWire(version),
      ),
    });
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
              ? await privateMediaUrl(version.id, rendition.blobKey)
              : null,
            vtt_url:
              env.blobStore && vttKey
                ? await privateMediaUrl(version.id, vttKey)
                : null,
          };
        }),
      ),
    });
  });

  api.patch("/versions/:id/stack", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(
      c,
      z.object({ version_no: z.number().int().positive() }),
    );
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
          cursor ? lt(jobs.id, cursor) : undefined,
          status ? eq(jobs.status, status) : undefined,
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map((job: typeof jobs.$inferSelect) => jobWire(job)),
      next_cursor:
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
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
      if (
        verified.payload.blob_key !== key ||
        typeof verified.payload.version_id !== "string"
      )
        throw new Error("Token claims do not match this media key.");
      // Content-disposition comes from the verified claim only, sanitized.
      if (typeof verified.payload.disposition === "string")
        disposition = sanitizeDisposition(verified.payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    return serveBlob(c, key, disposition);
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
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map((entry: typeof auditLog.$inferSelect) => ({
        id: entry.id,
        actor_user_id: entry.actorUserId,
        action: entry.action,
        target: entry.target,
        meta: parseJsonObject(entry.metaJson),
        at: entry.at,
      })),
      next_cursor:
        rows.length > limit
          ? encodeCursor(page[page.length - 1]?.id ?? "")
          : null,
    });
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
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";
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

  // The OpenAPI paths object is generated from the routes registered on the
  // Hono app (the REST API is a public contract; a hand-maintained map
  // drifts). Built lazily at first request so every route is registered.
  const openApiMethods = new Set(["get", "post", "put", "patch", "delete"]);
  const toOpenApiPath = (path: string): string =>
    path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*/g, "{path}");
  let openApiPathsCache: Record<string, Record<string, unknown>> | undefined;
  const buildOpenApiPaths = (): Record<string, Record<string, unknown>> => {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const route of api.routes) {
      const method = route.method.toLowerCase();
      if (!openApiMethods.has(method)) continue;
      if (route.path === "/openapi.json" || route.path === "/docs") continue;
      const path = toOpenApiPath(`/api/v1${route.path}`);
      const entry = (paths[path] ??= {});
      if (entry[method]) continue;
      entry[method] = {
        responses: {
          [method === "post" ? "201" : method === "delete" ? "204" : "200"]: {
            description: `${method.toUpperCase()} ${path}`,
          },
          "400": { description: "Validation failure" },
          "401": { description: "Authentication required" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      };
    }
    return paths;
  };
  api.get("/openapi.json", (c) => {
    openApiPathsCache ??= buildOpenApiPaths();
    return c.json({
      openapi: "3.1.0",
      info: { title: "Onelight API", version: env.version },
      paths: openApiPathsCache,
    });
  });
  const docsHtml =
    '<!doctype html><html><head><title>Onelight API</title></head><body><h1>Onelight API</h1><p>OpenAPI document: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a></p></body></html>';
  api.get("/docs", (c) => c.html(docsHtml));

  root.route("/api/v1", api);
  // Phase 0 places the reference UI at /api/docs.
  root.get("/api/docs", (c) => c.html(docsHtml));
  root.all("/s/*", (c) => api.fetch(c.req.raw));
  root.get("/healthz", (c) => c.json({ status: "ok", version: env.version }));
  return root;
};

export const createApp = (env: AppEnv): Hono<{ Variables: Variables }> =>
  app(env);
