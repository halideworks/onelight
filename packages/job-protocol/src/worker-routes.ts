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

import { createHmac } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { constantTimeEqual, hmacSha256Hex } from "@onelight/core";
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
import type { BlobUrls, PumpBlobStore } from "./worker-pump.js";

/**
 * Storage, as these routes need it: what the pump asks of it, plus the reads
 * and writes a worker without a shared volume makes through this server.
 */
export type WorkerBlobStore = PumpBlobStore & {
  getStream(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<ReadableStream>;
  putStream(
    key: string,
    stream: ReadableStream,
    meta: { contentType?: string; size?: number },
  ): Promise<void>;
  createMultipart(
    key: string,
    meta: { contentType?: string; size?: number },
  ): Promise<{ uploadId: string; partSize: number }>;
  putPart(
    uploadId: string,
    partNo: number,
    stream: ReadableStream,
    partLength?: number,
  ): Promise<{ etag: string; size: number }>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ partNo: number; etag: string }>,
  ): Promise<void>;
  /* Optional, and only some stores can. A store backed by object storage can
     mint a URL the worker reads directly; one backed by a filesystem cannot,
     and answers null so the claim falls back to a URL on this server. */
  presignGet?(key: string, expiresIn: number): Promise<string | null>;
};

/* How long a presigned source URL is good for. A transcode of a long master
   can run for hours, and the URL has to outlive the job that is using it
   without becoming a standing grant on the object. */
const PRESIGNED_SOURCE_SECONDS = 12 * 60 * 60;

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

/**
 * The capability that lets one attempt read, or write, one blob.
 *
 * Distinct from the attempt token, and bound to the key: a blob URL is a query
 * string, and query strings end up in access logs and proxy logs in a way a
 * request body does not. Leaking one buys access to a blob its holder was
 * already being handed; it does not let anybody complete a job.
 *
 * The direction is signed too, which is the point of the mode. A job reads its
 * source and writes its outputs, and a read capability for the source must not
 * be usable to overwrite the original the whole version is derived from.
 */
export const blobToken = (
  secret: string,
  mode: "get" | "put",
  key: string,
  jobId: string,
  attempts: number,
): string =>
  createHmac("sha256", secret)
    .update(`${mode}:${key}:${jobId}:${String(attempts)}`)
    .digest("hex");

/* Compared through core's own constant-time helper rather than node's.
 *
 * This module is mounted on both targets, and `Buffer` and `timingSafeEqual`
 * are node builtins that happen to be available under nodejs_compat -- which
 * makes them a dependency on a compatibility flag for a comparison that is ten
 * lines of arithmetic. Both are already hex of a known length, so decoding
 * them buys nothing either: the strings compare in constant time directly. */
const hexBytes = (value: string): Uint8Array =>
  Uint8Array.from(value.toLowerCase(), (character) => character.charCodeAt(0));

