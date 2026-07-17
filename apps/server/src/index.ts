import fs from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  buildShareOgTags,
  createApp,
  deliverDueWebhookDeliveries,
} from "@onelight/api";
import { loadConfig, UlidGenerator, systemClock } from "@onelight/core";
import {
  applyNodeMigrations,
  createNodeDb,
  users,
  workspaces,
} from "@onelight/db";
import { LocalBlobStore } from "@onelight/worker";
import { createMailerFromEnv } from "./mailer.js";
import { maintenanceConfigFromEnv, startMaintenance } from "./maintenance.js";
import { backupConfigFromEnv, startBackups } from "./backup.js";
import { NodePasswordHasher } from "./password.js";
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
  const mailer = createMailerFromEnv(process.env);
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
  const api = createApp({
    db,
    hasher: new NodePasswordHasher(),
    clock: systemClock,
    ids: new UlidGenerator(),
    config,
    version: process.env.ONELIGHT_VERSION ?? "0.1.0-dev",
    blobStore,
    diskInfo,
    // AppEnv.mailer is optional and exactOptionalPropertyTypes is on, so
    // the field is present only when a mailer is configured.
    ...(mailer ? { mailer } : {}),
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
  app.use("*", serveStatic({ root: webRoot }));
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
  const backupConfig = backupConfigFromEnv(process.env);
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
    mailer,
  );
  const webhookTimer = setInterval(() => {
    void deliverDueWebhookDeliveries(db, Date.now());
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
