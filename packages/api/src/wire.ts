import {
  encodeCursor,
  parseJsonValue,
  parseJsonObject,
  extractHashtags,
} from "./helpers.js";
import type {
  uploadSessions,
  assets,
  assetVersions,
  jobs,
  exportJobs,
  comments,
  commentAttachments,
  shares,
  shareViewers,
} from "@onelight/db/schema";
import type { ActorUser } from "./types.js";

/* Take the requested page, project rows to the wire, and return a cursor only
   when the limit + 1 query found another row. */
export const pageResult = <T extends { id: string }, W>(
  rows: T[],
  limit: number,
  map: (row: T) => W,
): { items: W[]; next_cursor: string | null } => {
  const page = rows.slice(0, limit);
  return {
    items: page.map(map),
    next_cursor:
      rows.length > limit
        ? encodeCursor(page[page.length - 1]?.id ?? "")
        : null,
  };
};

export const userWire = (user: ActorUser) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.guest ? "guest" : user.role,
  /* Same-origin path, cookie-authenticated like every app read; updatedAt
     busts the cache when the picture changes. Null means the generated
     avatar. */
  avatar_url: user.avatarKey
    ? `/api/v1/users/${user.id}/avatar?v=${String(user.updatedAt)}`
    : null,
  disabled_at: user.disabledAt,
  created_at: user.createdAt,
  totp_enabled: Boolean(user.totpVerifiedAt),
});

export const uploadWire = (upload: typeof uploadSessions.$inferSelect) => ({
  id: upload.id,
  project_id: upload.projectId,
  client_filename: upload.clientFilename,
  relative_path: upload.relativePath,
  size: upload.size,
  checksum_crc32c: upload.checksumCrc32c,
  status: upload.status,
  created_at: upload.createdAt,
  completed_at: upload.completedAt,
});

export const assetWire = (asset: typeof assets.$inferSelect) => ({
  id: asset.id,
  public_id: asset.publicId ?? asset.id,
  project_id: asset.projectId,
  folder_id: asset.folderId,
  name: asset.name,
  kind: asset.kind,
  current_version_id: asset.currentVersionId,
  status: asset.status,
  description: asset.description,
  tags: Array.isArray(parseJsonValue(asset.tagsJson))
    ? parseJsonValue(asset.tagsJson)
    : [],
  /* Whether a picture was chosen for this asset. The client builds
     /assets/:id/thumbnail?v=updated_at from it; no signed URL is needed
     because every internal surface that shows it is already authenticated. */
  has_thumbnail: Boolean(asset.thumbnailBlobKey),
  /* The photographer's shortlist, distinct from the client's approval. */
  selected: asset.selectedAt !== null,
  selected_at: asset.selectedAt,
  /* The editor's reference-render transfer override, or null for auto. The
     client resolves the effective transfer from this plus the source color
     tag; viewers receive it read-only. */
  display_transfer: asset.displayTransfer ?? null,
  deleted_at: asset.deletedAt,
  created_at: asset.createdAt,
  updated_at: asset.updatedAt,
});

export const versionWire = (version: typeof assetVersions.$inferSelect) => ({
  id: version.id,
  asset_id: version.assetId,
  version_no: version.versionNo,
  original_filename: version.originalFilename,
  size: version.size,
  checksum_crc32c: version.checksumCrc32c,
  uploaded_by: version.uploadedBy,
  media_info: parseJsonObject(version.mediaInfoJson),
  source_timecode_start: version.sourceTimecodeStart,
  source_start_frame: version.sourceStartFrame,
  frame_rate_num: version.frameRateNum,
  frame_rate_den: version.frameRateDen,
  drop_frame: Boolean(version.dropFrame),
  duration_frames: version.durationFrames,
  color: parseJsonObject(version.colorJson),
  transcode_status: version.transcodeStatus,
  created_at: version.createdAt,
});

/* The same shape as versionWire, but stripped of the two heavy JSON blobs a
   browsing card never reads. A card's Format cell needs only the video
   stream's codec and dimensions, so media_info collapses to that one stream
   summary; the full ffprobe output (every stream, format tags, bitrates --
   multiple KB per asset) and the colour-grading metadata stay in the review
   room's own version fetch. Field names and types are unchanged, so the wire
   contract and the client type are untouched. */
export const listCardVersion = (version: typeof assetVersions.$inferSelect) => {
  const full = versionWire(version);
  const info = full.media_info;
  const streams = Array.isArray(info.streams)
    ? (info.streams as Array<Record<string, unknown>>)
    : [];
  const video =
    streams.find((stream) => stream.codec_type === "video") ?? streams[0];
  return {
    ...full,
    media_info: video
      ? {
          streams: [
            {
              codec_type: video.codec_type,
              codec_name: video.codec_name,
              width: video.width,
              height: video.height,
            },
          ],
        }
      : {},
    color: {},
  };
};

export const jobWire = (job: typeof jobs.$inferSelect) => {
  const payload = parseJsonObject(job.payloadJson);
  const summary: Record<string, unknown> = {};
  for (const key of ["workspace_id", "project_id", "asset_id", "version_id"]) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    run_after: job.runAfter,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    error: job.error,
    payload: summary,
  };
};

