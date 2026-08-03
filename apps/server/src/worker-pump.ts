import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  claimNextJob,
  completeJob,
  failJob,
  buryAbandonedJob,
  findAbandonedJobs,
} from "@onelight/db";
import type { AppDb } from "@onelight/db";

/**
 * What the pump needs from storage, which is not a filesystem.
 *
 * Narrow on purpose: where a key lives is the store's business. The pump used
 * to stat() and hash the worker's output files directly, which only works
 * while both processes mount one volume. Everything it still needs to know
 * about a blob it asks the store, so the same code runs against R2.
 */
export interface PumpBlobStore {
  head(key: string): Promise<{ size: number }>;
  delete(key: string): Promise<void>;
}

interface WorkerResponse {
  status: "queued" | "processing" | "complete" | "failed";
  result?: {
    media_info?: Record<string, unknown>;
    /* size and sha256 are what the worker says it wrote. Typed as unknown
       because they arrive as JSON from another process: every one of them is
       validated before it reaches a row. */
    renditions?: Array<{
      kind: string;
      key: unknown;
      size?: unknown;
      sha256?: unknown;
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

/* Pacing knobs come from the validated config the server boots with. They
   stay behind accessors because the pump is also driven directly by tests and
   by the CLI, neither of which builds a full AppConfig. */
let pacing: {
  workerJobTimeoutMs: number;
  watermarkSweepLimit: number;
} = {
  workerJobTimeoutMs: DEFAULT_WORKER_JOB_TIMEOUT_MS,
  watermarkSweepLimit: 8,
};

export const configurePumpPacing = (next: {
  workerJobTimeoutMs: number;
  watermarkSweepLimit: number;
}): void => {
  pacing = next;
};

/** The ceiling one job may run for, which travels to the worker in its
    envelope: the server owns the policy, the worker enforces it. */
export const workerJobTimeoutMs = (): number => pacing.workerJobTimeoutMs;

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

/* A blob key as it may appear on a rendition row: relative, forward slashes,
   no traversal, and bounded. The store refuses an escaping key as well, but a
   key that never becomes one is better than a key caught on the way out. */
const BLOB_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;

/**
 * A key the worker reported, or an error.
 *
 * The worker is the process that opens files nobody vetted -- every asset a
 * stranger uploads is parsed there by ffmpeg, Poppler, LibRaw and libheif --
 * so where it says it wrote is checked rather than believed. `prefix` is the
 * namespace this job was given: a job for one version cannot report a key
 * belonging to another version, and cannot climb out of the blob root.
 */
const reportedKey = (prefix: string, reported: unknown): string => {
  if (
    typeof reported !== "string" ||
    reported.length > 512 ||
    reported.includes("..") ||
    !BLOB_KEY.test(reported) ||
    !reported.startsWith(prefix)
  )
    throw new Error(
      `The worker reported an output outside ${prefix}: ${String(reported)}.`,
    );
  return reported;
};

/* Bytes, as reported. A negative or fractional size is a malformed report, and
   a size that disagrees with the stored object is caught by validateWritten. */
const reportedSize = (kind: string, reported: unknown): number => {
  if (
    typeof reported !== "number" ||
    !Number.isSafeInteger(reported) ||
    reported < 0
  )
    throw new Error(
      `The worker reported no usable size for ${kind}: ${String(reported)}.`,
    );
  return reported;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

const reportedDigest = (kind: string, reported: unknown): string => {
  if (typeof reported !== "string" || !SHA256_HEX.test(reported))
    throw new Error(
      `The worker reported no usable sha256 for ${kind}: ${String(reported)}.`,
    );
  return reported;
};

/**
 * The worker says it wrote this many bytes at this key; the store is asked.
 *
 * This is audit item 2's inversion in one function. The pump no longer opens
 * the worker's output: it takes the size and the checksum from the process
 * that produced the bytes, and binds that report to the object the store
 * actually holds. A worker that reports a rendition it never wrote, or lies
 * about its length, fails the job here and it is retried.
 *
 * The checksum is the worker's own assertion. Nothing on this side can verify
 * it without reading the whole object back, which is exactly the cost this
 * removes; under R2 the checksum is given to the store at upload time and the
 * store rejects a body that does not match it.
 */
const validateWritten = async (
  store: PumpBlobStore,
  kind: string,
  key: string,
  size: number,
): Promise<void> => {
  const stored = await store.head(key).catch((error: unknown) => {
    throw new Error(
      `The worker reported ${kind} at ${key}, which the store does not hold: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (stored.size !== size)
    throw new Error(
      `The worker reported ${String(size)} bytes for ${kind} at ${key}, but the store holds ${String(stored.size)}.`,
    );
};

const chunked = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    groups.push(items.slice(index, index + size));
  return groups;
};

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
/* The share this render belongs to, as the job named it.
   
   share_id, spec_hash and output_key all travel in the payload, so both halves
   read the same three values rather than deriving them from state that moves.
   What CAN move is the share itself, which is why both halves check it. */
const watermarkTarget = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  payload: JobPayload,
): Promise<{
  shareId: string;
  specHash: string;
  outputKey: string;
  spec: Record<string, unknown>;
  share: typeof shares.$inferSelect;
} | null> => {
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
    return null;
  }
  return { shareId, specHash, outputKey, spec, share };
};

const planWatermarkJob = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  payload: JobPayload,
  versionId: string,
  sourcePath: string,
  blobRoot: string,
): Promise<JobPlan> => {
  const target = await watermarkTarget(db, job, payload);
  if (!target) return null;
  const { outputKey, spec, share } = target;
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
  return {
    request: {
      kind: "watermark",
      source_path: sourcePath,
      output_key: outputKey,
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
    },
  };
};

const applyWatermarkResult = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  payload: JobPayload,
  versionId: string,
  state: WorkerResponse,
  store: PumpBlobStore,
): Promise<void> => {
  /* Checked again, not carried over. A share revoked WHILE the render ran
     used to have its burned rendition registered anyway, because the only
     check happened before the encode started. */
  const target = await watermarkTarget(db, job, payload);
  if (!target) return;
  const { specHash, outputKey, shareId } = target;
  const version = (
    await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all()
  )[0];
  if (state.status !== "complete")
    throw new Error(state.error ?? "Watermark render failed.");
  const rendered =
    state.result?.renditions?.find(
      (rendition) => rendition.kind === "watermarked",
    ) ?? null;
  const renderedMeta = rendered?.meta ?? null;
  if (!renderedMeta || !completePlayableRenditionMeta(renderedMeta))
    throw new Error(
      "Watermark worker did not return a complete playable rendition contract.",
    );
  /* The burned render goes exactly where the job said, so the reported key is
     compared against that one key rather than a namespace. */
  if (rendered?.key !== outputKey)
    throw new Error(
      `The watermark job wrote ${String(rendered?.key)} instead of ${outputKey}.`,
    );
  const renderedSize = reportedSize("watermarked", rendered.size);
  if (renderedSize === 0)
    throw new Error("The watermark job wrote an empty rendition.");
  const renderedDigest = reportedDigest("watermarked", rendered.sha256);
  await validateWritten(store, "watermarked", outputKey, renderedSize);
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
      await store.delete(old.blobKey);
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
      size: renderedSize,
      checksumSha256: renderedDigest,
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
const watermarkSweepLimit = (): number => pacing.watermarkSweepLimit;

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

/* Where a version's renditions live, and the only namespace a job for that
   version may report having written into. */
const renditionPrefix = (versionId: string): string =>
  `renditions/${versionId}/`;

const registerWorkerRenditions = async (
  db: AppDb,
  payload: JobPayload,
  version: typeof assetVersions.$inferSelect,
  assetKind: string,
  state: WorkerResponse,
  store: PumpBlobStore,
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
  const prefix = renditionPrefix(version.id);
  for (const rendition of state.result.renditions) {
    const key = reportedKey(prefix, rendition.key);
    const size = reportedSize(rendition.kind, rendition.size);
    /* A 0-byte output is not a rendition. ffmpeg can exit 0 with an empty file
       on a frameless or degenerate source (a poster/sprite of a 0-duration or
       image-as-video input); registering it would reference a broken blob the
       GC then keeps forever and the player draws as a broken frame. Skip it. */
    if (size === 0) {
      console.warn(
        `[onelight] rendition ${rendition.kind} for version ${version.id} was 0 bytes; skipping.`,
      );
      continue;
    }
    const checksumSha256 = reportedDigest(rendition.kind, rendition.sha256);
    await validateWritten(store, rendition.kind, key, size);
    const meta = { ...rendition.meta };
    /* A worker old enough to report where it wrote by path cannot be answered
       here, and must not be answered by dropping the cue sheet: hover scrub
       would silently stop working on every sprite that worker produced. The
       job fails instead, and is retried on a worker of this version. */
    if (meta.vtt_path !== undefined)
      throw new Error(
        `The worker reported ${rendition.kind} with a vtt_path; this server expects vtt_key and vtt_size.`,
      );
    /* The sprite's cue sheet is written beside it and registered on its meta,
       so it is reported and checked exactly like the rendition it belongs to.
       Its size is what the sprite row says the VTT is, and the player reads
       it from there. */
    if (meta.vtt_key !== undefined || meta.vtt_size !== undefined) {
      const vttKey = reportedKey(prefix, meta.vtt_key);
      const vttSize = reportedSize(
        `${rendition.kind} cue sheet`,
        meta.vtt_size,
      );
      await validateWritten(
        store,
        `${rendition.kind} cue sheet`,
        vttKey,
        vttSize,
      );
      delete meta.vtt_key;
      meta.vtt_blob_key = vttKey;
      meta.vtt_size = vttSize;
    }
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
          size,
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
          size,
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

/* What the worker is asked for, or null when the job needs no worker at all.
   Building the request and folding the result back in are separate on purpose:
   under the pull protocol they happen in two different requests, so the second
   half may not depend on anything the first half computed. Each apply
   recomputes what it needs from the payload and the database. */
type JobPlan = { request: Record<string, unknown> } | null;

const stringIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/* A batch of uploads, identified so the matcher can offer them as new versions
   of something. Nothing here touches an asset: an upload is not a version yet,
   and may never become one. The same job identifies existing versions, for a
   library that predates fingerprinting: same decoder, same arithmetic, a
   different row to write it on. */
const planFingerprintJob = async (
  db: AppDb,
  payload: JobPayload,
  blobRoot: string,
): Promise<JobPlan> => {
  const ids = stringIds(payload.upload_ids);
  const versionIds = stringIds(payload.version_ids);
  if (!ids.length && !versionIds.length) return null;
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
  if (!sources.length) return null;
  return { request: { kind: "fingerprint", sources } };
};

const applyFingerprintResult = async (
  db: AppDb,
  payload: JobPayload,
  state: WorkerResponse,
): Promise<void> => {
  if (state.status !== "complete" || !state.result?.fingerprints)
    throw new Error(state.error ?? "Fingerprinting failed.");
  const ids = stringIds(payload.upload_ids);
  const versionIds = stringIds(payload.version_ids);
  const isVersion = new Set(versionIds);
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
  const answered = new Set(state.result.fingerprints.map((print) => print.id));
  for (const id of ids)
    if (!answered.has(id))
      await db
        .update(uploadSessions)
        .set({ fingerprintState: "skipped" })
        .where(eq(uploadSessions.id, id))
        .run();
};

/* A transcode asked for one named rendition renders only that. The stills
   full-size rung arrives this way: it is made on demand, the first time
   someone zooms past the review still on a source no browser can decode. */
const targetedKinds = (payload: JobPayload): string[] =>
  Array.isArray(payload.only)
    ? payload.only.filter((kind): kind is string => typeof kind === "string")
    : [];

const planTranscodeJob = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
  sourcePath: string,
  blobRoot: string,
): Promise<JobPlan> => {
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
  const onlyKinds = targetedKinds(payload);
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
    return null;
  }
  const outputs = planned.map((entry) => ({
    kind: entry.kind,
    /* Both, for now. The key is what the worker reports and what lands on the
       rendition row; the path is how it reaches the bytes today. P0-2 replaces
       the path with a presigned destination and the key stays as it is. */
    key: `${renditionPrefix(version.id)}${entry.filename}`,
    path: path.join(blobRoot, "renditions", version.id, entry.filename),
    ...(entry.height === undefined ? {} : { height: entry.height }),
  }));
  return {
    request: {
      kind: "transcode",
      source_path: sourcePath,
      media_info: mediaInfo,
      outputs,
    },
  };
};

const applyTranscodeResult = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
  state: WorkerResponse,
  store: PumpBlobStore,
): Promise<void> => {
  if (state.status !== "complete" || !state.result?.renditions)
    throw new Error(state.error ?? "Transcode failed.");
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
  await registerWorkerRenditions(
    db,
    payload,
    version,
    assetKind,
    state,
    store,
    { targeted: targetedKinds(payload).length > 0 },
  );
};

const planProbeJob = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
  sourcePath: string,
  blobRoot: string,
): Promise<JobPlan> => {
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
    /* Nothing for a worker to do: ffprobe cannot parse either kind. */
    return null;
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
          key: `${renditionPrefix(versionId)}${entry.filename}`,
          path: path.join(blobRoot, "renditions", versionId, entry.filename),
        }))
      : [];
  return {
    request: {
      kind: "probe",
      source_path: sourcePath,
      ...(stillOutputs.length ? { outputs: stillOutputs } : {}),
    },
  };
};

const applyProbeResult = async (
  db: AppDb,
  payload: JobPayload,
  versionId: string,
  state: WorkerResponse,
  store: PumpBlobStore,
): Promise<void> => {
  /* The failure is reported before anything else is read, so a probe that
     failed surfaces as the probe's own error rather than as whatever the next
     query happened to hit. */
  if (state.status !== "complete" || !state.result?.media_info)
    throw new Error(state.error ?? "Probe failed.");
  const assetKind = await assetKindFor(db, payload, versionId);
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
     else needs a transcode planned from what the probe just found.

     Recomputed rather than carried over from the plan: a still's ladder is
     requested exactly when the asset is an image, which the row still says. */
  if (assetKind === "image" && state.result.renditions) {
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
      store,
    );
    return;
  }
  await enqueueTranscode(db, payload, versionId);
  return;
};

/* One frame of a proxy, decoded for a comment report.
 *
 * Nothing is registered when it lands: the PNG is scratch that the export
 * reads back and deletes. The job exists so the frame is rendered by whoever
 * holds a decoder rather than by the process that happens to be assembling
 * the report, which is what let the export dial a single worker directly. */
const planStillJob = (
  payload: JobPayload,
  sourcePath: string,
  blobRoot: string,
): { request: Record<string, unknown> } => {
  const outputKey =
    typeof payload.output_key === "string" ? payload.output_key : undefined;
  const frame = payload.frame;
  if (!outputKey || typeof frame !== "number" || !Number.isInteger(frame))
    throw new Error("Still payload is missing output_key or frame.");
  const rate = recordValue(payload.rate);
  const usableRate =
    rate && positiveInteger(rate.num) && positiveInteger(rate.den)
      ? { num: rate.num as number, den: rate.den as number }
      : undefined;
  return {
    request: {
      kind: "still",
      source_path: sourcePath,
      output_key: outputKey,
      output_path: path.join(blobRoot, outputKey),
      frame,
      ...(usableRate ? { rate: usableRate } : {}),
    },
  };
};

const applyStillResult = async (
  payload: JobPayload,
  state: WorkerResponse,
  store: PumpBlobStore,
): Promise<void> => {
  if (state.status !== "complete")
    throw new Error(state.error ?? "Still extraction failed.");
  const outputKey =
    typeof payload.output_key === "string" ? payload.output_key : undefined;
  if (!outputKey) throw new Error("Still payload is missing output_key.");
  /* The frame is proven here rather than where it is read: a zero byte PNG
     would otherwise reach the report as a corrupt image block instead of as
     the text-only fallback that a failed still is meant to produce. Asked of
     the store rather than of the reported size alone, so a still that was
     reported but never landed fails the job instead of the report. */
  const written = await store.head(outputKey).catch(() => null);
  if (!written?.size)
    throw new Error("The still job wrote nothing at its output key.");
};

/* What a claiming worker is handed.
 *
 * The two halves of a job are now two HTTP requests: this one runs when a
 * worker claims, and the apply half runs when it reports back, possibly on a
 * different server process and certainly a long time later. Nothing may be
 * carried between them in memory -- every apply recomputes its context from
 * the payload and the database.
 *
 * Null means the job is moot (its share was revoked, its uploads vanished):
 * there is nothing for a worker to do, and the caller completes it. */
const planJob = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  payload: JobPayload,
  blobRoot: string,
): Promise<JobPlan> => {
  if (job.kind === "fingerprint")
    return planFingerprintJob(db, payload, blobRoot);
  const sourceKey = payload.blob_key;
  const versionId = payload.version_id;
  if (!sourceKey || !versionId)
    throw new Error("Job payload is missing blob_key or version_id.");
  const sourcePath = path.join(blobRoot, sourceKey);
  if (job.kind === "probe")
    return planProbeJob(db, payload, versionId, sourcePath, blobRoot);
  if (job.kind === "watermark")
    return planWatermarkJob(db, job, payload, versionId, sourcePath, blobRoot);
  /* Always plannable, unlike the others: a still's payload is written by the
     export waiting on it, not reconstructed from state that may have moved. */
  if (job.kind === "still") return planStillJob(payload, sourcePath, blobRoot);
  if (job.kind !== "transcode")
    throw new Error(`Unsupported worker job kind: ${job.kind}.`);
  return planTranscodeJob(db, payload, versionId, sourcePath, blobRoot);
};

/** What a worker reported, written down. Throwing fails the job. */
export const applyWorkerJobResult = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  state: WorkerResponse,
  store: PumpBlobStore,
): Promise<void> => {
  const payload = parsePayload(job.payloadJson);
  if (job.kind === "fingerprint") {
    await applyFingerprintResult(db, payload, state);
    return;
  }
  const versionId = payload.version_id;
  if (!versionId) throw new Error("Job payload is missing version_id.");
  if (job.kind === "probe") {
    await applyProbeResult(db, payload, versionId, state, store);
    return;
  }
  if (job.kind === "watermark") {
    await applyWatermarkResult(db, job, payload, versionId, state, store);
    return;
  }
  if (job.kind === "still") {
    await applyStillResult(payload, state, store);
    return;
  }
  if (job.kind !== "transcode")
    throw new Error(`Unsupported worker job kind: ${job.kind}.`);
  await applyTranscodeResult(db, payload, versionId, state, store);
};

/* How long a claim holds a job before another worker may take it, and how far
   each progress report pushes that out. Short enough that a worker killed
   mid-encode is noticed in under a minute, long enough that a worker under
   load has many chances to report before it is judged gone. */
export const WORKER_LEASE_MS = 60_000;

/* How many moot jobs a single claim will retire before answering "nothing to
   do". A queue full of revoked shares would otherwise make one claim walk the
   whole backlog while the worker waits on the response. */
const MOOT_JOBS_PER_CLAIM = 5;

export interface ClaimedJob {
  job: typeof jobs.$inferSelect;
  request: Record<string, unknown>;
}

/**
 * Hand one job to a worker that asked for work.
 *
 * The claim is the same race-safe conditional UPDATE the server used when it
 * drove the jobs itself; what changed is who calls it. A job whose plan comes
 * back null is completed here and the next candidate tried, because a worker
 * cannot be asked to run nothing, and a job whose plan throws is failed here,
 * because a payload the server cannot even read will not become readable on a
 * worker.
 */
export const claimWorkerJob = async (
  db: AppDb,
  blobRoot: string,
  workerId: string,
  capabilities: string[],
): Promise<ClaimedJob | null> => {
  for (let retired = 0; retired <= MOOT_JOBS_PER_CLAIM; retired += 1) {
    const job = await claimNextJob(
      db,
      Date.now(),
      workerId,
      capabilities,
      WORKER_LEASE_MS,
    );
    if (!job) return null;
    const payload = parsePayload(job.payloadJson);
    let plan: JobPlan;
    try {
      plan = await planJob(db, job, payload, blobRoot);
    } catch (error) {
      await failJob(
        db,
        job.id,
        workerId,
        Date.now(),
        error instanceof Error ? error.message : "Job could not be planned.",
        1000,
      );
      await recordDeadMediaJob(db, job);
      continue;
    }
    if (!plan) {
      await completeJob(db, job.id, workerId, Date.now());
      continue;
    }
    return { job, request: plan.request };
  }
  return null;
};

// When a probe or transcode job exhausts its attempts and goes dead, the
// version is marked failed (the API materializes transcode.failed
// notifications from that state) and a failed transcode event is emitted.
/**
 * Whether a dead media job says anything about whether its version is usable.
 *
 * Only the primary pipeline does. A job carrying `only` was asked for one named
 * rendition -- the full-size still rendered on demand the first time somebody
 * zooms, or a ladder rung backfilled long afterwards -- and a version that has
 * been ready for months must not be marked failed because an optional zoom
 * rung could not be built. `secondary_only` says the same thing for the
 * shuttle-audio pass.
 */
export const judgesTheVersion = (payload: JobPayload): boolean => {
  if (payload.secondary_only) return false;
  if (Array.isArray(payload.only) && payload.only.length > 0) return false;
  return true;
};

/**
 * Mark the version behind an abandoned media job failed.
 *
 * Runs while the job is still `processing`, before it is buried, so a failure
 * anywhere leaves the row where the next sweep will find it. Errors propagate
 * for the same reason: swallowing one here would bury a job whose version was
 * never written back, and nothing would ever look at it again.
 *
 * Idempotent, because a burial that fails after this succeeded means the next
 * sweep runs it a second time: a version already failed is left alone rather
 * than stamped and announced twice.
 */
const markAbandonedVersionFailed = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
): Promise<void> => {
  if (job.kind !== "probe" && job.kind !== "transcode") return;
  const payload = parsePayload(job.payloadJson);
  if (!judgesTheVersion(payload)) return;
  const versionId = payload.version_id;
  if (!versionId) return;
  const version = (
    await db
      .select({ status: assetVersions.transcodeStatus })
      .from(assetVersions)
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all()
  )[0];
  /* Already failed: nothing to say twice. Already ready: it has its
     renditions, and a later job dying does not take them away. */
  if (!version || version.status === "failed" || version.status === "ready")
    return;
  await db
    .update(assetVersions)
    .set({
      transcodeStatus: "failed",
      transcodeError: failureReason(
        "The worker holding this job stopped reporting and its attempts are spent.",
      ),
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
};

export const recordDeadMediaJob = async (
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
    if (!judgesTheVersion(payload)) return;
    const versionId = payload.version_id;
    if (!versionId) return;
    const current = (
      await db
        .select({ status: assetVersions.transcodeStatus })
        .from(assetVersions)
        .where(eq(assetVersions.id, versionId))
        .limit(1)
        .all()
    )[0];
    if (current?.status === "ready") return;
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
// deadline is generous but far below the transcode ceiling. It now covers the
// whole batch rather than one still at a time, because the batch renders
// concurrently across however many workers exist.
const STILL_JOB_TIMEOUT_MS = 10 * 60_000;
const STILL_SETTLE_POLL_MS = 250;
/* How long to wait for ANY worker to so much as pick one of these up before
   deciding nobody is listening. Stills are queued above the media pipeline,
   so a worker with a free slot claims one within a second; two minutes of
   nothing means there is no worker, and the export must not hold the single
   export slot for the full deadline waiting on a queue no one is draining. */
const STILL_UNCLAIMED_GRACE_MS = 2 * 60_000;

/* Queue a report still, or leave alone the one already queued under this key.
 *
 * Priority above the media pipeline: a report that waits behind a morning's
 * uploads is a report that hits its deadline and ships text-only blocks. Two
 * attempts, because a frame that will not decode fails the same way twice and
 * the report should degrade rather than wait for a third try. */
const enqueueExportStill = async (
  db: AppDb,
  key: string,
  payload: JobPayload,
): Promise<void> => {
  const existing = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.idempotencyKey, key))
    .limit(1)
    .all();
  if (existing.length) return;
  const now = Date.now();
  await db
    .insert(jobs)
    .values({
      id: new UlidGenerator().ulid(),
      kind: "still",
      payloadJson: JSON.stringify(payload),
      idempotencyKey: key,
      status: "queued",
      priority: 5,
      capabilityJson: "{}",
      maxAttempts: 2,
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

/* Wait for a batch of jobs, named by idempotency key, and answer which of them
   completed. A job that dies, or that is still running when the deadline
   passes, is simply absent from the answer: its comment becomes a text-only
   block, exactly as it did when a still failed under the old direct call. */
const settledStillJobs = async (
  db: AppDb,
  keys: string[],
  deadline: number,
): Promise<Set<string>> => {
  const complete = new Set<string>();
  const startedAt = Date.now();
  let touched = false;
  let pending = keys;
  while (pending.length) {
    const rows = await db
      .select({
        key: jobs.idempotencyKey,
        status: jobs.status,
        attempts: jobs.attempts,
      })
      .from(jobs)
      .where(inArray(jobs.idempotencyKey, pending))
      .all();
    const stillRunning: string[] = [];
    for (const row of rows) {
      if (row.attempts > 0) touched = true;
      if (row.status === "complete") complete.add(row.key);
      else if (row.status !== "dead") stillRunning.push(row.key);
    }
    /* A key with no row at all is finished as far as this wait is concerned:
       something deleted it, and nothing is going to render it now. */
    pending = stillRunning;
    if (!pending.length || Date.now() >= deadline) break;
    if (!touched && Date.now() - startedAt >= STILL_UNCLAIMED_GRACE_MS) {
      console.warn(
        "[onelight] no worker has claimed a report still in two minutes; the report ships without them.",
      );
      break;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, STILL_SETTLE_POLL_MS),
    );
  }
  return complete;
};

/* The report is built or abandoned, so its stills are of no further interest.
   Rows are dropped rather than left complete: a retried export re-enqueues the
   same keys, and finding them already complete -- with the PNGs long deleted --
   would silently give every comment a text-only block. A row that is somehow
   still running is dropped too, and its worker's completion lands on nothing. */
const discardExportStillJobs = async (
  db: AppDb,
  keys: string[],
): Promise<void> => {
  if (!keys.length) return;
  await db.delete(jobs).where(inArray(jobs.idempotencyKey, keys)).run();
};

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
  mediaEnabled: boolean,
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
  if (!mediaEnabled)
    console.warn(
      `[onelight] pdf export ${job.id}: media processing is not configured; the report falls back to text-only blocks.`,
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
  /* Every frame the report wants, queued in one pass before any of them is
     waited on. Under the old direct call these were one round trip each, in
     comment order, against one configured worker; as jobs they render
     concurrently on whatever workers exist, and a report is no longer a
     reason for the server to hold a worker's address. */
  const stillKeyFor = (commentId: string): string =>
    `still:${job.id}:${commentId}`;
  const stillKeys: string[] = [];
  try {
    if (mediaEnabled)
      for (const row of topLevel) {
        const { comment, version } = row;
        if (comment.frameIn === null || version.transcodeStatus !== "ready")
          continue;
        const proxyKey = await proxyFor(version.id);
        if (!proxyKey) continue;
        const key = stillKeyFor(comment.id);
        await enqueueExportStill(db, key, {
          version_id: version.id,
          blob_key: proxyKey,
          output_key: path.posix.join(
            "exports",
            `.stills-${job.id}`,
            `${comment.id}.png`,
          ),
          frame: comment.frameIn,
          rate:
            version.frameRateNum && version.frameRateDen
              ? { num: version.frameRateNum, den: version.frameRateDen }
              : { num: 24, den: 1 },
        });
        stillKeys.push(key);
      }
    const renderedStills = stillKeys.length
      ? await settledStillJobs(db, stillKeys, Date.now() + STILL_JOB_TIMEOUT_MS)
      : new Set<string>();
    if (stillKeys.length > renderedStills.size)
      console.warn(
        `[onelight] pdf export ${job.id}: ${String(
          stillKeys.length - renderedStills.size,
        )} of ${String(stillKeys.length)} stills did not render in time; those comments fall back to text-only blocks.`,
      );
    const reportComments: ReportComment[] = [];
    for (const row of topLevel) {
      const comment = row.comment;
      const version = row.version;
      const rate =
        version.frameRateNum && version.frameRateDen
          ? { num: version.frameRateNum, den: version.frameRateDen }
          : { num: 24, den: 1 };
      let stillPng: Uint8Array | undefined;
      if (renderedStills.has(stillKeyFor(comment.id))) {
        try {
          stillPng = new Uint8Array(
            await readFile(path.join(stillsDir, `${comment.id}.png`)),
          );
        } catch (error) {
          stillPng = undefined;
          console.warn(
            `[onelight] pdf export ${job.id}: still for comment ${comment.id} could not be read, falling back to a text-only block: ${
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
    await discardExportStillJobs(db, stillKeys);
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
  mediaEnabled: boolean,
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
    output = await buildPdfExport(
      db,
      job,
      blobRoot,
      mediaEnabled,
      rows,
      selected,
    );
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

export const startWorkerPump = (
  db: AppDb,
  options: { workerSecret?: string; blobRoot: string },
): (() => void) => {
  /* Exports are pure DB-to-file work, so the pump runs them whether or not
     any worker exists; media jobs are no longer run here at all. The server
     queues them, hands them out over /api/v1/worker, and writes down what
     comes back, so what this flag now gates is whether there is any point
     queueing them: without a secret no worker can claim, and the jobs would
     pile up behind a door nobody can open. */
  const mediaEnabled = Boolean(options.workerSecret);
  if (!mediaEnabled)
    console.warn(
      "[onelight] Media processing is disabled: WORKER_SECRET is not set, so no worker can claim a job. Probe and transcode jobs will stay queued until one is configured; comment exports still run.",
    );
  let housekeeping = false;
  let exporting = false;
  let stopped = false;
  let lastWatermarkSweep = 0;
  let lastShuttleAudioSweep = 0;
  let lastStillLadderSweep = 0;
  let lastStackKeySweep = 0;
  let lastFingerprintSweep = 0;
  let reclaimedOnStart = false;

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
        await processExportJob(
          db,
          pendingExport,
          options.blobRoot,
          mediaEnabled,
        );
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
        /* Media jobs whose worker vanished for good. Claiming already refuses
           them once their attempts are spent, so without this they would sit
           in `processing` forever and the version would never read as failed:
           nothing else fails a job nobody is holding. */
        for (const abandoned of await findAbandonedJobs(db, now)) {
          try {
            /* Write back first, bury second. The other order loses the
               version: once the job is `dead` no sweep selects it again, so a
               writeback that failed after burial would never be retried and
               the version would stay pending forever. */
            await markAbandonedVersionFailed(db, abandoned);
            await buryAbandonedJob(db, abandoned.id, now);
            console.warn(
              `[onelight] job ${abandoned.id} (${abandoned.kind}) was abandoned by its worker after ${String(abandoned.attempts)} attempts.`,
            );
          } catch (error) {
            /* Left `processing` on purpose: the next sweep picks it up. */
            console.warn(
              `[onelight] could not retire abandoned job ${abandoned.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
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
