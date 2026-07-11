import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp, deliverDueWebhookDeliveries } from "@onelight/api";
import { loadConfig, UlidGenerator, systemClock } from "@onelight/core";
import {
  applyNodeMigrations,
  createNodeDb,
  users,
  workspaces,
} from "@onelight/db";
import { LocalBlobStore } from "@onelight/worker";
import { NodePasswordHasher } from "./password.js";
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
  const api = createApp({
    db,
    hasher: new NodePasswordHasher(),
    clock: systemClock,
    ids: new UlidGenerator(),
    config,
    version: process.env.ONELIGHT_VERSION ?? "0.1.0-dev",
    blobStore: new LocalBlobStore(
      process.env.BLOB_ROOT ??
        path.join(path.dirname(config.DATABASE_PATH), "blobs"),
    ),
  });
  const webRoot = process.env.WEB_ROOT ?? "packages/web/build";
  const app = new Hono();
  const shell = serveStatic({ root: webRoot, path: "index.html" });
  app.use("*", async (c, next) => {
    if (
      c.req.path.startsWith("/s/") &&
      (c.req.header("accept") ?? "").includes("text/html")
    )
      return shell(c, next);
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
    blobRoot:
      process.env.BLOB_ROOT ??
      path.join(path.dirname(config.DATABASE_PATH), "blobs"),
  });
  const webhookTimer = setInterval(() => {
    void deliverDueWebhookDeliveries(db, Date.now());
  }, 5_000);
  cleanups.push(
    () => clearInterval(webhookTimer),
    stopWorkerPump,
    () => server.close(),
  );
  console.log(`Onelight listening at ${config.PUBLIC_URL}`);
};

void start();
