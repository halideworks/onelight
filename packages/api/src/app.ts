import { Hono } from "hono";
import type { Variables, AppEnv } from "./types.js";
import type { Context } from "hono";
import { mapError } from "./helpers.js";
import { redactBearerPath } from "./request-log.js";
import { authMiddleware, requireOrigin } from "./auth.js";
import { sql } from "drizzle-orm";
import { createMail } from "./operation/mail.js";
import { createAccess } from "./operation/access.js";
import { createBlobs } from "./operation/blobs.js";
import { createActivity } from "./operation/activity.js";
import { createComments } from "./operation/comments.js";
import { createIdentity } from "./operation/identity.js";
import { createUploads } from "./operation/uploads.js";
import { createMedia } from "./operation/media.js";
import { createProjects } from "./operation/projects.js";
import { createShares } from "./operation/shares.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerUsersRoutes } from "./routes/users.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerCommentsRoutes } from "./routes/comments.js";
import { registerNotificationsRoutes } from "./routes/notifications.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSharesRoutes } from "./routes/shares.js";
import { registerDownloadsRoutes } from "./routes/downloads.js";
import { registerPublicSharesRoutes } from "./routes/public-shares.js";
import { registerShareCommentsRoutes } from "./routes/share-comments.js";
import { registerTransfersRoutes } from "./routes/transfers.js";
import { registerUploadsRoutes } from "./routes/uploads.js";
import { registerAssetsRoutes } from "./routes/assets.js";
import { registerAssetInspectorRoutes } from "./routes/asset-inspector.js";
import { registerMatchingRoutes } from "./routes/matching.js";
import { registerVersionsRoutes } from "./routes/versions.js";
import { registerVersionStacksRoutes } from "./routes/version-stacks.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerOpenapiRoutes } from "./routes/openapi.js";

export const createApp = (env: AppEnv): Hono<{ Variables: Variables }> => {
  const root = new Hono<{ Variables: Variables }>();

  const api = new Hono<{ Variables: Variables }>();

  const errorHandler = (
    error: unknown,
    c: Context<{ Variables: Variables }>,
  ) => {
    const mapped = mapError(error);
    const requestId = c.get("requestId") ?? env.ids.ulid();
    c.header("x-request-id", requestId);
    /* An expected refusal -- a validation failure, a missing row, a rate limit
       -- is already described by the envelope it turns into. An unexpected one
       is not: the caller is told "an internal error occurred" and given a
       request id, and until now nothing anywhere said what actually happened.
       An operator reading their own logs had a request id and no error.

       So the exception is logged exactly once, where it is caught, with the id
       the envelope carries. */
    if (mapped.code === "internal")
      console.error(
        `[onelight] ${c.req.method} ${redactBearerPath(c.req.path)} failed req=${requestId}: ${
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
            : String(error)
        }`,
      );
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
    if (
      (c.res.headers.get("content-type") ?? "").includes("application/json") &&
      !c.res.headers.has("cache-control")
    )
      c.header("cache-control", "private, no-store");
    if (status >= 400 || ms > 1000)
      console.log(
        `[onelight] ${c.req.method} ${redactBearerPath(path)} ${String(status)} ${String(ms)}ms req=${c.get("requestId") ?? "-"}`,
      );
  });

  root.use("*", authMiddleware(env));
  root.use("*", requireOrigin(env));

  const mail = createMail(env);
  const access = createAccess(env);
  const blobs = createBlobs(env);
  const activity = createActivity(env);
  const comments = createComments(env, blobs);
  const identity = createIdentity(env);
  const uploads = createUploads(env, blobs, access, activity);
  const media = createMedia(env, access);
  const projects = createProjects(env, media, access);
  const shares = createShares(env, media);

  registerAuthRoutes(api, env, { identity, activity, mail, access });
  registerWorkspaceRoutes(api, env, { access, mail, activity });
  registerUsersRoutes(api, env, { identity, activity, blobs, mail, access });
  registerProjectsRoutes(api, env, {
    projectsOps: projects,
    access,
    activity,
    uploads,
    media,
    blobs,
  });
  registerCommentsRoutes(api, env, {
    access,
    commentsOps: comments,
    activity,
    media,
    blobs,
  });
  registerNotificationsRoutes(api, env, { activity });
  registerSearchRoutes(api, env, { access, projectsOps: projects });
  registerSharesRoutes(api, env, {
    access,
    mail,
    identity,
    activity,
    sharesOps: shares,
    blobs,
  });
  registerDownloadsRoutes(api, env, { access, media, blobs });
  registerPublicSharesRoutes(api, root, env, {
    sharesOps: shares,
    identity,
    blobs,
    media,
  });
  registerShareCommentsRoutes(api, env, {
    sharesOps: shares,
    commentsOps: comments,
    identity,
    activity,
    media,
    blobs,
  });
  registerTransfersRoutes(api, env, {
    access,
    activity,
    identity,
    blobs,
    media,
    uploads,
  });
  registerUploadsRoutes(api, env, { access, uploads, blobs });
  registerAssetsRoutes(api, env, { access, uploads, activity, media, blobs });
  registerAssetInspectorRoutes(api, env, { access });
  registerMatchingRoutes(api, env, { access });
  registerVersionsRoutes(api, env, {
    access,
    activity,
    commentsOps: comments,
    identity,
    media,
    blobs,
  });
  registerVersionStacksRoutes(api, env, { access, activity, uploads });
  registerMediaRoutes(api, env, { media, blobs });
  registerOpenapiRoutes(api, root, env);

  // Liveness checks the process; readiness also checks database availability.
  // Both URL surfaces use the same handlers.
  const health = (c: Context<{ Variables: Variables }>) =>
    c.json({ status: "ok", version: env.version });
  const ready = async (c: Context<{ Variables: Variables }>) => {
    try {
      await env.db.run(sql`select 1`);
      return c.json({ status: "ready", version: env.version });
    } catch {
      return c.json({ status: "not_ready" }, 503);
    }
  };
  api.get("/healthz", health);
  api.get("/readyz", ready);
  root.get("/healthz", health);
  root.get("/readyz", ready);

  // Hono mounts the routes registered so far, so keep this after all domains.
  root.route("/api/v1", api);

  // Explicit legacy share handlers must precede this fallback. Forward the
  // runtime bindings so clientIp can read the real peer address on Node.
  root.all("/s/*", (c) => api.fetch(c.req.raw, c.env));

  return root;
};
