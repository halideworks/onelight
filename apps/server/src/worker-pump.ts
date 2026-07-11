import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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
  parseTimecode,
  UlidGenerator,
} from "@onelight/core";
import type { MediaInfo } from "@onelight/core";
import {
  buildPdfReport,
  compositeAnnotation,
  parseAnnotationStrokes,
  planRenditions,
  primaryRenditionKinds,
} from "@onelight/worker";
import type { ReportComment } from "@onelight/worker";
import {
  assetVersions,
  assets,
  commentReactions,
  comments,
  exportJobs,
  jobs,
  projects,
  renditions,
  shareAssets,
  shares,
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
  });
  // 409 means the worker is already running this job id; fall through to
  // polling instead of spawning a duplicate run.
  if (response.status === 409) return;
  if (!response.ok)
    throw new Error(`Worker rejected job with ${response.status}.`);
};

const pollWorker = async (
  workerUrl: string,
  workerSecret: string,
  jobId: string,
  timeoutMs: number,
  onPoll?: () => Promise<void>,
): Promise<WorkerResponse> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requestPath = `/jobs/${jobId}`;
    const response = await fetch(
      `${workerUrl.replace(/\/$/, "")}${requestPath}`,
      {
        headers: {
          "x-onelight-signature": await hmacSha256Hex(
            workerSecret,
            requestPath,
          ),
        },
      },
    );
    if (!response.ok)
      throw new Error(`Worker status request failed with ${response.status}.`);
    const state = (await response.json()) as WorkerResponse;
    if (state.status === "complete" || state.status === "failed") return state;
    await onPoll?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
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
      metaJson: JSON.stringify({
        spec_hash: specHash,
        frame_rate_num: rate?.num ?? null,
        frame_rate_den: rate?.den ?? null,
      }),
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

