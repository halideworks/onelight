import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
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
import { planRenditions, primaryRenditionKinds } from "@onelight/worker";
import {
  assetVersions,
  assets,
  comments,
  exportJobs,
  jobs,
  renditions,
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

const pdfText = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replace(/[^\x20-\x7e]/g, "?");

const buildPdf = (
  rows: Array<{ timecode: string; author: string; body: string }>,
): Uint8Array => {
  const lines = rows.flatMap((row) => [
    `${row.timecode}  ${row.author}`,
    row.body,
    "",
  ]);
  const content = [
    "BT",
    "/F1 11 Tf",
    "50 760 Td",
    ...lines.map(
      (line, index) => `${index === 0 ? "" : "0 -16 Td "}(${pdfText(line)}) Tj`,
    ),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(chunks.join("").length);
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xref = chunks.join("").length;
  chunks.push(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
      .join(
        "\n",
      )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  return new TextEncoder().encode(chunks.join(""));
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

const waitForWorker = async (
  db: AppDb,
  workerUrl: string,
  workerSecret: string,
  jobId: string,
  workerId: string,
): Promise<WorkerResponse> => {
  const deadline = Date.now() + workerJobTimeoutMs();
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
    // Keep the job lease alive for the whole encode; transcodes routinely
    // run far longer than the 60 second lease.
    await heartbeatJob(db, jobId, workerId, Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Worker job exceeded WORKER_JOB_TIMEOUT_MS (${workerJobTimeoutMs()} ms).`,
  );
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

const processExportJob = async (
  db: AppDb,
  job: typeof exportJobs.$inferSelect,
  blobRoot: string,
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
  const selected = rows.filter(
    (row: {
      comment: typeof comments.$inferSelect;
      version: typeof assetVersions.$inferSelect;
      asset: typeof assets.$inferSelect;
    }) => {
      const comment = row.comment;
      if (filter.version_id && comment.versionId !== filter.version_id)
        return false;
      if (
        filter.author_user_id &&
        comment.authorUserId !== filter.author_user_id
      )
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
      return comment.frameIn !== null;
    },
  );
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
  for (const row of selected) {
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
  const rowsForPdf = groupList.flatMap((group) =>
    group.markers.map((marker) => ({
      timecode:
        exportText([marker], optionsFor(group.version)).trim().split(" ")[0] ??
        "00:00:00:00",
      author: marker.authorName ?? "Comment",
      body: marker.bodyText,
    })),
  );
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
      ? buildPdf(rowsForPdf)
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
  const tick = async () => {
    if (active) return;
    active = true;
    const now = Date.now();
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
        await processExportJob(db, pendingExport, options.blobRoot);
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
