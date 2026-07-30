import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
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
  or,
  sql,
} from "drizzle-orm";
import {
  exportAvidText,
  exportAvidXml,
  exportCsv,
  exportFcpXml,
  exportJson,
  exportResolveEdl,
  exportText,
  exportXmeml,
  framesFromTimecode,
  hmacSha256Hex,
  isStillSource,
  parseTimecode,
  stackKeyOf,
  UlidGenerator,
  failureReason,
  zipStream,
} from "@onelight/core";
import type { MediaInfo } from "@onelight/core";
import type { PlannedRendition } from "@onelight/worker";
import {
  buildPdfReport,
  CLIP_HASH_POSITIONS,
  compositeAnnotation,
  parseAnnotationStrokes,
  planRenditions,
  primaryRenditionKinds,
  STILL_FULL_RUNG,
  STILL_LADDER,
} from "@onelight/worker";
import type { ReportComment } from "@onelight/worker";
import {
  assetVersions,
  assets,
  commentReactions,
  comments,
  exportJobs,
  jobs,
  projectEvents,
  projects,
  renditions,
  shareAssets,
  shares,
  uploadSessions,
} from "@onelight/db/schema";
import { claimNextJob, completeJob, failJob, heartbeatJob } from "@onelight/db";
import type { AppDb } from "@onelight/db";

interface WorkerResponse {
  status: "queued" | "processing" | "complete" | "failed";
  result?: {
    media_info?: Record<string, unknown>;
    renditions?: Array<{
      kind: string;
      key: string;
      meta: Record<string, unknown>;
    }>;
    failures?: Array<{ kind: string; error: string }>;
    /* The worker nests everything it returns under `result`, exactly as it
       does for media_info and renditions. */
    fingerprints?: Array<{
      id: string;
      content_hash: string | null;
      capture_key: string | null;
      audio_hash?: string | null;
      motion_hash?: string | null;
      state: "ready" | "skipped" | "failed";
    }>;
    /* What the version IS, returned beside its renditions. */
    fingerprint?: {
      content_hash?: string;
      capture_key?: string;
      audio_hash?: string;
      motion_hash?: string;
    };
  };
  error?: string;
}
interface JobPayload {
  blob_key?: string;
  version_id?: string;
  asset_id?: string;
  workspace_id?: string;
  [key: string]: unknown;
}
interface ExportFilter {
  version_id?: string;
  author_user_id?: string;
  unresolved_only?: boolean;
  internal?: boolean;
  has_annotation?: boolean;
  frame_in?: number;
  frame_out?: number;
  share_id?: string;
}

const DEFAULT_WORKER_JOB_TIMEOUT_MS = 6 * 60 * 60_000;

