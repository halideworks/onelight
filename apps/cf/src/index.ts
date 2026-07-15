import {
  buildShareOgTags,
  createApp,
  deliverDueWebhookDeliveries,
} from "@onelight/api";
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
// delivery (via the cron trigger in wrangler.jsonc). ffmpeg cannot run on
// Workers, so transcode is out of scope here: renditions require the Docker
// media worker (apps/worker) pointed at the same storage, and that worker
// currently speaks only the local filesystem protocol. Until an R2-speaking
// pump exists (reading sources and writing renditions through signed R2
// URLs), versions uploaded through this target keep transcode_status
// "pending".

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
    // The cron trigger is the delivery loop for queued and retried webhook
    // deliveries; the Node target runs the same function on a timer.
    await applyD1Migrations(env.DB);
    await deliverDueWebhookDeliveries(createD1Db(env.DB), Date.now());
  },
};
