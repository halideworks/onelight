/* The worker protocol, which is internal.
 *
 * Deliberately not part of the public OpenAPI contract in packages/api: this
 * is how two halves of one deployment talk to each other, not a surface anyone
 * builds against, and putting it in the contract would make every change to it
 * a published breaking change.
 *
 * Workers pull. The server used to POST a job at one configured WORKER_URL and
 * long-poll it for the answer, which meant exactly one worker could exist and
 * a worker that restarted lost the job it was running. Here a worker asks for
 * work, is handed a self-contained envelope, reports progress against a lease,
 * and posts its result back. See specs/p0-3-stateless-workers.md.
 *
 * Two credentials, on purpose:
 *
 *   - The claim is signed with WORKER_SECRET, over the exact body bytes, with
 *     a timestamp the server checks for skew. Only something holding the
 *     shared secret can take work off the queue.
 *   - Everything after the claim is authorised by a token minted for that
 *     claim alone: HMAC(WORKER_SECRET, jobId:attempts:workerId). It is checked
 *     against the job's CURRENT attempt count, so a token from an earlier
 *     attempt cannot complete a job another worker has since taken, and it
 *     says nothing about any other job.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { hmacSha256Hex } from "@onelight/core";
import { completeJob, failJob, heartbeatJob } from "@onelight/db";
import type { AppDb } from "@onelight/db";
import { jobs } from "@onelight/db/schema";
import {
  applyWorkerJobResult,
  claimWorkerJob,
  recordDeadMediaJob,
  WORKER_LEASE_MS,
  workerJobTimeoutMs,
} from "./worker-pump.js";

/* Mirrors the skew the old push protocol allowed, and exists for the same
   reason: a captured signed claim cannot be replayed tomorrow. */
const SIGNATURE_SKEW_MS = 5 * 60_000;

/* A claim is a few hundred bytes; a completion carries media_info, which for a
   file with many streams is a few kilobytes. Generous against that, because
   the cost of refusing a legitimate completion is a version that never
   becomes ready, and still a bound: anything approaching this is not a
   worker reporting a job. */
const MAX_BODY_BYTES = 4 * 1_048_576;

const WORKER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const CAPABILITY = /^[a-z0-9_]{1,32}$/;
const HEX_64 = /^[0-9a-f]{64}$/i;

interface ClaimBody {
  worker_id?: unknown;
  capabilities?: unknown;
  timestamp?: unknown;
}

interface ReportBody {
  worker_id?: unknown;
  attempt?: unknown;
  token?: unknown;
  error?: unknown;
  result?: unknown;
}

/**
 * The token that scopes a worker to one attempt at one job.
 *
 * Derived rather than stored: the server checks it against the job row it has
 * to read anyway, and a server restart in the middle of an encode does not
 * invalidate the token of the worker still running it.
 */
export const attemptToken = (
  secret: string,
  jobId: string,
  attempts: number,
  workerId: string,
): string =>
  createHmac("sha256", secret)
    .update(`${jobId}:${String(attempts)}:${workerId}`)
    .digest("hex");

const hexMatches = (expected: string, presented: unknown): boolean => {
  if (typeof presented !== "string" || !HEX_64.test(presented)) return false;
  return timingSafeEqual(
    Buffer.from(presented.toLowerCase(), "hex"),
    Buffer.from(expected, "hex"),
  );
};

const capabilitiesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && CAPABILITY.test(entry),
        )
        .slice(0, 32)
    : [];

const asRecord = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * The worker-facing routes, mounted by the server process.
 *
 * `blobRoot` is here because planning a job resolves source and output paths
 * against it. When P0-2 replaces those with presigned URLs, this is the seam
 * that changes and the protocol above it does not.
 */
