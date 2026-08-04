import {
  buildShareOgTags,
  createApp,
  deliverDueWebhookDeliveries,
} from "@onelight/api";
import { createWorkerRoutes, sweepUnclaimedWork } from "@onelight/job-protocol";
import {
  loadConfig,
  Pbkdf2PasswordHasher,
  UlidGenerator,
} from "@onelight/core";
import { applyD1Migrations, createD1Db } from "@onelight/db/cf";
import type { Env } from "./env.js";
import { R2BlobStore } from "./r2-store.js";

// Deployment model for the Workers target: this Worker serves the SPA, the
// REST API, uploads to R2, review serving, comments, shares, and webhook
// delivery (via the cron trigger in wrangler.jsonc).
//
// ffmpeg still cannot run on Workers, and never will. What changed is that it
// no longer has to: a media worker claims its jobs over /api/v1/worker,
// downloads each source through a signed URL, encodes on its own machine and
// PUTs what it produced back. So this target mounts the same job protocol the
// node server does -- one implementation, two deployments -- and the only
// difference is that a job here names its storage by key alone, because there
// is no filesystem to name.
//
// Renditions therefore need a docker worker (apps/worker) pointed at this
// Worker with a matching WORKER_SECRET. Without one, nothing can claim, and
// versions keep transcode_status "pending" exactly as before.

// Build the app once per isolate instead of per request. The D1 binding is
// stable for the isolate's lifetime, so it doubles as the cache key, the
// same way applyD1Migrations memoizes per binding.
const apps = new WeakMap<D1Database, ReturnType<typeof createApp>>();

const getApp = (env: Env): ReturnType<typeof createApp> => {
  const cached = apps.get(env.DB);
  if (cached) return cached;
  const config = loadConfig({
    PUBLIC_URL: env.PUBLIC_URL,
    SECRET_KEY: env.SECRET_KEY,
    OIDC_ISSUER: env.OIDC_ISSUER,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
    OIDC_AUTO_PROVISION: env.OIDC_AUTO_PROVISION,
    OIDC_ALLOWED_DOMAINS: env.OIDC_ALLOWED_DOMAINS,
    ONELIGHT_ALLOWED_ORIGINS: env.ONELIGHT_ALLOWED_ORIGINS,
    PORT: "8787",
    HOST: "0.0.0.0",
    DATABASE_PATH: ":d1:",
  });
  const app = createApp({
    db: createD1Db(env.DB),
    hasher: new Pbkdf2PasswordHasher(),
    clock: { now: () => Date.now() },
    ids: new UlidGenerator(),
    config,
    version: "0.1.0-cf",
    blobStore: new R2BlobStore(env.BLOBS),
  });
  /* The worker-facing surface, mounted beside the user-facing one. No blob
     root: storage here is R2, so the envelope carries keys and signed URLs and
     never a path. */
  app.route(
    "/",
    createWorkerRoutes({
      db: createD1Db(env.DB),
      store: new R2BlobStore(env.BLOBS),
      ...(env.WORKER_SECRET ? { workerSecret: env.WORKER_SECRET } : {}),
    }),
  );
  apps.set(env.DB, app);
  return app;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Memoized per binding inside @onelight/db: a no-op after the first
    // request in an isolate, and a failed run is retried on the next one.
    await applyD1Migrations(env.DB);
    const app = getApp(env);
    const pathname = new URL(request.url).pathname;
    if (
      env.ASSETS &&
      pathname.startsWith("/s/") &&
      (request.headers.get("accept") ?? "").includes("text/html")
    ) {
      const shell = await env.ASSETS.fetch(
        new Request(new URL("/index.html", request.url), request),
      );
      // Server-render Open Graph tags into the shell so link unfurlers,
      // which never run the SPA, see the share title. Unknown, revoked,
      // expired, or unresolvable slugs serve the shell untouched.
      const slug = pathname.split("/")[2];
      if (!shell.ok || !slug) return shell;
      let tags: string | null = null;
      try {
        tags = await buildShareOgTags(createD1Db(env.DB), slug, env.PUBLIC_URL);
      } catch {
        return shell;
      }
      if (!tags) return shell;
      const html = await shell.text();
      const headIndex = html.indexOf("</head>");
      if (headIndex === -1) return new Response(html, shell);
      const headers = new Headers(shell.headers);
      headers.delete("content-length");
      const injected =
        html.slice(0, headIndex) + tags + "\n" + html.slice(headIndex);
      return new Response(injected, { status: shell.status, headers });
    }
    if (
      env.ASSETS &&
      !pathname.startsWith("/api/") &&
      !pathname.startsWith("/s/") &&
      pathname !== "/healthz"
    ) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }
    return app.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // The cron trigger is this target's equivalent of the node pump's timer.
    //
    // It used to deliver webhooks and nothing else, which left every sweep
    // unrun: nothing pulls the work that has to be *queued*. A watermark is
    // only rendered because a sweep noticed a share wanting one, and an
    // abandoned job is only retried because something noticed its lease had
    // expired. So a share sat at "202, pending" forever on a deployment where
    // uploads, transcodes and playback all worked.
    await applyD1Migrations(env.DB);
    const db = createD1Db(env.DB);
    const now = Date.now();
    await deliverDueWebhookDeliveries(db, now);
    await sweepUnclaimedWork(db, now, {
      mediaEnabled: Boolean(env.WORKER_SECRET),
    });
    /* Exports are NOT run here yet. They no longer need a filesystem -- the
       result goes to storage by key -- but they still import the PDF report
       builder and the SVG compositor from @onelight/worker, whose index
       reaches media.ts and therefore node:child_process. Mounting them here
       means lifting those two out of that graph first, exactly as the
       rendition planner was lifted. Until then a comment report requested on
       this target stays queued. */
  },
};
