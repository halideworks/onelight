/* Which still formats this build can render, and how.

   One table, in core, because three places need the same answer: the API when
   it decides whether an upload is an image at all, the worker when it decides
   which decoder to open it with, and the review room when it decides whether
   1:1 zoom can point at the original file.

   Four decoders, in the order they are reached for:

     sharp (libvips)   jpg png tif webp gif avif
                       and the two things only it reads: EXIF orientation and
                       an ICC profile
     this process      psd psb, whose composite is read directly, because
                       ffmpeg refuses the large-document container outright
     libraw            the camera RAW families
     libheif           heic heif, which nothing else here opens
     ffmpeg            exr dpx, and psd if the direct read cannot make sense
                       of a particular file

   A format only belongs here if something in the image can actually decode
   it: an upload that lands as an "image" and then cannot be rendered is a
   card with no picture, which is worse than an honest file. */

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

/* Photoshop's two containers. PSD is version 1 and PSB ("large document
   format", past 30000 pixels a side) is version 2; ffmpeg reads the first and
   refuses the second, so both are read directly instead. */
export const PHOTOSHOP_STILL_EXTENSIONS = ["psd", "psb"] as const;

/* Camera RAW, through libraw. Every one of these is a different container
   around a mosaic, and none of them is a picture until something demosaics
   it; the list is what libraw's own tool handles and photographers actually
   hand over. */
export const RAW_STILL_EXTENSIONS = [
  "cr2",
  "cr3",
  "crw",
  "arw",
  "srf",
  "sr2",
  "nef",
  "nrw",
  "dng",
  "raf",
  "orf",
  "rw2",
  "raw",
  "pef",
  "srw",
  "erf",
  "mrw",
  "kdc",
  "dcr",
  "x3f",
  "3fr",
  "iiq",
  "mos",
] as const;

/* Apple's default since 2017, which means a phone shooting alongside a camera
   delivers these. libheif decodes them; nothing else here does. */
export const HEIF_STILL_EXTENSIONS = ["heic", "heif", "hif"] as const;

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

export const isPhotoshopStill = (filename: string): boolean =>
  (PHOTOSHOP_STILL_EXTENSIONS as readonly string[]).includes(
    stillExtensionOf(filename),
  );

export const isRawStill = (filename: string): boolean =>
  (RAW_STILL_EXTENSIONS as readonly string[]).includes(
    stillExtensionOf(filename),
  );

export const isHeifStill = (filename: string): boolean =>
  (HEIF_STILL_EXTENSIONS as readonly string[]).includes(
    stillExtensionOf(filename),
  );

export const isStillSource = (filename: string): boolean =>
  isSharpStill(filename) ||
  isFfmpegStill(filename) ||
  isPhotoshopStill(filename) ||
  isRawStill(filename) ||
  isHeifStill(filename);

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