const workerJobTimeoutMs = (): number => {
  const parsed = Number(process.env.WORKER_JOB_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKER_JOB_TIMEOUT_MS;
};

const parsePayload = (value: string): JobPayload => {
  try {
    return JSON.parse(value) as JobPayload;
  } catch {
    return {};
  }
};

const parseObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const recordValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const positiveInteger = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const completePlayableRenditionMeta = (
  meta: Record<string, unknown>,
): boolean => {
  const color = recordValue(meta.output_color);
  return Boolean(
    meta.codec_contract_version === 2 &&
    positiveInteger(meta.frame_rate_num) &&
    positiveInteger(meta.frame_rate_den) &&
    positiveInteger(meta.coded_width) &&
    positiveInteger(meta.coded_height) &&
    positiveInteger(meta.bit_rate) &&
    typeof meta.codec === "string" &&
    meta.codec.length > 0 &&
    color &&
    typeof color.primaries === "string" &&
    typeof color.transfer === "string" &&
    typeof color.matrix === "string" &&
    typeof color.range === "string" &&
    typeof (color.chroma_location ?? color.chromaLocation) === "string",
  );
};

// Mirror of the API's appendProjectEvent row shape (ULID id, type, JSON
// payload) so the web app can live-update transcode progress over the
// project event stream. Best effort: a failed event insert never fails the
// job that produced it.
const insertVersionEvent = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
  type: "version.transcode" | "version.probed",
  status?: string,
): Promise<void> => {
  try {
    let projectId =
      typeof payload.project_id === "string" ? payload.project_id : undefined;
    let assetId =
      typeof payload.asset_id === "string" ? payload.asset_id : undefined;
    if (!projectId || !assetId) {
      const row = (
        await db
          .select({ assetId: assets.id, projectId: assets.projectId })
          .from(assetVersions)
          .innerJoin(assets, eq(assetVersions.assetId, assets.id))
          .where(eq(assetVersions.id, versionId))
          .limit(1)
          .all()
      )[0];
      assetId = assetId ?? row?.assetId;
      projectId = projectId ?? row?.projectId;
    }
    if (!projectId) return;
    await db
      .insert(projectEvents)
      .values({
        id: new UlidGenerator().ulid(),
        projectId,
        type,
        payloadJson: JSON.stringify({
          asset_id: assetId ?? null,
          version_id: versionId,
          ...(status ? { status } : {}),
        }),
        createdAt: Date.now(),
      })
      .run();
  } catch (error) {
    console.warn(
      `[onelight] ${type} event for version ${versionId} was not recorded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const chunked = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    groups.push(items.slice(index, index + size));
  return groups;
};

const sendJob = async (
  workerUrl: string,
  workerSecret: string,
  body: Record<string, unknown>,
): Promise<void> => {
  // The signed body carries a timestamp for replay protection on the worker.
  const payload = JSON.stringify({ ...body, timestamp: Date.now() });
  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onelight-signature": await hmacSha256Hex(workerSecret, payload),
    },
    body: payload,
    /* Node's fetch has no default timeout. A worker that restarts mid-request
       leaves a half-open socket that never resolves, and since the pump's
       re-entrancy guard stays held across the hung await, ALL transcode and
       export processing stops until the server is restarted. Bound every
       worker call so a hang becomes a retryable failure, not a wedge. */
    signal: AbortSignal.timeout(15_000),
  });
  // 409 means the worker is already running this job id; fall through to
  // polling instead of spawning a duplicate run.
  if (response.status === 409) return;
  if (!response.ok)
    throw new Error(`Worker rejected job with ${response.status}.`);
};

/* How long the worker may hold a status read open. Well inside the 60s job
   lease, so a heartbeat still lands between polls. */
const STATUS_WAIT_SECONDS = 20;
const MIN_POLL_INTERVAL_MS = 250;

const pollWorker = async (
  workerUrl: string,
  workerSecret: string,
  jobId: string,
  timeoutMs: number,
  onPoll?: () => Promise<void>,
): Promise<WorkerResponse> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const started = Date.now();
    // The status GET is signed over the path plus a fresh timestamp, so a
    // captured signed request cannot be replayed to re-read a job's
    // media_info and filesystem paths beyond the worker's skew window. This
    // mirrors the POST /jobs body timestamp; keep the two schemes in sync.
    //
    // `wait` asks the worker to hold the connection until the job settles.
    // The lease still needs feeding, so the hold is a fraction of it rather
    // than the worker's full ceiling: a long encode heartbeats several times
    // over while a still answers in one round trip.
    const requestPath = `/jobs/${jobId}?ts=${Date.now()}&wait=${String(
      STATUS_WAIT_SECONDS,
    )}`;
    const response = await fetch(
      `${workerUrl.replace(/\/$/, "")}${requestPath}`,
      {
        headers: {
          "x-onelight-signature": await hmacSha256Hex(
            workerSecret,
            requestPath,
          ),
        },
        /* Bound the status read (see sendJob): a hung status GET would never
           re-evaluate the deadline loop and would hold the slot forever. The
           bound allows for the long poll's hold plus a margin; a timeout
           rejects, the caller's catch fails the job, and the next tick
           retries. */
        signal: AbortSignal.timeout(STATUS_WAIT_SECONDS * 1000 + 10_000),
      },
    );
    if (!response.ok)
      throw new Error(`Worker status request failed with ${response.status}.`);
    const state = (await response.json()) as WorkerResponse;
    if (state.status === "complete" || state.status === "failed") return state;
    await onPoll?.();
    /* A worker too old to understand `wait` answers at once, and without a
       floor this loop would spin on it. A worker that held the connection has
       already waited, and pays nothing here. */
    const held = Date.now() - started;
    if (held < MIN_POLL_INTERVAL_MS)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, MIN_POLL_INTERVAL_MS - held),
      );
  }
  throw new Error(`Worker job exceeded its ${timeoutMs} ms deadline.`);
};

const waitForWorker = (
  db: AppDb,
  workerUrl: string,
  workerSecret: string,
  jobId: string,
  workerId: string,
): Promise<WorkerResponse> =>
  // Keep the job lease alive for the whole encode; transcodes routinely
  // run far longer than the 60 second lease.
  pollWorker(workerUrl, workerSecret, jobId, workerJobTimeoutMs(), () =>
    heartbeatJob(db, jobId, workerId, Date.now()).then(() => undefined),
  );

const assetKindFor = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
): Promise<string> => {
  let assetId =
    typeof payload.asset_id === "string" ? payload.asset_id : undefined;
  if (!assetId) {
    const version = (
      await db
        .select({ assetId: assetVersions.assetId })
        .from(assetVersions)
        .where(eq(assetVersions.id, versionId))
        .limit(1)
        .all()
    )[0];
    assetId = version?.assetId;
  }
  if (!assetId) return "video";
  const asset = (
    await db
      .select({ kind: assets.kind })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1)
      .all()
  )[0];
  return asset?.kind ?? "video";
};

const enqueueTranscode = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
): Promise<void> => {
  const existing = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, `transcode:${versionId}`))
    .limit(1)
    .all();
  if (existing.length) return;
  const now = Date.now();
  await db
    .insert(jobs)
    .values({
      id: new UlidGenerator().ulid(),
      kind: "transcode",
      // Jobs stay scoped by the workspace id carried in the payload.
      payloadJson: JSON.stringify(payload),
      idempotencyKey: `transcode:${versionId}`,
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
};

// Burned watermark rendition (phase-3 P3-T05): re-encode the 1080p proxy on
// the media worker with the share's drawtext spec, then register the result
// through the same checksum and registration path as other renditions. The
// idempotency key carries the spec hash, so a spec change enqueues a fresh
// job and the superseded rendition rows and blobs are deleted on
// registration.
const processWatermarkJob = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  payload: JobPayload,
  versionId: string,
  sourcePath: string,
  workerUrl: string,
  workerSecret: string,
  blobRoot: string,
  workerId: string,
): Promise<void> => {
  const shareId =
    typeof payload.share_id === "string" ? payload.share_id : undefined;
  const specHash =
    typeof payload.spec_hash === "string" ? payload.spec_hash : undefined;
  const outputKey =
    typeof payload.output_key === "string" ? payload.output_key : undefined;
  const spec =
    payload.spec &&
    typeof payload.spec === "object" &&
    !Array.isArray(payload.spec)
      ? (payload.spec as Record<string, unknown>)
      : {};
  if (!shareId || !specHash || !outputKey)
    throw new Error(
      "Watermark payload is missing share_id, spec_hash, or output_key.",
    );
  const share = (
    await db.select().from(shares).where(eq(shares.id, shareId)).limit(1).all()
  )[0];
  // A revoked share or a spec changed after enqueue makes this job moot; it
  // completes without producing anything and the sweep enqueues the current
  // spec under its own idempotency key.
  if (
    !share ||
    share.revokedAt !== null ||
    share.watermarkSpecHash !== specHash
  ) {
    console.warn(
      `[onelight] watermark job ${job.id} skipped: share ${shareId} is revoked or its spec changed.`,
    );
    return;
  }
  const version = (
    await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all()
  )[0];
  const rate =
    version?.frameRateNum && version?.frameRateDen
      ? { num: version.frameRateNum, den: version.frameRateDen }
      : undefined;
  const outputPath = path.join(blobRoot, outputKey);
  await sendJob(workerUrl, workerSecret, {
    job_id: job.id,
    kind: "watermark",
    source_path: sourcePath,
    output_path: outputPath,
    spec,
    // The burned path is per share, not per viewer, so the identity tokens
    // resolve to the share; {email} and {name} stay empty until a per-viewer
    // burned option exists (the session overlay carries viewer identity).
    tokens: {
      share: share.title,
      date: new Date().toISOString().slice(0, 10),
    },
    ...(rate ? { rate } : {}),
    ...(version?.sourceTimecodeStart
      ? { timecode: version.sourceTimecodeStart }
      : {}),
  });
  const state = await waitForWorker(
    db,
    workerUrl,
    workerSecret,
    job.id,
    workerId,
  );
  if (state.status !== "complete")
    throw new Error(state.error ?? "Watermark render failed.");
  const renderedMeta =
    state.result?.renditions?.find(
      (rendition) => rendition.kind === "watermarked",
    )?.meta ?? null;
  if (!renderedMeta || !completePlayableRenditionMeta(renderedMeta))
    throw new Error(
      "Watermark worker did not return a complete playable rendition contract.",
    );
  const sourceRendition = (
    await db
      .select({ metaJson: renditions.metaJson })
      .from(renditions)
      .where(
        and(
          eq(renditions.versionId, versionId),
          eq(renditions.blobKey, payload.blob_key as string),
          isNull(renditions.shareId),
        ),
      )
      .limit(1)
      .all()
  )[0];
  const sourceMeta = parseObject(sourceRendition?.metaJson ?? "{}");
  const registeredMeta: Record<string, unknown> = {
    ...renderedMeta,
    spec_hash: specHash,
  };
  for (const key of [
    "source_color",
    "source_timecode_start",
    "source_timecode_source",
  ] as const) {
    if (sourceMeta[key] !== undefined) registeredMeta[key] = sourceMeta[key];
  }
  if (
    registeredMeta.source_timecode_start === undefined &&
    version?.sourceTimecodeStart
  )
    registeredMeta.source_timecode_start = version.sourceTimecodeStart;
  const versionMediaInfo = parseObject(version?.mediaInfoJson ?? "{}");
  if (
    registeredMeta.source_timecode_source === undefined &&
    versionMediaInfo.sourceTimecodeSource !== undefined
  )
    registeredMeta.source_timecode_source =
      versionMediaInfo.sourceTimecodeSource;
  if (
    registeredMeta.source_color === undefined &&
    versionMediaInfo.sourceColor !== undefined
  )
    registeredMeta.source_color = versionMediaInfo.sourceColor;
  const info = await stat(outputPath);
  const checksum = await sha256File(outputPath);
  const superseded = await db
    .select()
    .from(renditions)
    .where(
      and(
        eq(renditions.versionId, versionId),
        eq(renditions.kind, "watermarked"),
        eq(renditions.shareId, shareId),
      ),
    )
    .all();
  // Rows first (the unique version+kind+share index admits only one), blobs
  // second, and never the blob this job just wrote.
  for (const old of superseded) {
    await db.delete(renditions).where(eq(renditions.id, old.id)).run();
    if (old.blobKey === outputKey) continue;
    try {
      await unlink(path.join(blobRoot, old.blobKey));
    } catch (error) {
      console.warn(
        `[onelight] superseded watermark blob ${old.blobKey} was not deleted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  await db
    .insert(renditions)
    .values({
      id: new UlidGenerator().ulid(),
      versionId,
      kind: "watermarked",
      blobKey: outputKey,
      metaJson: JSON.stringify(registeredMeta),
      size: info.size,
      checksumSha256: checksum,
      shareId,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
};

// The pump cannot observe share mutations (packages/api stays untouched), so
// missing watermarked renditions are reconciled from state: every active
// share with a watermark spec is joined through share_assets to its ready
// video versions, and versions lacking a rendition for the current spec hash
// get a job enqueued. The sweep is bounded per pass and throttled in the
// poll loop, so a large backlog drains across sweeps instead of stalling the
// queue.
const WATERMARK_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_WATERMARK_SWEEP_LIMIT = 8;

const watermarkSweepLimit = (): number => {
  const parsed = Number(process.env.WATERMARK_SWEEP_LIMIT);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WATERMARK_SWEEP_LIMIT;
};

export const sweepWatermarkJobs = async (db: AppDb): Promise<void> => {
  const now = Date.now();
  const activeShares = await db
    .select({ share: shares, workspaceId: projects.workspaceId })
    .from(shares)
    .innerJoin(projects, eq(shares.projectId, projects.id))
    .where(
      and(
        isNotNull(shares.watermarkSpecJson),
        isNotNull(shares.watermarkSpecHash),
        isNull(shares.revokedAt),
      ),
    )
    .all();
  let enqueued = 0;
  const limit = watermarkSweepLimit();
  for (const entry of activeShares) {
    if (enqueued >= limit) return;
    const share = entry.share;
    if (share.expiresAt !== null && share.expiresAt <= now) continue;
    const specHash = share.watermarkSpecHash as string;
    const versions = await db
      .select({ version: assetVersions, asset: assets })
      .from(shareAssets)
      .innerJoin(assets, eq(shareAssets.assetId, assets.id))
      .innerJoin(assetVersions, eq(assetVersions.assetId, assets.id))
      .where(
        and(
          eq(shareAssets.shareId, share.id),
          eq(assets.kind, "video"),
          isNull(assets.deletedAt),
          isNull(assetVersions.deletedAt),
          eq(assetVersions.transcodeStatus, "ready"),
        ),
      )
      .all();
    for (const row of versions) {
      if (enqueued >= limit) return;
      if (
        !share.showAllVersions &&
        row.asset.currentVersionId !== row.version.id
      )
        continue;
      const existing = await db
        .select()
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, row.version.id),
            eq(renditions.kind, "watermarked"),
            eq(renditions.shareId, share.id),
          ),
        )
        .all();
      if (
        existing.some((rendition) => {
          const meta = parseObject(rendition.metaJson);
          return (
            meta.spec_hash === specHash && completePlayableRenditionMeta(meta)
          );
        })
      )
        continue;
      const idempotencyKey = `watermark:v3:${row.version.id}:${share.id}:${specHash}`;
      const proxy = (
        await db
          .select()
          .from(renditions)
          .where(
            and(
              eq(renditions.versionId, row.version.id),
              eq(renditions.kind, "proxy_1080"),
              isNull(renditions.shareId),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!proxy) continue;
      const payloadJson = JSON.stringify({
        workspace_id: entry.workspaceId,
        project_id: share.projectId,
        version_id: row.version.id,
        share_id: share.id,
        spec: parseObject(share.watermarkSpecJson ?? "{}"),
        spec_hash: specHash,
        blob_key: proxy.blobKey,
        output_key: `renditions/${row.version.id}/watermarked-${share.id}-${specHash}.mp4`,
      });
      // idempotency_key is UNIQUE, so a job already carries this key when one
      // exists. A queued/processing/complete job owns it and the sweep leaves
      // it alone. A job that exhausted its attempts sits as 'dead' (or the
      // enum's 'failed'): claimNextJob never revisits those rows, so the
      // rendition would be blocked forever. The UNIQUE constraint forbids
      // inserting a fresh job, so a terminal row is reset in place to queued
      // with attempts=0 (and a refreshed payload, since the proxy blob key can
      // change) to requeue the render. Any other swept job kind must reuse
      // this same reset-or-skip path for the same reason.
      const existingJob = (
        await db
          .select({ id: jobs.id, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.idempotencyKey, idempotencyKey))
          .limit(1)
          .all()
      )[0];
      if (existingJob) {
        if (
          existingJob.status !== "dead" &&
          existingJob.status !== "failed" &&
          existingJob.status !== "complete"
        )
          continue;
        await db
          .update(jobs)
          .set({
            payloadJson,
            status: "queued",
            priority: 0,
            maxAttempts: 5,
            attempts: 0,
            runAfter: now,
            startedAt: null,
            heartbeatAt: null,
            leaseExpiresAt: null,
            finishedAt: null,
            error: null,
            workerId: null,
          })
          .where(eq(jobs.id, existingJob.id))
          .run();
        enqueued += 1;
        continue;
      }
      await db
        .insert(jobs)
        .values({
          id: new UlidGenerator().ulid(),
          kind: "watermark",
          payloadJson,
          idempotencyKey,
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
        .onConflictDoNothing()
        .run();
      enqueued += 1;
    }
  }
};

/* Versions transcoded before pitch-corrected shuttle audio existed need the
   two new sidecars without an operator re-uploading or manually reprocessing
   them. A low-priority, bounded reconciliation job reuses every finished
   output already on disk, so ffmpeg only writes the missing audio files. */
const SHUTTLE_AUDIO_SWEEP_INTERVAL_MS = 30_000;
const SHUTTLE_AUDIO_SWEEP_LIMIT = 4;
const SHUTTLE_AUDIO_SCAN_BATCH = 100;
const PLAYABLE_VIDEO_KINDS: Array<typeof renditions.$inferSelect.kind> = [
  "proxy_540",
  "proxy_1080",
  "proxy_2160",
  "hdr_av1",
  "hdr_hevc",
];

/* Backfill for the stills ladder (S0).

   Two populations need it, and both look the same from here: an image version
   with no still_review. Every JPEG uploaded before this had no poster at all,
   because the ffmpeg poster recipe seeked and ran thumbnail=100 over a single
   frame and emitted nothing, so those assets are blank cards everywhere. And
   every image version made before the ladder has only the retired still_tiles
   PNG, which is the file the review room was loading at up to 14 MB.

   Re-running the transcode is the whole fix: planRenditions now returns the
   ladder, and runTranscode reuses any output already on disk, so the work is
   exactly the rungs that are missing. Bounded per pass and throttled in the
   poll loop, like the sweeps above, so a library of 3000 stills drains in the
   background instead of monopolizing the pump. */
const STILL_LADDER_SWEEP_INTERVAL_MS = 30_000;
const STILL_LADDER_SWEEP_LIMIT = 8;
const STILL_LADDER_SCAN_BATCH = 200;

/* A file that has become an image.

   The format table grows: a .cr3 or a .heic uploaded before there was a
   decoder for it landed as a plain file, honestly, because a card with no
   picture is worse than an honest file. Now that one exists, those rows are
   re-kinded and the ladder sweep below picks them up on its next pass. */
/* A keyset walk, not an offset one, and not a single batch.

   Reading the first N rows of kind='file' every pass would never see past
   them: a row that is not a still stays a file, so the same N would be read
   forever and a RAW sitting behind two hundred zip files would never be
   adopted. An offset has the opposite fault, because re-kinding a row removes
   it from the filter and shifts everything after it. The id cursor is immune
   to both. Bounded per pass so a large library drains across sweeps. */
const RE_KIND_SCAN_LIMIT = 2000;

export const sweepReKindStills = async (db: AppDb): Promise<number> => {
  let changed = 0;
  let scanned = 0;
  let cursor = "";
  while (scanned < RE_KIND_SCAN_LIMIT) {
    const candidates = await db
      .select({ id: assets.id, name: assets.name })
      .from(assets)
      .where(
        and(
          eq(assets.kind, "file"),
          isNull(assets.deletedAt),
          cursor ? gt(assets.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(assets.id))
      .limit(STILL_LADDER_SCAN_BATCH)
      .all();
    if (!candidates.length) break;
    scanned += candidates.length;
    cursor = candidates[candidates.length - 1]?.id ?? cursor;
    for (const row of candidates) {
      if (!isStillSource(row.name)) continue;
      await db
        .update(assets)
        .set({ kind: "image" })
        .where(eq(assets.id, row.id))
        .run();
      changed += 1;
    }
  }
  return changed;
};

export const sweepStillLadderJobs = async (db: AppDb): Promise<number> => {
  let enqueued = 0;
  let offset = 0;
  const now = Date.now();
  while (enqueued < STILL_LADDER_SWEEP_LIMIT) {
    const candidates = await db
      .select({
        version: assetVersions,
        asset: assets,
        workspaceId: projects.workspaceId,
      })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(assets.kind, "image"),
          isNull(assetVersions.deletedAt),
          isNull(assets.deletedAt),
          /* A version still being processed is not stale, it is unfinished;
             its own transcode will produce the ladder. */
          inArray(assetVersions.transcodeStatus, ["ready", "failed"]),
        ),
      )
      .orderBy(asc(assetVersions.createdAt), asc(assetVersions.id))
      .limit(STILL_LADDER_SCAN_BATCH)
      .offset(offset)
      .all();
    if (!candidates.length) break;
    offset += candidates.length;
    for (const row of candidates) {
      if (enqueued >= STILL_LADDER_SWEEP_LIMIT) break;
      const existing = await db
        .select({ kind: renditions.kind })
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, row.version.id),
            isNull(renditions.shareId),
            inArray(renditions.kind, ["still_review", "poster"]),
          ),
        )
        .all();
      const kinds = new Set(existing.map((rendition) => rendition.kind));
      if (kinds.has("still_review") && kinds.has("poster")) continue;
      const payloadJson = JSON.stringify({
        workspace_id: row.workspaceId,
        project_id: row.asset.projectId,
        asset_id: row.asset.id,
        version_id: row.version.id,
        blob_key: row.version.originalBlobKey,
      });
      const idempotencyKey = `stills:v1:${row.version.id}`;
      /* Same reset-or-skip rule the watermark sweep documents: the key is
         UNIQUE, so a live job owns it and a terminal one is reset in place. */
      const existingJob = (
        await db
          .select({ id: jobs.id, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.idempotencyKey, idempotencyKey))
          .limit(1)
          .all()
      )[0];
      if (existingJob) {
        if (existingJob.status !== "dead" && existingJob.status !== "failed")
          continue;
        await db
          .update(jobs)
          .set({
            payloadJson,
            status: "queued",
            priority: 0,
            maxAttempts: 3,
            attempts: 0,
            runAfter: now,
            startedAt: null,
            heartbeatAt: null,
            leaseExpiresAt: null,
            finishedAt: null,
            error: null,
            workerId: null,
          })
          .where(eq(jobs.id, existingJob.id))
          .run();
        enqueued += 1;
        continue;
      }
      await db
        .insert(jobs)
        .values({
          id: new UlidGenerator().ulid(),
          kind: "transcode",
          payloadJson,
          idempotencyKey,
          status: "queued",
          /* Below ordinary work: nobody is waiting on a backfill, and an
             upload happening right now must not queue behind 3000 of them. */
          priority: -1,
          capabilityJson: "{}",
          maxAttempts: 3,
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
      enqueued += 1;
    }
  }
  return enqueued;
};

/* The stack key backfill.

   Batch versioning matches an incoming filename against assets.stack_key, and
   rows created before that column existed have none. Normalizing a filename is
   application work, not SQL (a bare trailing number must never be stripped, or
   a numbered shoot stacks on top of itself), so the migration adds an empty
   column and this fills it. Bounded per pass like every other sweep, and it
   stops costing anything once the library is done. */
const STACK_KEY_SWEEP_INTERVAL_MS = 30_000;
const STACK_KEY_SWEEP_BATCH = 2000;

export const sweepStackKeys = async (db: AppDb): Promise<number> => {
  const rows = await db
    .select({ id: assets.id, name: assets.name })
    .from(assets)
    .where(eq(assets.stackKey, ""))
    .limit(STACK_KEY_SWEEP_BATCH)
    .all();
  for (const row of rows)
    await db
      .update(assets)
      .set({ stackKey: stackKeyOf(row.name) })
      .where(eq(assets.id, row.id))
      .run();
  return rows.length;
};

/* Fingerprints for a library that predates them.

   Matching by capture identity or by the picture can only answer for assets
   that have been looked at, so an upgrade has to walk what is already there.
   Bounded per pass like every other sweep, at a priority below ordinary work
   because nobody is waiting on it, and skipped entirely for kinds that have
   no picture to hash.

   The mark that a version has been looked at is a content hash OR a capture
   key; a version with neither after a successful pass (a screen grab with no
   metadata and a flat frame) would be re-queued forever, so the job's own
   idempotency key is what stops it: once it exists, the sweep leaves it.

   Clips get a second reason to be swept. A clip signed before the post
   production tiers carries a four point signature and no audio, and neither
   the shot overlap nor the sound can say anything about it. Counting the
   separators in the hash is the honest test of which scheme signed it, and it
   settles: a re-signed clip has the current count and drops out whether or
   not it turned out to have any audio. */
const FINGERPRINT_SWEEP_INTERVAL_MS = 60_000;
/* Below this a clip cannot land sixteen seeks on sixteen different frames, so
   it is signed at fewer points by design. Matches the sampler's own rule in
   packages/worker/src/fingerprint-media.ts. */
const FULL_CLIP_GRID_SECONDS = CLIP_HASH_POSITIONS.length * 0.25;
const FINGERPRINT_SWEEP_LIMIT = 4;
const FINGERPRINT_SWEEP_BATCH = 25;

export const sweepFingerprints = async (db: AppDb): Promise<number> => {
  const candidates = await db
    .select({
      id: assetVersions.id,
      workspaceId: projects.workspaceId,
      projectId: assets.projectId,
    })
    .from(assetVersions)
    .innerJoin(assets, eq(assetVersions.assetId, assets.id))
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(
      and(
        inArray(assets.kind, ["image", "video"]),
        isNull(assets.deletedAt),
        isNull(assetVersions.deletedAt),
        eq(assetVersions.transcodeStatus, "ready"),
        or(
          and(
            isNull(assetVersions.contentHash),
            isNull(assetVersions.captureKey),
            isNull(assetVersions.audioHash),
            isNull(assetVersions.motionHash),
          ),
          /* A clip with no motion contour: every clip signed before that
             tier existed. Not self-limiting on its own, because a static or
             very short clip never gets one, so the job's own key is what
             stops the offer repeating; the key carries the scheme version,
             which is why the version had to move for this. */
          and(eq(assets.kind, "video"), isNull(assetVersions.motionHash)),
          and(
            eq(assets.kind, "video"),
            isNotNull(assetVersions.contentHash),
            sql`length(${assetVersions.contentHash}) - length(replace(${assetVersions.contentHash}, ':', '')) < ${CLIP_HASH_POSITIONS.length - 1}`,
            /* A clip too short to hold the full grid is signed at fewer
               points on purpose, so a short signature is not evidence of the
               old scheme for it. Without this the sweep would offer a one
               frame delivery again every minute forever. */
            sql`(
              ${assetVersions.durationFrames} is null
              or ${assetVersions.frameRateNum} is null
              or ${assetVersions.frameRateDen} is null
              or ${assetVersions.frameRateNum} = 0
              or (${assetVersions.durationFrames} * 1.0 * ${assetVersions.frameRateDen} / ${assetVersions.frameRateNum}) >= ${FULL_CLIP_GRID_SECONDS}
            )`,
          ),
        ),
      ),
    )
    .orderBy(desc(assetVersions.createdAt))
    .limit(FINGERPRINT_SWEEP_BATCH * FINGERPRINT_SWEEP_LIMIT)
    .all();
  if (!candidates.length) return 0;
  /* A version stays a candidate until the job that is signing it lands, and
     signing twenty-five clips takes longer than the sweep's own interval, so
     the naive sweep offers the same work again a minute later under a new
     lead and the machine does it twice. The job's key cannot see that: it is
     the lead version, not the members. So read what is already in flight and
     leave it alone. */
  const inFlight = await db
    .select({ payloadJson: jobs.payloadJson })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "fingerprint"),
        inArray(jobs.status, ["queued", "processing"]),
      ),
    )
    .all();
  const claimed = new Set<string>();
  for (const row of inFlight) {
    try {
      const payload = JSON.parse(row.payloadJson) as {
        version_ids?: unknown;
      };
      if (Array.isArray(payload.version_ids))
        for (const id of payload.version_ids)
          if (typeof id === "string") claimed.add(id);
    } catch {
      /* A payload we cannot read claims nothing. */
    }
  }
  const pending = claimed.size
    ? candidates.filter((row) => !claimed.has(row.id))
    : candidates;
  if (!pending.length) return 0;
  const now = Date.now();
  let enqueued = 0;
  for (
    let from = 0;
    from < pending.length && enqueued < FINGERPRINT_SWEEP_LIMIT;
    from += FINGERPRINT_SWEEP_BATCH
  ) {
    const slice = pending.slice(from, from + FINGERPRINT_SWEEP_BATCH);
    const first = slice[0];
    if (!first) break;
    /* The scheme is part of the key: a library signed by the old one has to be
       offered again, and a key that never changes would refuse it. Bump this
       whenever the sampler in packages/worker/src/fingerprint-media.ts
       changes, including when it changes what it does with clips it used to
       refuse: a version that got no signature is still a candidate, but its
       old job's key would turn the offer away forever. v3 was the short clip
       grid; v4 added the motion contour, which every clip needs and none of
       them has. */
    const idempotencyKey = `fingerprint:v4:${first.id}`;
    const existing = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, idempotencyKey))
      .limit(1)
      .all();
    if (existing.length) continue;
    await db
      .insert(jobs)
      .values({
        id: new UlidGenerator().ulid(),
        kind: "fingerprint",
        payloadJson: JSON.stringify({
          workspace_id: first.workspaceId,
          project_id: first.projectId,
          version_ids: slice.map((row) => row.id),
        }),
        idempotencyKey,
        status: "queued",
        /* Nobody is waiting: an upload happening now must not queue behind
           a library being catalogued. */
        priority: -1,
        capabilityJson: "{}",
        maxAttempts: 3,
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
    enqueued += 1;
  }
  return enqueued;
};

export const sweepShuttleAudioJobs = async (db: AppDb): Promise<number> => {
  let enqueued = 0;
  let offset = 0;
  while (enqueued < SHUTTLE_AUDIO_SWEEP_LIMIT) {
    const candidates = await db
      .select({
        version: assetVersions,
        asset: assets,
        workspaceId: projects.workspaceId,
      })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          inArray(assets.kind, ["video", "audio"]),
          eq(assetVersions.transcodeStatus, "ready"),
          isNull(assetVersions.deletedAt),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(asc(assetVersions.createdAt), asc(assetVersions.id))
      .limit(SHUTTLE_AUDIO_SCAN_BATCH)
      .offset(offset)
      .all();
    if (!candidates.length) break;
    offset += candidates.length;
    for (const row of candidates) {
      if (enqueued >= SHUTTLE_AUDIO_SWEEP_LIMIT) break;
      const mediaInfo = parseObject(row.version.mediaInfoJson);
      const streams = Array.isArray(mediaInfo.streams) ? mediaInfo.streams : [];
      if (
        !streams.some(
          (stream) =>
            typeof stream === "object" &&
            stream !== null &&
            (stream as Record<string, unknown>).codec_type === "audio",
        )
      )
        continue;
      const requiredKinds: Array<typeof renditions.$inferSelect.kind> =
        row.asset.kind === "video"
          ? ["reference_audio_1x", "shuttle_audio_2x", "shuttle_audio_4x"]
          : ["shuttle_audio_2x", "shuttle_audio_4x"];
      const existingRenditions = await db
        .select({ kind: renditions.kind, metaJson: renditions.metaJson })
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, row.version.id),
            isNull(renditions.shareId),
            inArray(renditions.kind, [
              ...requiredKinds,
              ...PLAYABLE_VIDEO_KINDS,
            ]),
          ),
        )
        .all();
      const existingKinds = new Set(
        existingRenditions.map((rendition) => rendition.kind),
      );
      const playableRows = existingRenditions.filter((rendition) =>
        PLAYABLE_VIDEO_KINDS.includes(rendition.kind),
      );
      const videoContractsComplete =
        row.asset.kind !== "video" ||
        (playableRows.length > 0 &&
          playableRows.every((rendition) =>
            completePlayableRenditionMeta(parseObject(rendition.metaJson)),
          ));
      if (
        requiredKinds.every((kind) => existingKinds.has(kind)) &&
        videoContractsComplete
      )
        continue;
      const idempotencyKey = `reference-audio:v3:${row.version.id}`;
      const existingJob = (
        await db
          .select({ id: jobs.id, status: jobs.status })
          .from(jobs)
          .where(eq(jobs.idempotencyKey, idempotencyKey))
          .limit(1)
          .all()
      )[0];
      const now = Date.now();
      const payloadJson = JSON.stringify({
        blob_key: row.version.originalBlobKey,
        version_id: row.version.id,
        asset_id: row.asset.id,
        project_id: row.asset.projectId,
        workspace_id: row.workspaceId,
        secondary_only: "shuttle_audio",
      });
      if (existingJob) {
        if (
          existingJob.status !== "dead" &&
          existingJob.status !== "failed" &&
          existingJob.status !== "complete"
        )
          continue;
        await db
          .update(jobs)
          .set({
            payloadJson,
            status: "queued",
            priority: -10,
            maxAttempts: 5,
            attempts: 0,
            runAfter: now,
            startedAt: null,
            heartbeatAt: null,
            leaseExpiresAt: null,
            finishedAt: null,
            error: null,
            workerId: null,
          })
          .where(eq(jobs.id, existingJob.id))
          .run();
        enqueued += 1;
        continue;
      }
      await db
        .insert(jobs)
        .values({
          id: new UlidGenerator().ulid(),
          kind: "transcode",
          payloadJson,
          idempotencyKey,
          status: "queued",
          priority: -10,
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
        .onConflictDoNothing()
        .run();
      enqueued += 1;
    }
  }
  return enqueued;
};

