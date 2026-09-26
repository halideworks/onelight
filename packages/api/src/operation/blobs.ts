import { parseJsonObject } from "../helpers.js";
import type { projects } from "@onelight/db/schema";
import {
  assets,
  assetVersions,
  renditions,
  commentAttachments,
  comments,
  captionTracks,
  projectCoverUploads,
  exportJobs,
  shares,
} from "@onelight/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import type { MultipartBlobStore, ZipEntry } from "@onelight/core";
import { errors, sha256Hex, zipLength, zipStreamFrom } from "@onelight/core";
import type { Context } from "hono";
import type { Variables, AppEnv } from "../types.js";

export const createBlobs = (env: AppEnv) => {
  /* Best-effort blob delete: the row is the truth, and a blob that outlives it
     is the GC's problem, so a store error never fails the request. One helper
     so the nine delete sites cannot drift into nine spellings (one of which had
     no catch at all and would 500 the request on a store hiccup). */
  const deleteBlobQuietly = async (
    key: string | null | undefined,
  ): Promise<void> => {
    if (!key || !env.blobStore) return;
    await env.blobStore.delete(key).catch(() => undefined);
  };

  /* pdf_pages registers its first page as blob_key and lists the rest of the
     page basenames in meta.pages, relative to the blob_key's directory. Mirror
     of maintenance.ts renditionBlobKeys so the two never disagree on what a
     rendition owns. */
  const renditionOwnedKeys = (blobKey: string, metaJson: string): string[] => {
    const keys = [blobKey];
    const meta = parseJsonObject(metaJson);
    if (typeof meta.vtt_blob_key === "string") keys.push(meta.vtt_blob_key);
    if (Array.isArray(meta.pages)) {
      const normalized = blobKey.replaceAll("\\", "/");
      const directory = normalized.slice(0, normalized.lastIndexOf("/"));
      for (const page of meta.pages)
        if (typeof page === "string") keys.push(`${directory}/${page}`);
    }
    return keys;
  };

  /* Every blob key a project owns, so deleting the project can free them
     inline instead of stranding gigabytes on disk until a GC that is off by
     default eventually reconciles. Batched by project rather than per-version.
     A completeness test seeds one blob per column and asserts this returns them
     all -- the guard against the missing-column class that has bitten the GC. */
  const collectProjectBlobKeys = async (
    project: typeof projects.$inferSelect,
  ): Promise<string[]> => {
    const keys = new Set<string>();
    const add = (key: string | null | undefined): void => {
      if (key) keys.add(key);
    };
    const inProject = eq(assets.projectId, project.id);
    for (const row of await env.db
      .select({ key: assetVersions.originalBlobKey })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ blobKey: renditions.blobKey, metaJson: renditions.metaJson })
      .from(renditions)
      .innerJoin(assetVersions, eq(renditions.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      for (const key of renditionOwnedKeys(row.blobKey, row.metaJson)) add(key);
    for (const row of await env.db
      .select({ key: commentAttachments.blobKey })
      .from(commentAttachments)
      .innerJoin(comments, eq(commentAttachments.commentId, comments.id))
      .innerJoin(assetVersions, eq(comments.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ key: captionTracks.blobKey })
      .from(captionTracks)
      .innerJoin(assetVersions, eq(captionTracks.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(inProject)
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ key: assets.thumbnailBlobKey })
      .from(assets)
      .where(and(inProject, isNotNull(assets.thumbnailBlobKey)))
      .all())
      add(row.key);
    add(project.coverBlobKey);
    for (const row of await env.db
      .select({ key: projectCoverUploads.blobKey })
      .from(projectCoverUploads)
      .where(eq(projectCoverUploads.projectId, project.id))
      .all())
      add(row.key);
    for (const row of await env.db
      .select({ resultBlobKey: exportJobs.resultBlobKey })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.projectId, project.id),
          isNotNull(exportJobs.resultBlobKey),
        ),
      )
      .all())
      add(row.resultBlobKey);
    for (const row of await env.db
      .select({ brandJson: shares.brandJson })
      .from(shares)
      .where(and(eq(shares.projectId, project.id), isNotNull(shares.brandJson)))
      .all()) {
      if (!row.brandJson) continue;
      try {
        const brand = JSON.parse(row.brandJson) as { logo_key?: unknown };
        if (typeof brand.logo_key === "string") add(brand.logo_key);
      } catch {
        /* A malformed brand blob names no logo. */
      }
    }
    return [...keys];
  };

  const deleteProjectBlobs = async (
    project: typeof projects.$inferSelect,
  ): Promise<void> => {
    for (const key of await collectProjectBlobKeys(project))
      await deleteBlobQuietly(key);
  };

  const requireBlobStore = (): MultipartBlobStore => {
    const store = env.blobStore as MultipartBlobStore | undefined;
    if (!store || typeof store.putPart !== "function")
      throw errors.internal("Blob storage is not configured.");
    return store;
  };

  const attachmentDisposition = (filename: string): string =>
    `attachment; filename="${filename.replace(/[\r\n"]/g, "")}"`;

  // The disposition value comes from a verified JWT claim only, but it is
  // sanitized again before reaching the header: CR/LF and control characters
  // are stripped and the value must match the shape we issue, with quotes
  // forbidden inside the filename.
  const sanitizeDisposition = (value: string): string | undefined => {
    const cleaned = value.replace(/[^\t\x20-\x7e]/g, "");
    const match = /^(attachment|inline)(?:; filename="([^"\\]*)")?$/.exec(
      cleaned,
    );
    if (!match) return undefined;
    return match[2] !== undefined
      ? `${match[1]}; filename="${match[2]}"`
      : match[1];
  };

  /* These must match what the worker actually writes. The sidecars are PNG
     (media.ts writes poster.png, sprite.png, audio_peaks.png) and were served
     as image/jpeg, and audio_peaks was not listed at all -- so the waveform
     fell through to application/octet-stream, which no browser will render. */
  const renditionKindContentTypes: Record<string, string> = {
    proxy_2160: "video/mp4",
    proxy_1080: "video/mp4",
    proxy_540: "video/mp4",
    hdr_hevc: "video/mp4",
    hdr_av1: "video/mp4",
    watermarked: "video/mp4",
    proxy_audio: "audio/mp4",
    reference_audio_1x: "audio/mp4",
    shuttle_audio_2x: "audio/mp4",
    shuttle_audio_4x: "audio/mp4",
    poster: "image/png",
    sprite: "image/png",
    audio_peaks: "image/png",
    spectrogram: "image/png",
    still_tiles: "image/png",
    /* The stills ladder writes its own content_type into the rendition meta,
       which wins over this table; these are the fallbacks for a row written
       before that meta existed. */
    still_review: "image/webp",
    still_full: "image/webp",
    /* Peak data is a binary sidecar the player fetches and parses, not
       anything a browser renders on its own. */
    waveform_data: "application/octet-stream",
  };

  /* Last resort before application/octet-stream: the key's own extension. A
     rendition kind added to the worker but forgotten above should still serve
     as something a browser can display, rather than silently download. */
  const extensionContentTypes: Record<string, string> = {
    mp4: "video/mp4",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    pdf: "application/pdf",
    vtt: "text/vtt",
  };

  const blobContentType = async (key: string): Promise<string> => {
    const attachment = (
      await env.db
        .select({ contentType: commentAttachments.contentType })
        .from(commentAttachments)
        .where(eq(commentAttachments.blobKey, key))
        .limit(1)
        .all()
    )[0];
    if (attachment?.contentType) return attachment.contentType;
    const rendition = (
      await env.db
        .select({ kind: renditions.kind, metaJson: renditions.metaJson })
        .from(renditions)
        .where(eq(renditions.blobKey, key))
        .limit(1)
        .all()
    )[0];
    if (rendition) {
      const meta = parseJsonObject(rendition.metaJson);
      if (typeof meta.content_type === "string") return meta.content_type;
      const mapped = renditionKindContentTypes[rendition.kind];
      if (mapped) return mapped;
    }
    const extension = key.split(".").pop()?.toLowerCase();
    return (
      (extension ? extensionContentTypes[extension] : undefined) ??
      "application/octet-stream"
    );
  };

  const parseRangeHeader = (
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

  const serveBlob = async (
    c: Context<{ Variables: Variables }>,
    key: string,
    disposition?: string,
  ) => {
    const store = env.blobStore;
    if (!store) throw errors.internal("Blob storage is not configured.");
    c.header("accept-ranges", "bytes");
    c.header("content-type", await blobContentType(key));
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "private, no-store");
    c.header("content-security-policy", "default-src 'none'; sandbox");
    if (disposition) c.header("content-disposition", disposition);
    /* Blobs are immutable per key, so the key is a permanent strong
       validator. Without an ETag, browsers restart an interrupted download
       from zero instead of asking for the remaining bytes. */
    const etag = `"b${(await sha256Hex(key)).slice(0, 24)}"`;
    c.header("etag", etag);
    let size: number | undefined;
    if (typeof store.head === "function") {
      try {
        size = (await store.head(key)).size;
      } catch {
        throw errors.notFound("Media was not found.");
      }
    }
    const rangeHeader = c.req.header("range");
    const ifRange = c.req.header("if-range");
    if (
      rangeHeader !== undefined &&
      size !== undefined &&
      (ifRange === undefined || ifRange === etag)
    ) {
      const range = parseRangeHeader(rangeHeader, size);
      if (range === "unsatisfiable") {
        c.header("content-range", `bytes */${size}`);
        return c.body(null, 416);
      }
      if (range) {
        c.header("content-range", `bytes ${range.start}-${range.end}/${size}`);
        c.header("content-length", String(range.end - range.start + 1));
        return c.body(
          await store.getStream(key, { start: range.start, end: range.end }),
          206,
        );
      }
    }
    if (size !== undefined) c.header("content-length", String(size));
    return c.body(await store.getStream(key), 200);
  };

  /* CRCs computed while a zip streams, remembered for resumes: with them a
     Range request skips straight to the interrupted byte instead of
     re-reading every entry to rebuild the central directory's checksums.
     Keyed by blob key, which is immutable, and bluntly reset when large. */
  const zipCrcCache = new Map<string, number>();

  const rememberZipCrc = (key: string, crc: number): void => {
    if (zipCrcCache.size >= 100_000) zipCrcCache.clear();
    zipCrcCache.set(key, crc);
  };

  const truncateTo = (
    stream: ReadableStream<Uint8Array>,
    limit: number,
  ): ReadableStream<Uint8Array> => {
    const reader = stream.getReader();
    let remaining = limit;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (remaining <= 0) {
          controller.close();
          await reader.cancel();
          return;
        }
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        if (next.value.length <= remaining) {
          remaining -= next.value.length;
          controller.enqueue(next.value);
        } else {
          controller.enqueue(next.value.subarray(0, remaining));
          remaining = 0;
          await reader.cancel();
          controller.close();
        }
      },
      async cancel() {
        await reader.cancel();
      },
    });
  };

  /* The deterministic layout gives the archive an exact length and a stable
     identity before a byte is written, so a hundreds-of-GB zip serves with
     a real Content-Length, an ETag, and honest 206 resumes. */
  const serveZip = async (
    c: Context<{ Variables: Variables }>,
    entries: ZipEntry[],
    zipName: string,
  ): Promise<Response> => {
    const total = zipLength(entries);
    const identity = entries
      .map((entry) => `${entry.cacheKey ?? entry.name}:${entry.size}`)
      .join("|");
    const etag = `"z${(await sha256Hex(identity)).slice(0, 24)}"`;
    const base: Record<string, string> = {
      "content-type": "application/zip",
      "content-disposition": attachmentDisposition(zipName),
      "accept-ranges": "bytes",
      etag,
    };
    const rangeHeader = c.req.header("range");
    const ifRange = c.req.header("if-range");
    if (rangeHeader && (ifRange === undefined || ifRange === etag)) {
      const range = parseRangeHeader(rangeHeader, total);
      if (range === "unsatisfiable")
        return new Response(null, {
          status: 416,
          headers: { ...base, "content-range": `bytes */${total}` },
        });
      if (range) {
        const length = range.end - range.start + 1;
        let stream = zipStreamFrom(entries, range.start, {
          crcs: zipCrcCache,
          onCrc: rememberZipCrc,
        });
        if (range.end < total - 1) stream = truncateTo(stream, length);
        return new Response(stream, {
          status: 206,
          headers: {
            ...base,
            "content-range": `bytes ${range.start}-${range.end}/${total}`,
            "content-length": String(length),
          },
        });
      }
    }
    /* The full build also runs through the resume path so it warms the CRC
       cache; from byte zero the two are the same stream. */
    return new Response(
      zipStreamFrom(entries, 0, { crcs: zipCrcCache, onCrc: rememberZipCrc }),
      { headers: { ...base, "content-length": String(total) } },
    );
  };

  return {
    deleteBlobQuietly,
    deleteProjectBlobs,
    requireBlobStore,
    attachmentDisposition,
    sanitizeDisposition,
    blobContentType,
    serveBlob,
    serveZip,
  };
};

export type Blobs = ReturnType<typeof createBlobs>;
