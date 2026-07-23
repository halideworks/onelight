import fs from "node:fs";
import { readFile, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { compress } from "hono/compress";
import {
  buildShareOgTags,
  createApp,
  deliverDueWebhookDeliveries,
} from "@onelight/api";
import {
  loadConfig,
  UlidGenerator,
  isSmtpConfigError,
  mailSettingsToInput,
  parseSmtpConfig,
  systemClock,
} from "@onelight/core";
import type { Mailer, SmtpConfig, StoredMailSettings } from "@onelight/core";
import { eq } from "drizzle-orm";
import {
  applyNodeMigrations,
  createNodeDb,
  users,
  workspaces,
} from "@onelight/db";
import { appSettings } from "@onelight/db/schema";
import { LocalBlobStore } from "@onelight/worker";
import { createMailerForConfig } from "./mailer.js";
import { maintenanceConfigFromEnv, startMaintenance } from "./maintenance.js";
import { backupConfigFromEnv, startBackups } from "./backup.js";
import { NodePasswordHasher } from "./password.js";
import { spriteFrameMatcher } from "./reanchor.js";
import { isShareLandingPath } from "./share-shell.js";
import { startWorkerPump } from "./worker-pump.js";

const config = loadConfig(process.env);
fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });
const { db, sqlite } = createNodeDb(config.DATABASE_PATH);
applyNodeMigrations(sqlite);

const ensureHeadlessAdmin = async (): Promise<void> => {
  if (!config.ONELIGHT_ADMIN_EMAIL || !config.ONELIGHT_ADMIN_PASSWORD) return;
  const existing = await db.select({ id: users.id }).from(users).limit(1).all();
  if (existing.length) return;
  const now = systemClock.now();
  const ids = new UlidGenerator();
  const workspaceId = ids.ulid();
  const userId = ids.ulid();
  const hasher = new NodePasswordHasher();
  await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: config.ONELIGHT_WORKSPACE_NAME,
      settingsJson: "{}",
      createdAt: now,
    })
    .run();
  await db
    .insert(users)
    .values({
      id: userId,
      workspaceId,
      email: config.ONELIGHT_ADMIN_EMAIL.toLowerCase(),
      name: config.ONELIGHT_ADMIN_EMAIL.split("@")[0] ?? "Admin",
      role: "admin",
      passwordHash: await hasher.hash(config.ONELIGHT_ADMIN_PASSWORD),
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
};

// One consolidated shutdown path: close the HTTP server, stop the pump and
// timers, close sqlite, then exit so docker stop never waits for SIGKILL.
const cleanups: Array<() => void> = [];
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Best effort; keep shutting down.
    }
  }
  try {
    sqlite.close();
  } catch {
    // Already closed.
  }
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