/* Everything that happens to a finished worker result: the blobs are
   checksummed and registered, superseded rows are cleaned up, readiness is
   decided per asset kind, and the version is marked ready.

   Its own function because two paths reach it now. A movie is probed and then
   transcoded, two jobs and two round trips, because the plan depends on what
   the probe found. A still is both at once: its ladder is the same whatever
   ffprobe says, so the worker renders it in the same call that probes it, and
   3000 of them cost 3000 jobs rather than 6000. */
/* The file a named still rung is written to. Only the stills ladder is
   addressable this way; anything else is a planning error rather than a
   request. */
const stillFilenameFor = (kind: string): string => {
  const rung = [...STILL_LADDER, STILL_FULL_RUNG].find(
    (entry) => entry.kind === kind,
  );
  if (!rung) throw new Error(`Unknown rendition kind requested: ${kind}.`);
  return rung.filename;
};

const registerWorkerRenditions = async (
  db: AppDb,
  payload: JobPayload,
  version: typeof assetVersions.$inferSelect,
  assetKind: string,
  state: WorkerResponse,
  blobRoot: string,
  options: { targeted?: boolean } = {},
): Promise<void> => {
  if (!state.result?.renditions)
    throw new Error(state.error ?? "Transcode failed.");
  /* What the version is, as opposed to what files were written for it. */
  const print = state.result.fingerprint;
  if (
    print?.content_hash ||
    print?.capture_key ||
    print?.audio_hash ||
    print?.motion_hash
  )
    await db
      .update(assetVersions)
      .set({
        ...(print.content_hash ? { contentHash: print.content_hash } : {}),
        ...(print.capture_key ? { captureKey: print.capture_key } : {}),
        ...(print.audio_hash ? { audioHash: print.audio_hash } : {}),
        ...(print.motion_hash ? { motionHash: print.motion_hash } : {}),
      })
      .where(eq(assetVersions.id, version.id))
      .run();
  const failures = state.result.failures ?? [];
  for (const failure of failures)
    console.warn(
      `[onelight] rendition ${failure.kind} failed for version ${version.id}: ${failure.error}`,
    );
  for (const rendition of state.result.renditions) {
    const key = path.relative(blobRoot, rendition.key).replaceAll("\\", "/");
    const info = await stat(rendition.key);
    /* A 0-byte output is not a rendition. ffmpeg can exit 0 with an empty file
       on a frameless or degenerate source (a poster/sprite of a 0-duration or
       image-as-video input); registering it would reference a broken blob the
       GC then keeps forever and the player draws as a broken frame. Skip it. */
    if (info.size === 0) {
      console.warn(
        `[onelight] rendition ${rendition.kind} for version ${version.id} was 0 bytes; skipping.`,
      );
      continue;
    }
    const meta = { ...rendition.meta };
    const vttPath =
      typeof meta.vtt_path === "string" ? meta.vtt_path : undefined;
    if (vttPath) {
      const vttKey = path.relative(blobRoot, vttPath).replaceAll("\\", "/");
      meta.vtt_blob_key = vttKey;
      delete meta.vtt_path;
      const vttInfo = await stat(path.join(blobRoot, vttKey));
      meta.vtt_size = vttInfo.size;
    }
    const checksumSha256 = await sha256File(rendition.key);
    const existingRendition = (
      await db
        .select({ id: renditions.id })
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, version.id),
            eq(
              renditions.kind,
              rendition.kind as typeof renditions.$inferSelect.kind,
            ),
            isNull(renditions.shareId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (existingRendition) {
      await db
        .update(renditions)
        .set({
          blobKey: key,
          metaJson: JSON.stringify(meta),
          size: info.size,
          checksumSha256,
        })
        .where(eq(renditions.id, existingRendition.id))
        .run();
    } else {
      await db
        .insert(renditions)
        .values({
          id: new UlidGenerator().ulid(),
          versionId: version.id,
          kind: rendition.kind as typeof renditions.$inferInsert.kind,
          blobKey: key,
          metaJson: JSON.stringify(meta),
          size: info.size,
          checksumSha256,
          shareId: null,
          createdAt: Date.now(),
        })
        .run();
    }
  }
  // Primary readiness is per asset kind: only a missing primary rendition
  // fails the job; secondary failures are reported above and do not.
  const produced = new Set(
    state.result.renditions.map((rendition) => rendition.kind),
  );
  if (
    payload.secondary_only === "shuttle_audio" &&
    ((assetKind === "video" && !produced.has("reference_audio_1x")) ||
      !produced.has("shuttle_audio_2x") ||
      !produced.has("shuttle_audio_4x"))
  ) {
    const shuttleFailure = failures.find(
      (failure) =>
        failure.kind === "reference_audio_1x" ||
        failure.kind.startsWith("shuttle_audio_"),
    );
    throw new Error(
      shuttleFailure
        ? `Reference audio ${shuttleFailure.kind} failed: ${shuttleFailure.error}`
        : "Reference and pitch-corrected shuttle audio were not produced.",
    );
  }
  /* A job that asked for one named rendition says nothing about whether the
     version is ready: the full-size still is rendered on demand, long after
     the version was ready, and judging readiness by what this job produced
     would mark a perfectly good asset failed. Register and stop. */
  if (options.targeted) {
    if (!produced.size)
      throw new Error("The requested rendition was not produced.");
    return;
  }
  const primaries = primaryRenditionKinds(assetKind);
  if (!primaries.some((kind) => produced.has(kind))) {
    const primaryFailure = failures.find((failure) =>
      primaries.includes(failure.kind),
    );
    throw new Error(
      primaryFailure
        ? `Primary rendition ${primaryFailure.kind} failed: ${primaryFailure.error}`
        : "Primary rendition was not produced.",
    );
  }
  await db
    .update(assetVersions)
    .set({ transcodeStatus: "ready" })
    .where(eq(assetVersions.id, version.id))
    .run();
  await insertVersionEvent(
    db,
    payload,
    version.id,
    "version.transcode",
    "ready",
  );
};

const processJob = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  workerUrl: string,
  workerSecret: string,
  blobRoot: string,
  workerId: string,
): Promise<void> => {
  const payload = parsePayload(job.payloadJson);
  if (job.kind === "fingerprint") {
    /* A batch of uploads, identified so the matcher can offer them as new
       versions of something. Nothing here touches an asset: an upload is not
       a version yet, and may never become one. */
    const stringIds = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    const ids = stringIds(payload.upload_ids);
    /* The same job identifies existing versions, for a library that predates
       fingerprinting: same decoder, same arithmetic, a different row to
       write it on. */
    const versionIds = stringIds(payload.version_ids);
    if (!ids.length && !versionIds.length) return;
    const rows = ids.length
      ? await db
          .select()
          .from(uploadSessions)
          .where(inArray(uploadSessions.id, ids))
          .all()
      : [];
    const versionRows = versionIds.length
      ? await db
          .select()
          .from(assetVersions)
          .where(inArray(assetVersions.id, versionIds))
          .all()
      : [];
    const sources = [
      ...rows
        .filter((row) => row.status === "completed")
        .map((row) => ({ id: row.id, path: path.join(blobRoot, row.blobKey) })),
      ...versionRows.map((row) => ({
        id: row.id,
        path: path.join(blobRoot, row.originalBlobKey),
      })),
    ];
    if (!sources.length) return;
    await sendJob(workerUrl, workerSecret, {
      job_id: job.id,
      kind: "fingerprint",
      sources,
    });
    const state = await waitForWorker(
      db,
      workerUrl,
      workerSecret,
      job.id,
      workerId,
    );
    if (state.status !== "complete" || !state.result?.fingerprints)
      throw new Error(state.error ?? "Fingerprinting failed.");
    const isVersion = new Set(versionRows.map((row) => row.id));
    for (const print of state.result.fingerprints) {
      if (isVersion.has(print.id)) {
        await db
          .update(assetVersions)
          .set({
            contentHash: print.content_hash,
            captureKey: print.capture_key,
            ...(print.audio_hash === undefined
              ? {}
              : { audioHash: print.audio_hash }),
            ...(print.motion_hash === undefined
              ? {}
              : { motionHash: print.motion_hash }),
          })
          .where(eq(assetVersions.id, print.id))
          .run();
        continue;
      }
      await db
        .update(uploadSessions)
        .set({
          contentHash: print.content_hash,
          captureKey: print.capture_key,
          ...(print.audio_hash === undefined
            ? {}
            : { audioHash: print.audio_hash }),
          ...(print.motion_hash === undefined
            ? {}
            : { motionHash: print.motion_hash }),
          fingerprintState: print.state,
        })
        .where(eq(uploadSessions.id, print.id))
        .run();
    }
    /* Anything the worker did not answer for is marked so the matcher stops
       waiting on it. */
    const answered = new Set(
      state.result.fingerprints.map((print) => print.id),
    );
    for (const row of rows)
      if (!answered.has(row.id))
        await db
          .update(uploadSessions)
          .set({ fingerprintState: "skipped" })
          .where(eq(uploadSessions.id, row.id))
          .run();
    return;
  }
  const sourceKey = payload.blob_key;
  const versionId = payload.version_id;
  if (!sourceKey || !versionId)
    throw new Error("Job payload is missing blob_key or version_id.");
  const sourcePath = path.join(blobRoot, sourceKey);
  if (job.kind === "probe") {
    const assetKind = await assetKindFor(db, payload, versionId);
    if (assetKind === "pdf" || assetKind === "file") {
      // ffprobe cannot parse these kinds, so the worker probe is skipped.
      // PDFs still get a transcode (pdftoppm page rasters); plain files
      // have nothing to derive and are marked skipped.
      await db
        .update(assetVersions)
        .set({
          mediaInfoJson: "{}",
          colorJson: "{}",
          transcodeStatus: assetKind === "pdf" ? "processing" : "skipped",
        })
        .where(eq(assetVersions.id, versionId))
        .run();
      await insertVersionEvent(
        db,
        payload,
        versionId,
        "version.transcode",
        assetKind === "pdf" ? "processing" : "skipped",
      );
      if (assetKind === "pdf") await enqueueTranscode(db, payload, versionId);
      return;
    }
    /* A still's ladder does not depend on what the probe finds, so it is sent
       with the probe and rendered in the same call. That halves the jobs and
       the round trips for a delivery of photographs, which is the difference
       between an afternoon and a coffee. Everything else is probed first,
       because the plan is derived from the probe. */
    const stillOutputs =
      assetKind === "image"
        ? planRenditions("image", {
            format: {},
            streams: [],
            variableFrameRate: false,
            colorAssumed: true,
          }).map((entry) => ({
            kind: entry.kind,
            path: path.join(blobRoot, "renditions", versionId, entry.filename),
          }))
        : [];
    await sendJob(workerUrl, workerSecret, {
      job_id: job.id,
      kind: "probe",
      source_path: sourcePath,
      ...(stillOutputs.length ? { outputs: stillOutputs } : {}),
    });
    const state = await waitForWorker(
      db,
      workerUrl,
      workerSecret,
      job.id,
      workerId,
    );
    if (state.status !== "complete" || !state.result?.media_info)
      throw new Error(state.error ?? "Probe failed.");
    const mediaInfo = state.result.media_info;
    const num =
      typeof mediaInfo.frameRateNum === "number"
        ? mediaInfo.frameRateNum
        : undefined;
    const den =
      typeof mediaInfo.frameRateDen === "number"
        ? mediaInfo.frameRateDen
        : undefined;
    const timecode =
      typeof mediaInfo.sourceTimecodeStart === "string"
        ? mediaInfo.sourceTimecodeStart
        : undefined;
    // Drop-frame timecode is defined only for the 29.97 (30000/1001) and
    // 59.94 (60000/1001) NTSC rates. A ";" separator on any other (commonly
    // mistagged 24/25/30) source is not drop-frame; honoring it corrupts
    // frame math and breaks exports, so the flag is gated on the exact rate
    // as well as the separator. The worker's normalizeProbe applies the same
    // guard; this is the write-back source of truth.
    const dropFrame =
      (timecode?.includes(";") ?? false) &&
      den === 1001 &&
      (num === 30000 || num === 60000);
    let sourceStartFrame: number | null = null;
    if (timecode && num && den) {
      try {
        const rate = { num, den };
        sourceStartFrame = framesFromTimecode(
          parseTimecode(timecode, rate),
          rate,
        );
      } catch {
        sourceStartFrame = null;
      }
    }
    await db
      .update(assetVersions)
      .set({
        mediaInfoJson: JSON.stringify(mediaInfo),
        sourceTimecodeStart: timecode ?? null,
        sourceStartFrame,
        dropFrame,
        frameRateNum: num ?? null,
        frameRateDen: den ?? null,
        durationFrames:
          typeof mediaInfo.durationFrames === "number"
            ? mediaInfo.durationFrames
            : null,
        colorJson: JSON.stringify(
          mediaInfo.sourceColor ?? {
            assumed: mediaInfo.colorAssumed === true,
          },
        ),
        transcodeStatus: "processing",
      })
      .where(eq(assetVersions.id, versionId))
      .run();
    await insertVersionEvent(db, payload, versionId, "version.probed");
    await insertVersionEvent(
      db,
      payload,
      versionId,
      "version.transcode",
      "processing",
    );
    /* A still came back rendered: register it here and it is done. Anything
       else needs a transcode planned from what the probe just found. */
    if (stillOutputs.length && state.result.renditions) {
      const version = (
        await db
          .select()
          .from(assetVersions)
          .where(eq(assetVersions.id, versionId))
          .limit(1)
          .all()
      )[0] as typeof assetVersions.$inferSelect | undefined;
      if (!version) throw new Error("Version was not found.");
      await registerWorkerRenditions(
        db,
        payload,
        version,
        assetKind,
        state,
        blobRoot,
      );
      return;
    }
    await enqueueTranscode(db, payload, versionId);
    return;
  }
  if (job.kind === "watermark") {
    await processWatermarkJob(
      db,
      job,
      payload,
      versionId,
      sourcePath,
      workerUrl,
      workerSecret,
      blobRoot,
      workerId,
    );
    return;
  }
  if (job.kind !== "transcode")
    throw new Error(`Unsupported worker job kind: ${job.kind}.`);
  const version = (
    await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all()
  )[0] as typeof assetVersions.$inferSelect | undefined;
  if (!version) throw new Error("Version was not found.");
  const assetKind = await assetKindFor(db, payload, versionId);
  const mediaInfo: MediaInfo = {
    format: {},
    streams: [],
    variableFrameRate: false,
    colorAssumed: true,
    ...(parseObject(version.mediaInfoJson) as Partial<MediaInfo>),
  };
  /* A transcode asked for one named rendition renders only that. The stills
     full-size rung arrives this way: it is made on demand, the first time
     someone zooms past the review still on a source no browser can decode. */
  const onlyKinds = Array.isArray(payload.only)
    ? payload.only.filter((kind): kind is string => typeof kind === "string")
    : [];
  const planned: PlannedRendition[] = onlyKinds.length
    ? onlyKinds.map((kind) => ({
        kind,
        filename: stillFilenameFor(kind),
      }))
    : planRenditions(assetKind, mediaInfo);
  if (!planned.length) {
    await db
      .update(assetVersions)
      .set({ transcodeStatus: "skipped" })
      .where(eq(assetVersions.id, version.id))
      .run();
    await insertVersionEvent(
      db,
      payload,
      version.id,
      "version.transcode",
      "skipped",
    );
    return;
  }
  const outputs = planned.map((entry) => ({
    kind: entry.kind,
    path: path.join(blobRoot, "renditions", version.id, entry.filename),
    ...(entry.height === undefined ? {} : { height: entry.height }),
  }));
  await sendJob(workerUrl, workerSecret, {
    job_id: job.id,
    kind: "transcode",
    source_path: sourcePath,
    media_info: mediaInfo,
    outputs,
  });
  const state = await waitForWorker(
    db,
    workerUrl,
    workerSecret,
    job.id,
    workerId,
  );
  if (state.status !== "complete" || !state.result?.renditions)
    throw new Error(state.error ?? "Transcode failed.");
  await registerWorkerRenditions(
    db,
    payload,
    version,
    assetKind,
    state,
    blobRoot,
    { targeted: onlyKinds.length > 0 },
  );
};

