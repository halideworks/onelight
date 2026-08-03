import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  exportAvidText,
  exportAvidXml,
  exportCsv,
  exportFcpXml,
  exportJson,
  exportResolveEdl,
  exportText,
  exportXmeml,
  UlidGenerator,
  zipStream,
} from "@onelight/core";
import {
  buildPdfReport,
  compositeAnnotation,
  parseAnnotationStrokes,
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
} from "@onelight/db/schema";
import type { AppDb } from "@onelight/db";
import { parseObject } from "@onelight/job-protocol";
import type { JobPayload } from "@onelight/job-protocol";

/* A comment report, and the marker files an edit suite reads.
 *
 * Split out of the pump because this is the only part of it that still needs a
 * filesystem: a PDF is assembled from stills the workers wrote to the blob
 * root, and the finished document is written back there as a file. The job
 * protocol beside it names storage and nothing else, which is what lets it be
 * mounted on a deployment that has no disk to speak of.
 *
 * The pump still drives all of this: it owns the single export slot and the
 * reclaim pass, and calls in here for the work itself. */

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

const chunked = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    groups.push(items.slice(index, index + size));
  return groups;
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
export const EXPORT_RECLAIM_STALE_MS = 30 * 60_000;

export const reclaimStuckExports = async (
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

export const processExportJob = async (
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
