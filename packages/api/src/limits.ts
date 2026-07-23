export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 ** 3;
export const TEBIBYTE = 1024 ** 4;

/** One source object may be large enough for feature-length camera masters. */
export const MAX_UPLOAD_BYTES = 128 * GIBIBYTE;
export const MAX_MULTIPART_PARTS = 8192;
export const MAX_MULTIPART_PART_BYTES = 5 * GIBIBYTE;

/** File requests are finite even when their creator leaves the cap blank. */
export const DEFAULT_TRANSFER_REQUEST_BYTE_CAP = TEBIBYTE;
export const MAX_TRANSFER_REQUEST_BYTE_CAP = 10 * TEBIBYTE;

export const MAX_COMMENT_ATTACHMENT_BYTES = 25 * MEBIBYTE;
export const MAX_COMMENT_ATTACHMENTS = 10;
export const MAX_COMMENT_ATTACHMENT_TOTAL_BYTES = 100 * MEBIBYTE;

/** Presence timestamps are activity hints, not per-request audit records. */
export const PRESENCE_WRITE_INTERVAL_MS = 5 * 60 * 1000;