export const createWorkerRoutes = (options: {
  db: AppDb;
  blobRoot: string;
  workerSecret?: string | undefined;
}): Hono => {
  const app = new Hono();
  const { db, blobRoot } = options;
  const secret = options.workerSecret;

  /* A body has to be read before it can be authenticated -- the claim's
     signature is over its exact bytes -- so the size cap is enforced while it
     streams rather than after it is buffered. Everything here is small: a
     claim is a few hundred bytes and a completion carries media_info, which
     for a file with many streams is a few kilobytes. */
  app.use(
    "/api/v1/worker/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "body too large" }, 413),
    }),
  );

  /* Read the body once, as text: the signature is over the exact bytes the
     worker signed, not over a re-serialisation of them. */
  const bodyText = (c: Context): Promise<string> => c.req.text();

  /* Claim: the only route that takes the shared secret, and the only one that
     hands out authority. Everything after it presents the token this returns. */
  app.post("/api/v1/worker/claim", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const text = await bodyText(c);
    const signature = c.req.header("x-onelight-signature");
    if (!hexMatches(await hmacSha256Hex(secret, text), signature))
      return c.json({ error: "invalid worker signature" }, 401);
    const body = asRecord(text) as ClaimBody | null;
    if (!body) return c.json({ error: "invalid claim" }, 400);
    if (
      typeof body.timestamp !== "number" ||
      Math.abs(Date.now() - body.timestamp) > SIGNATURE_SKEW_MS
    )
      return c.json({ error: "stale or missing timestamp" }, 401);
    const workerId = body.worker_id;
    if (typeof workerId !== "string" || !WORKER_ID.test(workerId))
      return c.json({ error: "invalid worker_id" }, 400);
    const claimed = await claimWorkerJob(
      db,
      blobRoot,
      workerId,
      capabilitiesOf(body.capabilities),
    );
    /* 204 rather than an empty job: an idle queue is not an error, and the
       worker's loop reads the status instead of parsing a body to find out. */
    if (!claimed) return c.body(null, 204);
    return c.json({
      job_id: claimed.job.id,
      kind: claimed.job.kind,
      attempt: claimed.job.attempts,
      token: attemptToken(
        secret,
        claimed.job.id,
        claimed.job.attempts,
        workerId,
      ),
      lease_ms: WORKER_LEASE_MS,
      /* The ceiling is the server's policy and the worker's to enforce: the
         worker is the one process that can stop the work it started. */
      deadline_ms: workerJobTimeoutMs(),
      request: { job_id: claimed.job.id, ...claimed.request },
    });
  });

  /**
   * The job a report is for, if the presented token really is this attempt's.
   *
   * Every predicate is rechecked against the row rather than trusted from the
   * body: the job must still be processing, still be held by this worker, and
   * still be on the attempt the token was minted for. A worker whose lease
   * expired mid-encode gets 409 and knows to stop.
   */
  const authorise = async (
    c: Context,
  ): Promise<
    | { job: typeof jobs.$inferSelect; workerId: string; body: ReportBody }
    | { status: 400 | 401 | 404 | 409; error: string }
  > => {
    const refuse = (status: 400 | 401 | 404 | 409, error: string) => ({
      status,
      error,
    });
    const text = await bodyText(c);
    const body = asRecord(text) as ReportBody | null;
    if (!body) return refuse(400, "invalid report");
    const workerId = body.worker_id;
    if (typeof workerId !== "string" || !WORKER_ID.test(workerId))
      return refuse(401, "invalid job token");
    const jobId = c.req.param("id") ?? "";
    const job = jobId
      ? (
          await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).all()
        )[0]
      : undefined;
    if (!job) return refuse(404, "no such job");
    if (
      job.status !== "processing" ||
      job.workerId !== workerId ||
      job.attempts !== body.attempt
    )
      return refuse(409, "this attempt no longer holds the job");
    if (
      !secret ||
      !hexMatches(
        attemptToken(secret, job.id, job.attempts, workerId),
        body.token,
      )
    )
      return refuse(401, "invalid job token");
    return { job, workerId, body };
  };

  /* Progress pushes the lease out. A worker that stops reporting is how the
     server learns it is gone, so this is the heartbeat and not decoration. */
  app.post("/api/v1/worker/jobs/:id/progress", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const gate = await authorise(c);
    if ("status" in gate) return c.json({ error: gate.error }, gate.status);
    const now = Date.now();
    const held = await heartbeatJob(
      db,
      gate.job.id,
      gate.workerId,
      now,
      WORKER_LEASE_MS,
    );
    if (!held)
      return c.json({ error: "this attempt no longer holds the job" }, 409);
    return c.json({ lease_expires_at: now + WORKER_LEASE_MS });
  });

  app.post("/api/v1/worker/jobs/:id/complete", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const gate = await authorise(c);
    if ("status" in gate) return c.json({ error: gate.error }, gate.status);
    const { job, workerId, body } = gate;
    const result =
      body.result &&
      typeof body.result === "object" &&
      !Array.isArray(body.result)
        ? (body.result as Record<string, unknown>)
        : {};
    try {
      await applyWorkerJobResult(
        db,
        job,
        { status: "complete", result },
        blobRoot,
      );
    } catch (error) {
      /* The worker did its half; the server could not write the answer down.
         Fail the job so it is retried, rather than reporting success over a
         version that was never updated. */
      const message =
        error instanceof Error ? error.message : "Job result was rejected.";
      await failJob(db, job.id, workerId, Date.now(), message, 1000);
      await recordDeadMediaJob(db, job);
      return c.json({ error: message }, 422);
    }
    await completeJob(db, job.id, workerId, Date.now());
    return c.json({ status: "complete" });
  });

  app.post("/api/v1/worker/jobs/:id/fail", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const gate = await authorise(c);
    if ("status" in gate) return c.json({ error: gate.error }, gate.status);
    const { job, workerId, body } = gate;
    const message =
      typeof body.error === "string" && body.error.trim()
        ? body.error.slice(0, 2000)
        : "Worker job failed.";
    await failJob(db, job.id, workerId, Date.now(), message, 1000);
    /* Dead-letters the version behind it once the attempts are spent, which is
       what materialises the transcode.failed notification. */
    await recordDeadMediaJob(db, job);
    return c.json({ status: "failed" });
  });

  /* Nothing else lives under this prefix, and a stray path must not fall
     through to the public app to be answered by the SPA shell. */
  app.all("/api/v1/worker/*", (c) => c.json({ error: "not found" }, 404));
  return app;
};