export const exportWire = (job: typeof exportJobs.$inferSelect) => ({
  id: job.id,
  project_id: job.projectId,
  format: job.format,
  filters: parseJsonObject(job.filtersJson),
  timecode_base: job.timecodeBase,
  status: job.status,
  error: job.error,
  created_at: job.createdAt,
  finished_at: job.finishedAt,
  requested_by: job.requestedBy,
});

export const commentWire = (comment: typeof comments.$inferSelect) => ({
  id: comment.id,
  version_id: comment.versionId,
  parent_id: comment.parentId,
  author_user_id: comment.authorUserId,
  author_name: comment.authorName,
  author_email: comment.authorEmail,
  author_avatar_url: comment.authorUserId
    ? `/api/v1/users/${comment.authorUserId}/avatar`
    : null,
  frame_in: comment.frameIn,
  frame_out: comment.frameOut,
  body_text: comment.bodyText,
  annotation: comment.annotationJson
    ? parseJsonObject(comment.annotationJson)
    : null,
  pin_xy: comment.pinXyJson ? parseJsonObject(comment.pinXyJson) : null,
  page_no: comment.pageNo,
  internal: Boolean(comment.internal),
  completed_at: comment.completedAt,
  completed_by: comment.completedBy,
  carried_from_comment_id: comment.carriedFromCommentId,
  deleted_at: comment.deletedAt,
  created_at: comment.createdAt,
  edited_at: comment.editedAt,
  // Derived from body_text on every read, never a column.
  tags: extractHashtags(comment.bodyText),
});

/* A comment's files, in bulk: one query for a whole thread, so listing
   comments never costs a query per row. */
export const attachmentWire = (
  row: typeof commentAttachments.$inferSelect,
) => ({
  id: row.id,
  filename: row.filename,
  size: row.size,
  content_type: row.contentType,
});

// Public (share viewer) projection of a comment: drops author_email and
// author_user_id so external viewers never learn the registered identity
// behind a comment. author_name is the only author field exposed.
export const publicCommentWire = (
  comment: typeof comments.$inferSelect,
  shareSlug: string,
) => {
  const wire: Record<string, unknown> = {
    ...commentWire(comment),
    author_avatar_url: comment.authorUserId
      ? `/api/v1/s/${shareSlug}/comments/${comment.id}/avatar`
      : null,
  };
  delete wire.author_user_id;
  delete wire.author_email;
  return wire;
};

export const shareLogoUrl = (
  share: typeof shares.$inferSelect,
): string | null => {
  const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
  return typeof brand.logo_key === "string"
    ? `/api/v1/s/${share.slug}/logo?v=${encodeURIComponent(brand.logo_key.split("/").pop() ?? "")}`
    : null;
};

/* The brand as clients of the wire read it: the logo travels as a URL,
   never as a blob key. */
export const brandWire = (
  share: typeof shares.$inferSelect,
): Record<string, unknown> | null => {
  if (!share.brandJson) return null;
  const brand = parseJsonObject(share.brandJson);
  delete brand.logo_key;
  return Object.keys(brand).length ? brand : null;
};

export const shareWire = (share: typeof shares.$inferSelect) => ({
  id: share.id,
  public_id: share.publicId ?? share.id,
  project_id: share.projectId,
  folder_id: share.folderId,
  slug: share.slug,
  kind: share.kind,
  title: share.title,
  layout: share.layout,
  expires_at: share.expiresAt,
  /* Whether it has one, never what it is. The room needs this to warn that a
     password is deliberately not in the email it just sent. */
  has_passphrase: share.passphraseHash !== null,
  allow_download: share.allowDownload,
  allow_comments: Boolean(share.allowComments),
  allow_approvals: Boolean(share.allowApprovals),
  show_all_versions: Boolean(share.showAllVersions),
  watermark_spec: share.watermarkSpecJson
    ? parseJsonObject(share.watermarkSpecJson)
    : null,
  brand: brandWire(share),
  logo_url: shareLogoUrl(share),
  created_by: share.createdBy,
  revoked_at: share.revokedAt,
  created_at: share.createdAt,
});

// Client-safe share projection for public (unauthenticated) share pages.
// Unlike shareWire it never exposes passphrase_hash, watermark_spec_hash,
// the full watermark spec, created_by, project_id, or camelCase drizzle
// keys: watermarking is reported only as a boolean presence flag.
export const publicShareWire = (share: typeof shares.$inferSelect) => ({
  id: share.id,
  slug: share.slug,
  kind: share.kind,
  title: share.title,
  layout: share.layout,
  allow_download: share.allowDownload,
  allow_comments: Boolean(share.allowComments),
  allow_approvals: Boolean(share.allowApprovals),
  show_all_versions: Boolean(share.showAllVersions),
  expires_at: share.expiresAt,
  revoked_at: share.revokedAt,
  watermark: shareIsWatermarked(share),
  brand: brandWire(share),
  logo_url: shareLogoUrl(share),
});

// Share viewers expose only their display identity; the signed viewer_key
// never leaves the server.
export const publicViewerWire = (viewer: typeof shareViewers.$inferSelect) => ({
  id: viewer.id,
  name: viewer.name,
  email: viewer.email,
});

export const shareIsWatermarked = (
  share: typeof shares.$inferSelect,
): boolean => Boolean(share.watermarkSpecJson && share.watermarkSpecHash);