const start = async (): Promise<void> => {
  await ensureHeadlessAdmin();
  const blobRoot =
    process.env.BLOB_ROOT ??
    path.join(path.dirname(config.DATABASE_PATH), "blobs");
  const blobStore = new LocalBlobStore(blobRoot);
  /* Dynamic mail control: admin settings (app_settings key "mail") take
     precedence over the environment, resolved per use so a settings change
     applies without a restart. The status distinguishes "never configured"
     from "configured but unusable": neither can send, but the second must
     not read as the operator having chosen silence. */
  type MailResolution = {
    state: "ready" | "disabled" | "error";
    detail: string | null;
    source: "settings" | "env" | "none";
    config: SmtpConfig | null;
  };
  const resolveMail = async (): Promise<MailResolution> => {
    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "mail"))
      .all();
    const row = rows[0];
    if (row) {
      let stored: StoredMailSettings | null = null;
      try {
        stored = JSON.parse(row.valueJson) as StoredMailSettings;
      } catch {
        stored = null;
      }
      const parsed = stored
        ? parseSmtpConfig(mailSettingsToInput(stored))
        : null;
      if (parsed === null)
        return {
          state: "error",
          detail: "The stored mail settings are unreadable.",
          source: "settings",
          config: null,
        };
      if (isSmtpConfigError(parsed))
        return {
          state: "error",
          detail: parsed.error,
          source: "settings",
          config: null,
        };
      return {
        state: "ready",
        detail: null,
        source: "settings",
        config: parsed,
      };
    }
    const fromEnv = parseSmtpConfig(process.env);
    if (fromEnv === null)
      return { state: "disabled", detail: null, source: "none", config: null };
    if (isSmtpConfigError(fromEnv))
      return {
        state: "error",
        detail: fromEnv.error,
        source: "env",
        config: null,
      };
    return { state: "ready", detail: null, source: "env", config: fromEnv };
  };
  let mailTransportCache: { json: string; mailer: Mailer } | null = null;
  const mail = {
    status: async (): Promise<Omit<MailResolution, "config">> => {
      const resolution = await resolveMail();
      return {
        state: resolution.state,
        detail: resolution.detail,
        source: resolution.source,
      };
    },
    send: async (message: {
      to: string;
      subject: string;
      text: string;
    }): Promise<void> => {
      const resolution = await resolveMail();
      if (!resolution.config)
        throw new Error(resolution.detail ?? "Email is not configured.");
      const json = JSON.stringify(resolution.config);
      if (!mailTransportCache || mailTransportCache.json !== json)
        mailTransportCache = {
          json,
          mailer: createMailerForConfig(resolution.config),
        };
      await mailTransportCache.mailer.send(message);
    },
    reload: (): void => {
      mailTransportCache = null;
    },
  };
  /* The blob volume's capacity, from the filesystem that actually holds it.
     Object-storage deployments have no equivalent, which is why the field is
     optional on AppEnv and null on the wire there. */
  const diskInfo = async (): Promise<{
    total_bytes: number;
    free_bytes: number;
  } | null> => {
    try {
      const stats = await statfs(blobRoot);
      return {
        total_bytes: stats.blocks * stats.bsize,
        free_bytes: stats.bavail * stats.bsize,
      };
    } catch {
      return null;
    }
  };
  const backupConfig = backupConfigFromEnv(process.env);
  /* Host facts for the admin system page: the database file's size and the
     snapshot state of BACKUP_DIR. Both are best-effort reads; the page
     renders nulls rather than the server failing over a stat. */
  const systemInfo = async (): Promise<{
    db_size_bytes: number | null;
    backups: { count: number; newest_at: number | null } | null;
  }> => {
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = (await stat(config.DATABASE_PATH)).size;
    } catch {
      dbSizeBytes = null;
    }
    let backups: { count: number; newest_at: number | null } | null = null;
    if (backupConfig) {
      try {
        const names = fs
          .readdirSync(backupConfig.dir)
          .filter((name) => /^onelight-\d{8}-\d{6}\.db$/.test(name))
          .sort();
        const newest = names[names.length - 1];
        backups = {
          count: names.length,
          newest_at: newest
            ? Math.round(
                fs.statSync(path.join(backupConfig.dir, newest)).mtimeMs,
              )
            : null,
        };
      } catch {
        backups = { count: 0, newest_at: null };
      }
    }
    return { db_size_bytes: dbSizeBytes, backups };
  };
  const api = createApp({
    db,
    hasher: new NodePasswordHasher(),
    clock: systemClock,
    ids: new UlidGenerator(),
    config,
    version: process.env.ONELIGHT_VERSION ?? "0.1.0-dev",
    blobStore,
    diskInfo,
    systemInfo,
    startedAt: Date.now(),
    frameMatcher: spriteFrameMatcher(db, blobRoot),
    mail,
  });
  const webRoot = process.env.WEB_ROOT ?? "packages/web/build";
  const app = new Hono();
  const shell = serveStatic({ root: webRoot, path: "index.html" });
  // The built shell is read once; share requests get OG meta tags injected
  // before </head> so link unfurls describe the share.
  let shellHtml: string | null | undefined;
  const loadShellHtml = async (): Promise<string | null> => {
    if (shellHtml !== undefined) return shellHtml;
    try {
      shellHtml = await readFile(path.join(webRoot, "index.html"), "utf8");
    } catch {
      shellHtml = null;
    }
    return shellHtml;
  };
  /* Baseline response hardening. Frames are same-origin (nothing here is
     built to be embedded elsewhere today), sniffing is off, and referrers
     stay inside the origin so share slugs never leak through outbound
     links. HSTS is sent only when the origin is https, since it cannot be
     honoured -- and would pin a broken state -- over plain http. */
  const hstsValue =
    config.PUBLIC_URL.startsWith("https://")
      ? "max-age=31536000; includeSubDomains"
      : null;
  /* Everything the app itself needs and nothing more: its own scripts, styles
     and fonts; data:/blob: pictures and media (posters, lightbox, the player);
     same-origin XHR/SSE. object-src none kills plugin embeds, frame-ancestors
     self replaces X-Frame-Options for modern browsers, base-uri self stops a
     tag rewriting relative URLs. SvelteKit's bootstrap is inline, so
     script/style keep 'unsafe-inline' -- the frontend carries no {@html} or
     other injection sink, so this is defence in depth, not the only line.
     Applied to HTML documents only; API JSON and the sandboxed media/logo
     routes keep their own response headers. */
  const documentCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("x-frame-options", "SAMEORIGIN");
    if (hstsValue) c.header("strict-transport-security", hstsValue);
    if ((c.res.headers.get("content-type") ?? "").includes("text/html"))
      c.header("content-security-policy", documentCsp);
  });
  /* Compress the compressible: JSON list payloads, the HTML shell, the JS/CSS
     bundles. The default filter is a content-type allowlist, so already-packed
     video, images and audio streams are left alone rather than burning CPU on
     incompressible bytes. Deployments behind Caddy can also `encode` at the
     edge; this makes a bare node deploy compress on its own. */
  app.use("*", compress());
  app.use("*", async (c, next) => {
    if (
      isShareLandingPath(c.req.path) &&
      (c.req.header("accept") ?? "").includes("text/html")
    ) {
      const html = await loadShellHtml();
      if (html === null) return shell(c, next);
      const rawSlug = c.req.path.split("/")[2] ?? "";
      let slug = rawSlug;
      try {
        slug = decodeURIComponent(rawSlug);
      } catch {
        // Keep the raw segment when it is not valid percent-encoding.
      }
      let page = html;
      if (slug) {
        try {
          const tags = await buildShareOgTags(db, slug, config.PUBLIC_URL);
          if (tags) page = page.replace("</head>", `${tags}</head>`);
        } catch (error) {
          console.warn(
            `[onelight] OG tags for share ${slug} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return c.html(page);
    }
    await next();
  });
  app.route("/", api);
  /* SvelteKit fingerprints everything under _app/immutable/, so its bytes can
     never change under a given URL: serve them with a year-long immutable
     cache instead of the no-header default that re-fetched them every visit.
     Everything else (index.html, favicon) keeps default revalidation. */
  const immutableStatic = serveStatic({
    root: webRoot,
    onFound: (foundPath, c) => {
      if (foundPath.includes("/_app/immutable/"))
        c.header("cache-control", "public, max-age=31536000, immutable");
    },
  });
  app.use("*", immutableStatic);
  app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
  const server = serve({
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.HOST,
  });
  const stopWorkerPump = startWorkerPump(db, {
    ...(process.env.WORKER_URL ? { workerUrl: process.env.WORKER_URL } : {}),
    ...(process.env.WORKER_SECRET
      ? { workerSecret: process.env.WORKER_SECRET }
      : {}),
    blobRoot,
  });
  const stopBackups = backupConfig ? startBackups(sqlite, backupConfig) : null;
  if (!backupConfig)
    console.warn(
      "[onelight] Backups are disabled: set BACKUP_DIR to write periodic database snapshots.",
    );
  const stopMaintenance = startMaintenance(
    db,
    maintenanceConfigFromEnv(process.env, {
      publicUrl: config.PUBLIC_URL,
      blobStore,
    }),
    async () => {
      if ((await mail.status()).state !== "ready") return null;
      /* The digest switch lives beside the mail settings; off means the
         sweep marks rows handled without sending, same as no transport. */
      const rows = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, "mail_policy"))
        .all();
      try {
        const parsed = rows[0]
          ? (JSON.parse(rows[0].valueJson) as { digests?: boolean })
          : {};
        if (parsed.digests === false) return null;
      } catch {
        /* Unreadable policy defaults to sending. */
      }
      return { send: mail.send };
    },
  );
  /* One sweep at a time. A delivery can take up to 15s, so a sweep of several
     slow endpoints easily outruns the 5s tick; without this guard the next
     tick starts a second concurrent sweep that races the first on the same due
     rows and double-delivers. */
  let webhookSweeping = false;
  const webhookTimer = setInterval(() => {
    if (webhookSweeping) return;
    webhookSweeping = true;
    void deliverDueWebhookDeliveries(db, Date.now()).finally(() => {
      webhookSweeping = false;
    });
  }, 5_000);
  cleanups.push(
    () => clearInterval(webhookTimer),
    stopMaintenance,
    ...(stopBackups ? [stopBackups] : []),
    stopWorkerPump,
    () => server.close(),
  );
  console.log(`Onelight listening at ${config.PUBLIC_URL}`);
};

void start();
