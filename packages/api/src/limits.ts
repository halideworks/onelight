export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 ** 3;
export const TEBIBYTE = 1024 ** 4;

/** One source object may be large enough for feature-length camera masters. */
export const MAX_UPLOAD_BYTES = 128 * GIBIBYTE;
export const MAX_MULTIPART_PARTS = 8192;
export const MAX_MULTIPART_PART_BYTES = 5 * GIBIBYTE;

/* A small file does not need six round trips.

   The multipart dance (create, initialize, list, put, complete, attach) is
   what a camera master needs and what a JPEG does not: at a few thousand
   files the round trips cost more than the bytes. Anything at or under this
   goes up whole, in one request that also lands the asset. The ceiling is a
   deliberate compromise: large enough for a raw stills delivery, small enough
   that a failure costs one retry of a few seconds. */
export const MAX_DIRECT_UPLOAD_BYTES = 64 * MEBIBYTE;

/* How many uploads one batch attach may land. The work per asset is a handful
   of row writes, so the bound is about keeping one request's transaction and
   its response honest rather than about the total: a client with 3000 files
   sends six of these. */
export const MAX_ATTACH_BATCH = 500;

/** File requests are finite even when their creator leaves the cap blank. */
export const DEFAULT_TRANSFER_REQUEST_BYTE_CAP = TEBIBYTE;
export const MAX_TRANSFER_REQUEST_BYTE_CAP = 10 * TEBIBYTE;

export const MAX_COMMENT_ATTACHMENT_BYTES = 25 * MEBIBYTE;
export const MAX_COMMENT_ATTACHMENTS = 10;
export const MAX_COMMENT_ATTACHMENT_TOTAL_BYTES = 100 * MEBIBYTE;

/** Presence timestamps are activity hints, not per-request audit records. */
export const PRESENCE_WRITE_INTERVAL_MS = 5 * 60 * 1000;