const sweepWatermarkJobs = async (db: AppDb): Promise<void> => {
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
        existing.some(
          (rendition) => parseObject(rendition.metaJson).spec_hash === specHash,
        )
      )
        continue;
      const idempotencyKey = `watermark:${row.version.id}:${share.id}:${specHash}`;
      const pending = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, idempotencyKey))
        .limit(1)
        .all();
      if (pending.length) continue;
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
      await db
        .insert(jobs)
        .values({
          id: new UlidGenerator().ulid(),
          kind: "watermark",
          payloadJson: JSON.stringify({
            workspace_id: entry.workspaceId,
            project_id: share.projectId,
            version_id: row.version.id,
            share_id: share.id,
            spec: parseObject(share.watermarkSpecJson ?? "{}"),
            spec_hash: specHash,
            blob_key: proxy.blobKey,
            output_key: `renditions/${row.version.id}/watermarked-${share.id}-${specHash}.mp4`,
          }),
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

const processJob = async (
  db: AppDb,
  job: typeof jobs.$inferSelect,
  workerUrl: string,
  workerSecret: string,
  blobRoot: string,
  workerId: string,
): Promise<void> => {
  const payload = parsePayload(job.payloadJson);
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
      if (assetKind === "pdf") await enqueueTranscode(db, payload, versionId);
      return;
    }
    await sendJob(workerUrl, workerSecret, {
      job_id: job.id,
      kind: "probe",
      source_path: sourcePath,
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
    // A ";" separator in the probed timecode tag marks drop-frame.
    const dropFrame = timecode?.includes(";") ?? false;
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
        colorJson: JSON.stringify({ assumed: mediaInfo.colorAssumed === true }),
        transcodeStatus: "processing",
      })
      .where(eq(assetVersions.id, versionId))
      .run();
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
  const planned = planRenditions(assetKind, mediaInfo);
  if (!planned.length) {
    await db
      .update(assetVersions)
      .set({ transcodeStatus: "skipped" })
      .where(eq(assetVersions.id, version.id))
      .run();
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
  const failures = state.result.failures ?? [];
  for (const failure of failures)
    console.warn(
      `[onelight] rendition ${failure.kind} failed for version ${version.id}: ${failure.error}`,
    );
  for (const rendition of state.result.renditions) {
    const key = path.relative(blobRoot, rendition.key).replaceAll("\\", "/");
    const info = await stat(rendition.key);
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
    await db
      .insert(renditions)
      .values({
        id: new UlidGenerator().ulid(),
        versionId: version.id,
        kind: rendition.kind as typeof renditions.$inferInsert.kind,
        blobKey: key,
        metaJson: JSON.stringify(meta),
        size: info.size,
        checksumSha256: await sha256File(rendition.key),
        shareId: null,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }
  // Primary readiness is per asset kind: only a missing primary rendition
  // fails the job; secondary failures are reported above and do not.
  const produced = new Set(
    state.result.renditions.map((rendition) => rendition.kind),
  );
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
  const selected = rows.filter((row: ExportRow) => {
    const comment = row.comment;
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
  const markerRows = selected.filter((row) => row.comment.frameIn !== null);
  // Each version carries its own rational rate, start frame, and drop-frame
  // flag, so comments are grouped by version and serialized per group.
  interface ExportGroup {
    version?: typeof assetVersions.$inferSelect;
    markers: Array<{
      id: string;
      bodyText: string;
      authorName: string | null;
      frameIn: number;
      frameOut: number | null;
    }>;
  }
  const byVersion = new Map<string, ExportGroup>();
  for (const row of markerRows) {
    const entry: ExportGroup = byVersion.get(row.version.id) ?? {
      version: row.version,
      markers: [],
    };
    entry.markers.push({
      id: row.comment.id,
      bodyText: row.comment.bodyText,
      authorName: row.comment.authorName,
      frameIn: row.comment.frameIn as number,
      frameOut: row.comment.frameOut,
    });
    byVersion.set(row.version.id, entry);
  }
  const groupList: ExportGroup[] = byVersion.size
    ? [...byVersion.values()]
    : [{ markers: [] }];
  const optionsFor = (version: typeof assetVersions.$inferSelect | undefined) =>
    ({
      title: "Onelight Comments",
      rate: {
        num: version?.frameRateNum ?? 24,
        den: version?.frameRateDen ?? 1,
      },
      startFrame:
        job.timecodeBase === "source" ? (version?.sourceStartFrame ?? 0) : 0,
      dropFrame: Boolean(version?.dropFrame),
      timecodeBase: job.timecodeBase,
    }) as const;
  const serializeGroup = (group: (typeof groupList)[number]): string => {
    const options = optionsFor(group.version);
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
                : exportText(group.markers, options);
  };
  const output =
    job.format === "pdf"
      ? await buildPdfExport(db, job, blobRoot, media, rows, selected)
      : job.format === "json"
        ? JSON.stringify(
            groupList.flatMap(
              (group) =>
                JSON.parse(
                  exportJson(group.markers, optionsFor(group.version)),
                ) as unknown[],
            ),
            null,
            2,
          ) + "\n"
        : groupList.map(serializeGroup).join("\n");
  const directory = path.join(blobRoot, "exports");
  await mkdir(directory, { recursive: true });
  const extension =
    job.format === "pdf"
      ? "pdf"
      : job.format === "fcpxml"
        ? "xml"
        : job.format === "avid_xml" || job.format === "xmeml"
          ? "xml"
          : job.format === "csv"
            ? "csv"
            : job.format === "json"
              ? "json"
              : job.format === "resolve_edl"
                ? "edl"
                : "txt";
  const key = `exports/${job.id}.${extension}`;
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
  options: { workerUrl?: string; workerSecret?: string; blobRoot: string },
): (() => void) => {
  if (!options.workerUrl || !options.workerSecret) {
    console.warn(
      "[onelight] Media processing is disabled: WORKER_URL and WORKER_SECRET are not both set. Probe and transcode jobs will stay queued until a worker is configured.",
    );
    return () => undefined;
  }
  const workerId = new UlidGenerator().ulid();
  let active = false;
  let lastWatermarkSweep = 0;
  const tick = async () => {
    if (active) return;
    active = true;
    const now = Date.now();
    // Reconcile missing watermarked renditions on a throttle rather than
    // every poll; the sweep itself is bounded per pass.
    if (now - lastWatermarkSweep >= WATERMARK_SWEEP_INTERVAL_MS) {
      lastWatermarkSweep = now;
      try {
        await sweepWatermarkJobs(db);
      } catch (error) {
        console.warn(
          `[onelight] watermark sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const pendingExport = (
      await db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.status, "queued"))
        .orderBy(asc(exportJobs.createdAt))
        .limit(1)
        .all()
    )[0];
    if (pendingExport) {
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
          workerUrl: options.workerUrl,
          workerSecret: options.workerSecret,
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
    }
    const job = await claimNextJob(db, now, workerId, ["cpu"]);
    if (job) {
      try {
        await processJob(
          db,
          job,
          options.workerUrl as string,
          options.workerSecret as string,
          options.blobRoot,
          workerId,
        );
        await completeJob(db, job.id, workerId, Date.now());
      } catch (error) {
        await failJob(
          db,
          job.id,
          workerId,
          Date.now(),
          error instanceof Error ? error.message : "Worker job failed.",
          1000,
        );
      }
    }
    active = false;
  };
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  void tick();
  return () => clearInterval(timer);
};