// When a probe or transcode job exhausts its attempts and goes dead, the
// version is marked failed (the API materializes transcode.failed
// notifications from that state) and a failed transcode event is emitted.
const recordDeadMediaJob = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
): Promise<void> => {
  try {
    if (job.kind !== "probe" && job.kind !== "transcode") return;
    const state = (
      await db
        /* The error comes with the status: it is the only record of why this
           file would not open, and the notification needs to say so. */
        .select({ status: jobs.status, error: jobs.error })
        .from(jobs)
        .where(eq(jobs.id, job.id))
        .limit(1)
        .all()
    )[0];
    if (state?.status !== "dead") return;
    const payload = parsePayload(job.payloadJson);
    if (payload.secondary_only) return;
    const versionId = payload.version_id;
    if (!versionId) return;
    await db
      .update(assetVersions)
      .set({
        transcodeStatus: "failed",
        /* Keep why, in one line fit to show somebody. The worker's own text is
           a log line: long, multi-line and full of container paths. Without
           this the notification could only offer sympathy. */
        transcodeError: failureReason(state.error),
      })
      .where(eq(assetVersions.id, versionId))
      .run();
    await insertVersionEvent(
      db,
      payload,
      versionId,
      "version.transcode",
      "failed",
    );
  } catch (error) {
    console.warn(
      `[onelight] dead job ${job.id} was not written back to its version: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

interface ExportRow {
  comment: typeof comments.$inferSelect;
  version: typeof assetVersions.$inferSelect;
  asset: typeof assets.$inferSelect;
}

// Stills decode linearly up to the requested frame (accurate seek), so the
// per-still deadline is generous but far below the transcode ceiling.
const STILL_JOB_TIMEOUT_MS = 10 * 60_000;

const summarizeFilter = (filter: ExportFilter): string => {
  const parts: string[] = [];
  if (filter.version_id) parts.push(`version ${filter.version_id}`);
  if (filter.author_user_id) parts.push(`author ${filter.author_user_id}`);
  if (filter.unresolved_only) parts.push("open comments only");
  if (filter.internal !== undefined)
    parts.push(filter.internal ? "internal comments" : "external comments");
  if (filter.has_annotation !== undefined)
    parts.push(filter.has_annotation ? "with drawings" : "without drawings");
  if (filter.frame_in !== undefined || filter.frame_out !== undefined)
    parts.push(
      `frames ${filter.frame_in ?? 0} to ${filter.frame_out ?? "end"}`,
    );
  return parts.length ? parts.join(", ") : "All comments";
};

// PDF report with annotated stills (phase-3 P3-T07). Stills are extracted by
// the media worker over the signed job protocol, annotated with the pure-TS
// SVG compositor, and embedded per comment. Any failure on the still path
// degrades that comment to a text-only block and is logged; the report still
// ships.
const buildPdfExport = async (
  db: AppDb,
  job: typeof exportJobs.$inferSelect,
  blobRoot: string,
  media: { workerUrl?: string | undefined; workerSecret?: string | undefined },
  allRows: ExportRow[],
  selected: ExportRow[],
): Promise<Uint8Array> => {
  const topLevel = selected.filter((row) => row.comment.parentId === null);
  const repliesByParent = new Map<string, ExportRow[]>();
  for (const row of allRows) {
    const parentId = row.comment.parentId;
    if (parentId === null) continue;
    const entries = repliesByParent.get(parentId) ?? [];
    entries.push(row);
    repliesByParent.set(parentId, entries);
  }
  const reactionsByComment = new Map<string, Map<string, number>>();
  for (const ids of chunked(
    topLevel.map((row) => row.comment.id),
    100,
  )) {
    const reactionRows = await db
      .select()
      .from(commentReactions)
      .where(inArray(commentReactions.commentId, ids))
      .all();
    for (const reaction of reactionRows) {
      const counts =
        reactionsByComment.get(reaction.commentId) ?? new Map<string, number>();
      counts.set(reaction.code, (counts.get(reaction.code) ?? 0) + 1);
      reactionsByComment.set(reaction.commentId, counts);
    }
  }
  const project = (
    await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1)
      .all()
  )[0];
  const workerConfigured = Boolean(media.workerUrl && media.workerSecret);
  if (!workerConfigured)
    console.warn(
      `[onelight] pdf export ${job.id}: media worker is not configured; the report falls back to text-only blocks.`,
    );
  const stillsDir = path.join(blobRoot, "exports", `.stills-${job.id}`);
  const proxyByVersion = new Map<string, string | undefined>();
  const proxyFor = async (versionId: string): Promise<string | undefined> => {
    if (proxyByVersion.has(versionId)) return proxyByVersion.get(versionId);
    const proxy = (
      await db
        .select({ blobKey: renditions.blobKey })
        .from(renditions)
        .where(
          and(
            eq(renditions.versionId, versionId),
            eq(renditions.kind, "proxy_1080"),
            isNull(renditions.shareId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    proxyByVersion.set(versionId, proxy?.blobKey);
    return proxy?.blobKey;
  };
  try {
    const reportComments: ReportComment[] = [];
    for (const row of topLevel) {
      const comment = row.comment;
      const version = row.version;
      const rate =
        version.frameRateNum && version.frameRateDen
          ? { num: version.frameRateNum, den: version.frameRateDen }
          : { num: 24, den: 1 };
      let stillPng: Uint8Array | undefined;
      const proxyKey =
        workerConfigured &&
        comment.frameIn !== null &&
        version.transcodeStatus === "ready"
          ? await proxyFor(version.id)
          : undefined;
      if (proxyKey && comment.frameIn !== null) {
        const stillPath = path.join(stillsDir, `${comment.id}.png`);
        try {
          await sendJob(
            media.workerUrl as string,
            media.workerSecret as string,
            {
              job_id: `still-${job.id}-${comment.id}`,
              kind: "still",
              source_path: path.join(blobRoot, proxyKey),
              output_path: stillPath,
              frame: comment.frameIn,
              rate,
            },
          );
          const state = await pollWorker(
            media.workerUrl as string,
            media.workerSecret as string,
            `still-${job.id}-${comment.id}`,
            STILL_JOB_TIMEOUT_MS,
          );
          if (state.status !== "complete")
            throw new Error(state.error ?? "Still extraction failed.");
          stillPng = new Uint8Array(await readFile(stillPath));
        } catch (error) {
          stillPng = undefined;
          console.warn(
            `[onelight] pdf export ${job.id}: still for comment ${comment.id} failed, falling back to a text-only block: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (stillPng && comment.annotationJson) {
        // annotation_json is either a bare stroke array or {strokes: [...]};
        // parseAnnotationStrokes accepts both and drops anything malformed.
        let annotation: unknown;
        try {
          annotation = JSON.parse(comment.annotationJson) as unknown;
        } catch {
          annotation = undefined;
        }
        const resolved = parseAnnotationStrokes(annotation);
        if (resolved.length) {
          try {
            stillPng = await compositeAnnotation(stillPng, resolved);
          } catch (error) {
            console.warn(
              `[onelight] pdf export ${job.id}: annotation composite for comment ${comment.id} failed, embedding the bare still: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      reportComments.push({
        author: comment.authorName ?? "Comment",
        body: comment.bodyText,
        frame: comment.frameIn,
        frameOut: comment.frameOut,
        rate,
        dropFrame: Boolean(version.dropFrame),
        startFrame:
          job.timecodeBase === "source" ? (version.sourceStartFrame ?? 0) : 0,
        assetName: row.asset.name,
        versionNo: version.versionNo,
        completed: comment.completedAt !== null,
        internal: Boolean(comment.internal),
        replies: (repliesByParent.get(comment.id) ?? []).map((reply) => ({
          author: reply.comment.authorName ?? "Reply",
          body: reply.comment.bodyText,
        })),
        reactions: [...(reactionsByComment.get(comment.id) ?? new Map())]
          .map(([code, count]) => ({
            code: code as string,
            count: count as number,
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        ...(stillPng ? { stillPng } : {}),
      });
    }
    return await buildPdfReport({
      project: project?.name ?? job.projectId,
      title: "Comment report",
      filterSummary: summarizeFilter(parseObject(job.filtersJson)),
      generatedAt: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
      comments: reportComments,
    });
  } finally {
    await rm(stillsDir, { recursive: true, force: true });
  }
};

// export_jobs has no lease or heartbeat column like the jobs table, so an
// export left in 'processing' by a crashed pump is never reclaimed on its own
// (the pump only ever selects status='queued'). The single pump processes one
// export synchronously per tick, so any 'processing' row on startup is
// necessarily orphaned; a periodic pass with a generous age threshold catches
// a mid-flight crash after startup. Reclaimed rows go back to 'queued' to be
// retried. There is no started_at column, so createdAt is the age proxy; the
// pump moves queued->processing immediately, so it tracks start time closely.
const EXPORT_RECLAIM_STALE_MS = 30 * 60_000;

const reclaimStuckExports = async (
  db: AppDb,
  processingOlderThan: number,
): Promise<void> => {
  await db
    .update(exportJobs)
    .set({ status: "queued", error: null })
    .where(
      and(
        eq(exportJobs.status, "processing"),
        lt(exportJobs.createdAt, processingOlderThan),
      ),
    )
    .run();
};

const safeExportStem = (value: string): string =>
  value
    .normalize("NFKC")
    // Windows reserves these characters, and control bytes are unsafe on
    // every filesystem and in Content-Disposition.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "onelight-comments";

const exportExtension = (format: string): string =>
  format === "fcpxml"
    ? "fcpxml"
    : format === "avid_xml" || format === "avid_txt"
      ? "txt"
      : format === "xmeml"
        ? "xml"
        : format === "resolve_edl"
          ? "edl"
          : format === "csv"
            ? "csv"
            : format === "json"
              ? "json"
              : "txt";

const zipTextFiles = async (
  files: ReadonlyArray<{ name: string; content: string }>,
): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const entries = files.map((file) => {
    const bytes = encoder.encode(file.content);
    return {
      name: file.name,
      size: bytes.byteLength,
      open: () =>
        Promise.resolve(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        ),
    };
  });
  return new Uint8Array(await new Response(zipStream(entries)).arrayBuffer());
};

const processExportJob = async (
  db: AppDb,
  job: typeof exportJobs.$inferSelect,
  blobRoot: string,
  media: { workerUrl?: string | undefined; workerSecret?: string | undefined },
): Promise<void> => {
  const filter = parseObject(job.filtersJson) as ExportFilter;
  const rows = await db
    .select({ comment: comments, version: assetVersions, asset: assets })
    .from(comments)
    .innerJoin(assetVersions, eq(comments.versionId, assetVersions.id))
    .innerJoin(assets, eq(assetVersions.assetId, assets.id))
    .where(and(eq(assets.projectId, job.projectId), isNull(comments.deletedAt)))
    .orderBy(asc(comments.frameIn), asc(comments.id))
    .all();
  const shareAssetIds = filter.share_id
    ? new Set(
        (
          await db
            .select({ assetId: shareAssets.assetId })
            .from(shareAssets)
            .where(eq(shareAssets.shareId, filter.share_id))
            .all()
        ).map((row) => row.assetId),
      )
    : null;
  const selected = rows.filter((row: ExportRow) => {
    const comment = row.comment;
    if (shareAssetIds && !shareAssetIds.has(row.asset.id)) return false;
    if (filter.version_id && comment.versionId !== filter.version_id)
      return false;
    if (filter.author_user_id && comment.authorUserId !== filter.author_user_id)
      return false;
    if (filter.unresolved_only && comment.completedAt !== null) return false;
    if (
      filter.internal !== undefined &&
      Boolean(comment.internal) !== filter.internal
    )
      return false;
    if (
      filter.has_annotation !== undefined &&
      Boolean(comment.annotationJson) !== filter.has_annotation
    )
      return false;
    if (
      filter.frame_in !== undefined &&
      (comment.frameIn === null || comment.frameIn < filter.frame_in)
    )
      return false;
    if (
      filter.frame_out !== undefined &&
      (comment.frameIn === null || comment.frameIn > filter.frame_out)
    )
      return false;
    return true;
  });
  // Marker formats require a frame; the PDF report keeps frameless comments
  // as text-only blocks instead.
  const markerRows = selected.filter(
    (row) => row.comment.parentId === null && row.comment.frameIn !== null,
  );
  const repliesByParent = new Map<string, ExportRow[]>();
  for (const row of rows) {
    const parentId = row.comment.parentId;
    if (!parentId) continue;
    if (filter.internal !== undefined) {
      if (Boolean(row.comment.internal) !== filter.internal) continue;
    }
    const replies = repliesByParent.get(parentId) ?? [];
    replies.push(row);
    repliesByParent.set(parentId, replies);
  }
  // Each version carries its own rational rate, start frame, and drop-frame
  // flag, so comments are grouped by version and serialized per group.
  interface ExportGroup {
    version?: typeof assetVersions.$inferSelect;
    asset?: typeof assets.$inferSelect;
    markers: Array<{
      id: string;
      bodyText: string;
      authorName: string | null;
      frameIn: number;
      frameOut: number | null;
      completed: boolean;
      internal: boolean;
      replies: Array<{
        id: string;
        bodyText: string;
        authorName: string | null;
      }>;
    }>;
  }
  const byVersion = new Map<string, ExportGroup>();
  for (const row of markerRows) {
    const entry: ExportGroup = byVersion.get(row.version.id) ?? {
      version: row.version,
      asset: row.asset,
      markers: [],
    };
    entry.markers.push({
      id: row.comment.id,
      bodyText: row.comment.bodyText,
      authorName: row.comment.authorName,
      frameIn: row.comment.frameIn as number,
      frameOut: row.comment.frameOut,
      completed: row.comment.completedAt !== null,
      internal: Boolean(row.comment.internal),
      replies: (repliesByParent.get(row.comment.id) ?? []).map((reply) => ({
        id: reply.comment.id,
        bodyText: reply.comment.bodyText,
        authorName: reply.comment.authorName,
      })),
    });
    byVersion.set(row.version.id, entry);
  }
  const groupList: ExportGroup[] = byVersion.size
    ? [...byVersion.values()]
    : [{ markers: [] }];
  const optionsFor = (group: ExportGroup) => {
    const version = group.version;
    return {
      title: version
        ? `${group.asset?.name ?? version.originalFilename} v${version.versionNo} - Onelight comments`
        : "Onelight comments",
      rate: {
        num: version?.frameRateNum ?? 24,
        den: version?.frameRateDen ?? 1,
      },
      startFrame:
        job.timecodeBase === "source" ? (version?.sourceStartFrame ?? 0) : 0,
      ...(version?.durationFrames === null ||
      version?.durationFrames === undefined
        ? {}
        : { durationFrames: version.durationFrames }),
      dropFrame: Boolean(version?.dropFrame),
      timecodeBase: job.timecodeBase,
    } as const;
  };
  const serializeGroup = (group: (typeof groupList)[number]): string => {
    const options = optionsFor(group);
    return job.format === "resolve_edl"
      ? exportResolveEdl(group.markers, options)
      : job.format === "avid_txt"
        ? exportAvidText(group.markers, options)
        : job.format === "avid_xml"
          ? exportAvidXml(group.markers, options)
          : job.format === "xmeml"
            ? exportXmeml(group.markers, options)
            : job.format === "fcpxml"
              ? exportFcpXml(group.markers, options)
              : job.format === "csv"
                ? exportCsv(group.markers, options)
                : job.format === "json"
                  ? exportJson(group.markers, options)
                  : exportText(group.markers, options);
  };
  let output: string | Uint8Array;
  let outputName: string;
  if (job.format === "pdf") {
    output = await buildPdfExport(db, job, blobRoot, media, rows, selected);
    outputName = "onelight-comment-report.pdf";
  } else {
    const extension = exportExtension(job.format);
    const files = groupList.map((group) => ({
      name: `${safeExportStem(
        group.version
          ? `${group.asset?.name ?? group.version.originalFilename} v${group.version.versionNo} comments`
          : "onelight-comments",
      )}.${extension}`,
      content: serializeGroup(group),
    }));
    if (files.length === 1 && files[0]) {
      output = files[0].content;
      outputName = files[0].name;
    } else {
      output = await zipTextFiles(files);
      outputName = "onelight-comments.zip";
    }
  }
  const key = `exports/${job.id}/${outputName}`;
  const directory = path.dirname(path.join(blobRoot, key));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(blobRoot, key), output);
  await db
    .update(exportJobs)
    .set({
      status: "complete",
      resultBlobKey: key,
      finishedAt: Date.now(),
      error: null,
    })
    .where(eq(exportJobs.id, job.id))
    .run();
};

/* How many media jobs may run at once.

   The pump used to run exactly one, awaited to completion, on a one second
   tick, with a status poll that also ran at one second. That put a floor of
   roughly two seconds under every version (a probe job, then a transcode
   job), whatever the work actually cost: a still that renders in 700 ms took
   as long as a feature. Three thousand of them could not finish in a working
   day while three of four cores sat idle.

   Concurrency is bounded rather than generous on purpose. Encodes are the
   heaviest thing this machine does and the site shares its cores, so the
   default leaves two of them alone; an operator with a dedicated box raises
   it. One restores exactly the old behaviour. */
const DEFAULT_MEDIA_CONCURRENCY = Math.max(1, cpus().length - 2);

const mediaConcurrency = (): number => {
  const parsed = Number(process.env.MEDIA_CONCURRENCY);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : DEFAULT_MEDIA_CONCURRENCY;
};

export const startWorkerPump = (
  db: AppDb,
  options: { workerUrl?: string; workerSecret?: string; blobRoot: string },
): (() => void) => {
  // Exports are pure DB-to-file work, so the pump runs them even without a
  // media worker; only probe/transcode (and the PDF's frame stills) need one.
  const mediaEnabled = Boolean(options.workerUrl && options.workerSecret);
  if (!mediaEnabled)
    console.warn(
      "[onelight] Media processing is disabled: WORKER_URL and WORKER_SECRET are not both set. Probe and transcode jobs will stay queued until a worker is configured; comment exports still run.",
    );
  const workerId = new UlidGenerator().ulid();
  const slots = mediaConcurrency();
  let housekeeping = false;
  let exporting = false;
  let running = 0;
  let stopped = false;
  let lastWatermarkSweep = 0;
  let lastShuttleAudioSweep = 0;
  let lastStillLadderSweep = 0;
  let lastStackKeySweep = 0;
  let lastFingerprintSweep = 0;
  let reclaimedOnStart = false;

  /* Media jobs, up to `slots` at a time. Claiming is already race-safe: the
     claim is a conditional UPDATE repeating every claimability predicate, so
     two slots reaching for the same row leave exactly one winner. Each slot
     pulls the next job itself when it finishes, so a queue of stills drains
     continuously rather than one per tick. */
  const pumpJobs = async (): Promise<void> => {
    if (!mediaEnabled || stopped) return;
    while (running < slots) {
      /* The slot is taken BEFORE the claim, not after it. Two of these run
         at once whenever a job finishes while the tick is also looking for
         work, and counting after the await let both of them pass the
         `running < slots` gate on the same free slot: the cap could be
         overshot by one per concurrent caller, which on a four core box
         shared with the site is exactly the thing the cap exists to stop.
         Reserving first is atomic, because nothing yields in between. */
      running += 1;
      let job: Awaited<ReturnType<typeof claimNextJob>>;
      try {
        job = await claimNextJob(db, Date.now(), workerId, ["cpu"]);
      } catch (error) {
        running -= 1;
        console.warn(
          `[onelight] job claim failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      if (!job) {
        running -= 1;
        return;
      }
      const claimed = job;
      void (async () => {
        try {
          await processJob(
            db,
            claimed,
            options.workerUrl as string,
            options.workerSecret as string,
            options.blobRoot,
            workerId,
          );
          await completeJob(db, claimed.id, workerId, Date.now());
        } catch (error) {
          try {
            await failJob(
              db,
              claimed.id,
              workerId,
              Date.now(),
              error instanceof Error ? error.message : "Worker job failed.",
              1000,
            );
            await recordDeadMediaJob(db, claimed);
          } catch (inner) {
            console.warn(
              `[onelight] could not record job failure: ${
                inner instanceof Error ? inner.message : String(inner)
              }`,
            );
          }
        } finally {
          running -= 1;
          /* Straight on to the next one rather than waiting for the tick. */
          void pumpJobs();
        }
      })();
    }
  };

  /* Exports keep their own single slot. A long PDF report used to run inside
     the same awaited tick as media, so it head-of-line blocked every encode
     behind it for its whole duration; now it blocks only the next export. */
  const pumpExports = async (): Promise<void> => {
    if (exporting || stopped) return;
    exporting = true;
    try {
      const pendingExport = (
        await db
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.status, "queued"))
          .orderBy(asc(exportJobs.createdAt))
          .limit(1)
          .all()
      )[0];
      if (!pendingExport) return;
      try {
        await db
          .update(exportJobs)
          .set({ status: "processing" })
          .where(
            and(
              eq(exportJobs.id, pendingExport.id),
              eq(exportJobs.status, "queued"),
            ),
          )
          .run();
        await processExportJob(db, pendingExport, options.blobRoot, {
          workerUrl: mediaEnabled ? options.workerUrl : undefined,
          workerSecret: mediaEnabled ? options.workerSecret : undefined,
        });
      } catch (error) {
        await db
          .update(exportJobs)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : "Export failed.",
            finishedAt: Date.now(),
          })
          .where(eq(exportJobs.id, pendingExport.id))
          .run();
      }
    } catch (error) {
      console.warn(
        `[onelight] export pump failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      exporting = false;
    }
  };

  const sweep = async (
    name: string,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      console.warn(
        `[onelight] ${name} sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /* Reclaims and sweeps. Their own re-entrancy guard, separate from the job
     slots, so a slow sweep never stops work being claimed. */
  const tick = async () => {
    if (!housekeeping) {
      housekeeping = true;
      try {
        const now = Date.now();
        // On the first tick, reclaim every export still in 'processing': the
        // pump processes exports one at a time, so such a row can only be an
        // orphan from a crashed previous process. Afterwards, reclaim only
        // rows older than the stale threshold, catching a mid-flight crash
        // without disturbing an export this pump is actively running.
        if (!reclaimedOnStart) {
          reclaimedOnStart = true;
          await reclaimStuckExports(db, now);
        } else {
          await reclaimStuckExports(db, now - EXPORT_RECLAIM_STALE_MS);
        }
        // Reconcile missing renditions on a throttle rather than every poll;
        // each sweep is bounded per pass.
        if (
          mediaEnabled &&
          now - lastWatermarkSweep >= WATERMARK_SWEEP_INTERVAL_MS
        ) {
          lastWatermarkSweep = now;
          await sweep("watermark", () => sweepWatermarkJobs(db));
        }
        if (now - lastStackKeySweep >= STACK_KEY_SWEEP_INTERVAL_MS) {
          lastStackKeySweep = now;
          /* A full batch means there is more, and there is a reason to hurry:
             batch versioning matches against this column, so an upload
             arriving before the backfill reaches its asset silently matches
             nothing and lands as a new asset instead. Draining at a batch per
             tick clears a large library in under a minute rather than over an
             hour; a short batch means it is done and the throttle resumes. */
          const filled = await sweepStackKeys(db).catch((error: unknown) => {
            console.warn(
              `[onelight] stack key sweep failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return 0;
          });
          if (filled >= STACK_KEY_SWEEP_BATCH) lastStackKeySweep = 0;
        }
        if (
          mediaEnabled &&
          now - lastStillLadderSweep >= STILL_LADDER_SWEEP_INTERVAL_MS
        ) {
          lastStillLadderSweep = now;
          await sweep("still re-kind", () => sweepReKindStills(db));
          await sweep("still ladder", () => sweepStillLadderJobs(db));
        }
        if (
          mediaEnabled &&
          now - lastFingerprintSweep >= FINGERPRINT_SWEEP_INTERVAL_MS
        ) {
          lastFingerprintSweep = now;
          await sweep("fingerprint", () => sweepFingerprints(db));
        }
        if (
          mediaEnabled &&
          now - lastShuttleAudioSweep >= SHUTTLE_AUDIO_SWEEP_INTERVAL_MS
        ) {
          lastShuttleAudioSweep = now;
          await sweep("shuttle audio", () => sweepShuttleAudioJobs(db));
        }
      } catch (error) {
        // A transient failure here must not wedge the pump: log it and let
        // the finally clear the guard for the next tick.
        console.warn(
          `[onelight] worker pump housekeeping failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        housekeeping = false;
      }
    }
    void pumpExports();
    void pumpJobs();
  };
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
