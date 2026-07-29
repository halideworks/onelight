/* Which still formats this build can render, and how.

   One table, in core, because three places need the same answer: the API when
   it decides whether an upload is an image at all, the worker when it decides
   which decoder to open it with, and the review room when it decides whether
   1:1 zoom can point at the original file.

   sharp (libvips) opens the first group directly and reads the two things a
   photograph carries that ffmpeg cannot: EXIF orientation and an ICC profile.
   ffmpeg decodes the second group, which libvips as we ship it cannot open at
   all. RAW and HEIC are in neither: this image carries no decoder for them, so
   they stay plain files until one is added. */

export const SHARP_STILL_EXTENSIONS = [
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "png",
  "tif",
  "tiff",
  "webp",
  "gif",
  "avif",
] as const;

export const FFMPEG_STILL_EXTENSIONS = ["psd", "exr", "dpx"] as const;

/* Formats a browser decodes on its own, so 1:1 zoom can point at the original
   file instead of a rendition. A TIFF or a PSD is not among them, which is the
   whole reason the full-size rung exists. */
export const BROWSER_STILL_EXTENSIONS = [
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "png",
  "webp",
  "gif",
  "avif",
] as const;

export const stillExtensionOf = (filename: string): string =>
  filename.toLowerCase().split(".").pop() ?? "";

export const isSharpStill = (filename: string): boolean =>
  (SHARP_STILL_EXTENSIONS as readonly string[]).includes(
    stillExtensionOf(filename),
  );

export const isFfmpegStill = (filename: string): boolean =>
  (FFMPEG_STILL_EXTENSIONS as readonly string[]).includes(
    stillExtensionOf(filename),
  );

export const isStillSource = (filename: string): boolean =>
  isSharpStill(filename) || isFfmpegStill(filename);

/** Whether a browser can open this file directly, which decides whether 1:1
    zoom needs a rendition at all. */
export const isBrowserStill = (filename: string): boolean =>
  (BROWSER_STILL_EXTENSIONS as readonly string[]).includes(
    stillExtensionOf(filename),
  );

/** Whether this source needs a full-size rendition for 1:1 zoom, or whether
    the original serves. */
export const needsStillFull = (filename: string): boolean =>
  isStillSource(filename) && !isBrowserStill(filename);