const hexMatches = (expected: string, presented: unknown): boolean => {
  if (typeof presented !== "string" || !HEX_64.test(presented)) return false;
  return constantTimeEqual(hexBytes(presented), hexBytes(expected));
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
 * `blobRoot` is here so a claim can tell a worker sharing this volume where the
 * keys it was given are today; a deployment whose storage is not a mounted
 * filesystem leaves it out and the envelope carries keys and URLs alone.
 * `store` is how the result is checked, because a completion is checked against
 * stored objects and not against the server's own disk.
 */
export const createWorkerRoutes = (options: {
  db: AppDb;
  /* Omitted where storage is not a filesystem this process has mounted: the
     envelope then names keys and URLs alone, and the worker downloads what it
     cannot open. */
  blobRoot?: string | undefined;
  store: WorkerBlobStore;
  workerSecret?: string | undefined;
}): Hono => {
  const app = new Hono();
  const { db, blobRoot, store } = options;
  const secret = options.workerSecret;

  /* Where a worker fetches a source it cannot open itself, signed for one
     attempt at one job and for that key alone. Relative, because the worker
     already knows this server: it resolves the URL against the same
     ONELIGHT_SERVER_URL it claims from, and a deployment that hands out
     presigned storage URLs instead can return an absolute one here without
     the worker noticing the difference. */
  const encodeKey = (key: string): string =>
    key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

  const urls: BlobUrls = {
    read: async (key, jobId, attempts) => {
      /* Straight from storage when storage can say so. A worker decoding a
         40 GB master must not pull those bytes through this server: it is the
         slowest path, it spends CPU and requests in proportion to the file,
         and on the Workers target it is simply not possible. A presigned GET
         is an ordinary GET, so the worker can seek inside it.

         Bounded by the attempt, not by the object: long enough for the job to
         run, short enough that a leaked URL is not a standing grant. */
      const direct = await store.presignGet?.(key, PRESIGNED_SOURCE_SECONDS);
      if (direct) return direct;
      const query = new URLSearchParams({
        job: jobId,
        attempt: String(attempts),
        token: blobToken(secret ?? "", "get", key, jobId, attempts),
      });
      return `/api/v1/worker/blobs/${encodeKey(key)}?${query.toString()}`;
    },
    /* A template: the worker puts the key of whatever it produced where
       {key} is. The signature is over the scope, and the route checks that
       the key it was handed is inside it, so one capability covers the
       namespace a job may write and nothing else. */
    write: (scope, jobId, attempts) => {
      const query = new URLSearchParams({
        job: jobId,
        attempt: String(attempts),
        scope,
        token: blobToken(secret ?? "", "put", scope, jobId, attempts),
      });
      return `/api/v1/worker/blobs/{key}?${query.toString()}`;
    },
    /* The same capability, signed the same way, for an object that cannot go
       in one request body. Two placeholders rather than three URLs, because
       a worker that may write a namespace may write every part of every
       object in it -- there is nothing narrower to express. */
    multipart: (scope, jobId, attempts) => {
      const query = new URLSearchParams({
        job: jobId,
        attempt: String(attempts),
        scope,
        token: blobToken(secret ?? "", "put", scope, jobId, attempts),
      });
      return `/api/v1/worker/multipart/{action}/{key}?${query.toString()}`;
    },
  };

  /* A body has to be read before it can be authenticated -- the claim's
     signature is over its exact bytes -- so the size cap is enforced while it
     streams rather than after it is buffered. Everything here is small: a
     claim is a few hundred bytes and a completion carries media_info, which
     for a file with many streams is a few kilobytes.

     The blob routes are outside it on purpose: what moves through those is a
     rendition, which is as large as the picture is, and the thing standing
     between an unauthenticated request and that stream is the signature in
     the URL, checked before the body is read at all. */
  app.use(
    "/api/v1/worker/claim",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "body too large" }, 413),
    }),
  );
  app.use(
    "/api/v1/worker/jobs/*",
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
      urls,
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
        store,
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

  /**
   * The bytes a job reads, for a worker that cannot open them itself.
   *
   * Authorised by the signature in the URL and nothing else: the token is over
   * this key, this job and this attempt, so it cannot be pointed at another
   * blob, and it stops working the moment the attempt ends. That is checked
   * against the job row rather than inferred from the token's age, because
   * what makes a URL stale is the lease moving to another worker.
   */
  /**
   * The job this blob request belongs to, if it may still be made.
   *
   * `signed` is what the token is over: the key itself for a read, and the
   * namespace for a write, because a job writes files nobody planned.
   */
  const blobGate = async (
    c: Context,
    mode: "get" | "put",
    key: string,
    signed: string,
  ): Promise<{ status: 400 | 401 | 404 | 409; error: string } | null> => {
    const jobId = c.req.query("job") ?? "";
    const attempt = Number(c.req.query("attempt"));
    if (!key || !signed || !jobId || !Number.isInteger(attempt))
      return { status: 400, error: "invalid blob request" };
    if (
      !secret ||
      !hexMatches(
        blobToken(secret, mode, signed, jobId, attempt),
        c.req.query("token"),
      )
    )
      return { status: 401, error: "invalid blob token" };
    const job = (
      await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).all()
    )[0];
    if (!job) return { status: 404, error: "no such job" };
    if (job.status !== "processing" || job.attempts !== attempt)
      return { status: 409, error: "this attempt no longer holds the job" };
    return null;
  };

  /* A byte range, if the caller asked for one.
   *
   * The same grammar the media route parses, and deliberately the same
   * behaviour: an unparseable header is ignored rather than refused, because
   * the whole object is a correct answer to a request nobody could read. */
  const parseRange = (
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

  app.get("/api/v1/worker/blobs/:key{.+}", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const key = c.req.param("key");
    const refused = await blobGate(c, "get", key, key);
    if (refused) return c.json({ error: refused.error }, refused.status);
    let size: number;
    try {
      ({ size } = await store.head(key));
    } catch {
      return c.json({ error: "no such blob" }, 404);
    }
    /* Ranged reads exist so a worker does not have to hold the whole source.
       A camera master is routinely tens of gigabytes; copying one onto a
       machine before it can be decoded bounds where this can run by the size
       of the largest file anyone uploads, and ffmpeg does not need it -- it
       seeks, and over HTTP it seeks by asking for ranges. */
    const requested = c.req.header("range");
    const range = requested ? parseRange(requested, size) : undefined;
    if (range === "unsatisfiable")
      return c.body(null, 416, {
        "content-range": `bytes */${String(size)}`,
        "accept-ranges": "bytes",
      });
    /* The length goes out with the bytes so the worker can tell a truncated
       download from a complete one; a decoder handed half a file produces a
       plausible, wrong answer rather than an error. */
    if (!range)
      return c.body(await store.getStream(key), 200, {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "accept-ranges": "bytes",
      });
    return c.body(await store.getStream(key, range), 206, {
      "content-type": "application/octet-stream",
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
      "accept-ranges": "bytes",
    });
  });

  /**
   * Where a worker that mounts nothing puts what it produced.
   *
   * The capability is over the namespace, not the object, because a job writes
   * files nobody planned: the sprite's cue sheet lands beside the sprite, and
   * a PDF's page count is only known once pdftoppm has run. So the key is
   * checked against the scope the token was signed for, and a job for one
   * version cannot write into another's.
   *
   * Nothing here decides whether the object counts as a rendition. That is the
   * completion's business, and it is where the length and the checksum the
   * worker reported are checked against what this route stored.
   */
  app.put("/api/v1/worker/blobs/:key{.+}", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const key = c.req.param("key");
    const scope = c.req.query("scope") ?? "";
    const refused = await blobGate(c, "put", key, scope);
    if (refused) return c.json({ error: refused.error }, refused.status);
    if (key !== scope && !key.startsWith(scope))
      return c.json({ error: "that key is outside this job's scope" }, 403);
    /* A length is required rather than inferred: R2 needs to know how long a
       body is before it will take it, and a store that streams to a file
       still wants to know when the body it was promised did not all arrive. */
    const declared = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(declared) || declared < 0)
      return c.json({ error: "a content-length is required" }, 411);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "no body" }, 400);
    try {
      await store.putStream(key, body, { size: declared });
    } catch (error) {
      return c.json(
        {
          error: `that output could not be stored: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        502,
      );
    }
    return c.json({ key, size: declared });
  });

  /**
   * The same write, for an object that will not fit in one request.
   *
   * The Workers runtime caps a request body near 100 MB, and a 4K proxy is
   * routinely larger, so the single PUT above cannot be the only way home.
   * These three steps are the same capability as that PUT -- the token is the
   * one signed over the job's namespace -- and every one of them re-checks the
   * key against that scope, because holding an upload id must not widen what a
   * job may write.
   *
   * The worker decides which path to take from the size of what it produced;
   * nothing here needs to know which store is underneath, and both of them
   * already implement these three calls.
   */
  const multipartGate = async (
    c: Context,
    key: string,
  ): Promise<{ status: 400 | 401 | 403 | 404 | 409; error: string } | null> => {
    const scope = c.req.query("scope") ?? "";
    const refused = await blobGate(c, "put", key, scope);
    if (refused) return refused;
    if (key !== scope && !key.startsWith(scope))
      return { status: 403, error: "that key is outside this job's scope" };
    return null;
  };

  app.post("/api/v1/worker/multipart/create/:key{.+}", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const key = c.req.param("key");
    const refused = await multipartGate(c, key);
    if (refused) return c.json({ error: refused.error }, refused.status);
    try {
      /* partSize comes back from the store rather than being chosen here: it
         is a property of the storage, and the worker cuts its file to it. */
      const created = await store.createMultipart(key, {});
      return c.json({
        upload_id: created.uploadId,
        part_size: created.partSize,
      });
    } catch (error) {
      return c.json(
        {
          error: `that upload could not be started: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        502,
      );
    }
  });

  app.put("/api/v1/worker/multipart/part/:key{.+}", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const key = c.req.param("key");
    const refused = await multipartGate(c, key);
    if (refused) return c.json({ error: refused.error }, refused.status);
    const uploadId = c.req.query("upload") ?? "";
    const partNo = Number(c.req.query("part"));
    if (!uploadId || !Number.isInteger(partNo) || partNo < 1)
      return c.json(
        { error: "an upload id and a part number are required" },
        400,
      );
    /* Same rule as the single PUT: a length is required, not inferred, so a
       part that did not all arrive fails here rather than corrupting the
       object at completion. */
    const declared = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(declared) || declared < 0)
      return c.json({ error: "a content-length is required" }, 411);
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "no body" }, 400);
    try {
      const part = await store.putPart(uploadId, partNo, body, declared);
      return c.json({ part: partNo, etag: part.etag, size: part.size });
    } catch (error) {
      return c.json(
        {
          error: `that part could not be stored: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        502,
      );
    }
  });

  app.post("/api/v1/worker/multipart/complete/:key{.+}", async (c) => {
    if (!secret) return c.json({ error: "media processing is disabled" }, 503);
    const key = c.req.param("key");
    const refused = await multipartGate(c, key);
    if (refused) return c.json({ error: refused.error }, refused.status);
    const uploadId = c.req.query("upload") ?? "";
    if (!uploadId) return c.json({ error: "an upload id is required" }, 400);
    const body = asRecord(await c.req.text());
    const listed = Array.isArray(body?.parts) ? body.parts : null;
    if (!listed?.length)
      return c.json({ error: "the parts of the upload are required" }, 400);
    const parts: Array<{ partNo: number; etag: string }> = [];
    for (const entry of listed) {
      const part = entry as { part?: unknown; etag?: unknown };
      if (
        !Number.isInteger(part.part) ||
        (part.part as number) < 1 ||
        typeof part.etag !== "string" ||
        !part.etag
      )
        return c.json({ error: "a part is missing its number or etag" }, 400);
      parts.push({ partNo: part.part as number, etag: part.etag });
    }
    try {
      await store.completeMultipart(key, uploadId, parts);
    } catch (error) {
      return c.json(
        {
          error: `that upload could not be completed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        502,
      );
    }
    /* Deliberately says nothing about whether this counts as a rendition:
       that is the completion request's business, and it checks the length and
       the checksum the worker reported against what the store now holds. */
    return c.json({ key, parts: parts.length });
  });

  /* Nothing else lives under this prefix, and a stray path must not fall
     through to the public app to be answered by the SPA shell. */
  app.all("/api/v1/worker/*", (c) => c.json({ error: "not found" }, 404));
  return app;
};
