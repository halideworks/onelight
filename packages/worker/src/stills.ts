/* The stills instrument: what a photograph becomes when it lands.

   A still is not a one-frame video and ffmpeg is the wrong tool for it. Two
   things a photograph carries that ffmpeg cannot read at all decide the engine
   here: EXIF orientation (a portrait frame off any phone or camera is stored
   landscape with a rotation tag, and ignoring it hangs every picture sideways)
   and an ICC profile (an Adobe RGB or ProPhoto delivery rendered as though it
   were sRGB is visibly desaturated, which is the one thing a review tool may
   never do to a picture). libvips reads both, so sharp renders the ladder.

   ffmpeg still has one job. libvips as we ship it has no magick loader, so it
   cannot open a PSD, an EXR or a DPX; ffmpeg decodes all three. Those sources
   are decoded to an intermediate PNG first and rendered from there. Measured
   on this machine: ffmpeg PSD to PNG is about 120 ms for a 1200x800 frame,
   which is cheap next to the encode that follows.

   The ladder is deliberately short. Every rung costs time 3000 times over.

     poster        640 long edge, JPEG   the grid tile, the card, the unfurl
     still_review  2048 long edge, WebP  the file the review room opens
     still_full    native, WebP          1:1 zoom, and ONLY when the source is
                                         not something a browser can decode

   still_full is not made at ingest. On a 24 MP source it costs seconds and
   megabytes, and for a JPEG or a PNG it is pointless: the browser can zoom the
   original. It is rendered on demand, once, for the formats a browser cannot
   open (TIFF, PSD, EXR, DPX), and cached as a rendition from then on. */

import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./run-process.js";

/* Loaded lazily for the same reason annotation-svg.ts does it: importing
   @onelight/worker must not fail on a machine without sharp prebuilds (the
   server imports this package for the recipe builders alone). */
const loadSharp = async () => (await import("sharp")).default;

export type StillRungKind = "poster" | "still_review" | "still_full";

export interface StillRung {
  kind: StillRungKind;
  /** Longest edge in pixels; 0 means the source's own size. */
  longEdge: number;
  filename: string;
  contentType: string;
}

/* q82 mozjpeg for the poster because it is the compatibility surface: link
   unfurls, mail clients and anything else that will not be told what WebP is.
   q82 WebP with smart subsampling for the review still because chroma is what
   a retoucher is looking at, and 4:2:0 on a 2048 still is visible damage;
   measured at 87 KB against 411 KB for the equivalent 4:4:4 JPEG. */
export const STILL_LADDER: StillRung[] = [
  {
    kind: "poster",
    longEdge: 640,
    filename: "poster.jpg",
    contentType: "image/jpeg",
  },
  {
    kind: "still_review",
    longEdge: 2048,
    filename: "still_review.webp",
    contentType: "image/webp",
  },
];

export const STILL_FULL_RUNG: StillRung = {
  kind: "still_full",
  longEdge: 0,
  filename: "still_full.webp",
  contentType: "image/webp",
};

/** A ceiling on the on-demand full-size rung, so a 200 MP scan cannot ask the
    browser for a texture no browser will allocate. */
export const STILL_FULL_MAX_EDGE = 8192;

/* Extensions sharp opens directly. Everything else that is still pictorial
   goes through ffmpeg first. Kept as data because it is the table an operator
   reads when asking "why did my .psb not work". */
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
   whole reason still_full exists. */
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

const extensionOf = (filename: string): string =>
  filename.toLowerCase().split(".").pop() ?? "";

export const isSharpStill = (filename: string): boolean =>
  (SHARP_STILL_EXTENSIONS as readonly string[]).includes(extensionOf(filename));

export const isFfmpegStill = (filename: string): boolean =>
  (FFMPEG_STILL_EXTENSIONS as readonly string[]).includes(
    extensionOf(filename),
  );

export const isStillSource = (filename: string): boolean =>
  isSharpStill(filename) || isFfmpegStill(filename);

/** Whether a browser can open this file directly, which decides whether the
    1:1 zoom needs a still_full rendition at all. */
export const isBrowserStill = (filename: string): boolean =>
  (BROWSER_STILL_EXTENSIONS as readonly string[]).includes(
    extensionOf(filename),
  );

export interface StillRenderResult {
  width: number;
  height: number;
  content_type: string;
  /** The source's own pixel dimensions after orientation is applied. */
  source_width: number;
  source_height: number;
  /** Description of the source's ICC profile, when it carried one. Recorded
      rather than acted on: the rendition is sRGB either way, and a viewer that
      wants to know what it was converted from can be told. */
  source_profile?: string | undefined;
  /** True when the source declared an EXIF rotation that was applied. */
  rotated?: boolean | undefined;
}

const fileExists = async (file: string): Promise<boolean> => {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

/* PSD, EXR and DPX to an intermediate PNG. rgb48be keeps a 16 bit source at 16
   bits through the handoff; sharp reduces once, at the end, instead of twice.
   PSD in particular reaches us as CMYK often enough to matter, and ffmpeg's
   own conversion is the only one available for it. */
export const buildStillDecodeArgs = (
  source: string,
  outputPath: string,
): string[] => [
  "-hide_banner",
  "-y",
  "-i",
  source,
  "-frames:v",
  "1",
  "-pix_fmt",
  "rgb48be",
  outputPath,
];

/** Decodes a source sharp cannot open into a PNG beside it, returning the path
    to render from. Callers clean up via the returned `cleanup`. */
const openable = async (
  source: string,
  workDirectory: string,
  ffmpeg: string,
): Promise<{ file: string; cleanup: () => Promise<void> }> => {
  if (!isFfmpegStill(source)) return { file: source, cleanup: async () => {} };
  await mkdir(workDirectory, { recursive: true });
  const decoded = path.join(
    workDirectory,
    `.decode-${path.basename(source)}.png`,
  );
  await runProcess(ffmpeg, buildStillDecodeArgs(source, decoded));
  if (!(await fileExists(decoded)))
    throw new Error(`ffmpeg decoded no image from ${path.basename(source)}.`);
  return {
    file: decoded,
    cleanup: async () => {
      await rm(decoded, { force: true }).catch(() => undefined);
    },
  };
};

/* Every rung is written to a temp name and renamed on success, the same
   contract runTranscode keeps for encodes: a crash never leaves a truncated
   file sitting at a final path where the next run would reuse it. */
export const renderStillRung = async (
  source: string,
  outputPath: string,
  rung: StillRung,
  options: { ffmpeg?: string; maxEdge?: number } = {},
): Promise<StillRenderResult> => {
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const sharp = await loadSharp();
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const opened = await openable(source, directory, ffmpeg);
  const temporary = path.join(directory, `.tmp-${path.basename(outputPath)}`);
  try {
    /* failOn "none" so a truncated JPEG with a good first two thirds still
       produces a picture; a reviewer being shown most of a frame beats being
       shown a monogram and the word "failed". */
    const input = sharp(opened.file, {
      failOn: "none",
      limitInputPixels: false,
    });
    const metadata = await input.metadata();
    /* rotate() with no argument means "apply the EXIF orientation", and it
       must come before resize or the fit box is measured on the wrong axis. */
    const rotated = input.rotate();
    const edge =
      rung.longEdge > 0
        ? rung.longEdge
        : (options.maxEdge ?? STILL_FULL_MAX_EDGE);
    const resized = rotated.resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    });
    /* Out to sRGB whatever came in. A tagged wide-gamut source is converted
       through its own profile rather than reinterpreted, and the result
       carries the sRGB profile so a colour-managed browser leaves it alone. */
    const managed = resized.toColorspace("srgb").withIccProfile("srgb");
    const encoded =
      rung.contentType === "image/jpeg"
        ? managed.jpeg({ quality: 82, mozjpeg: true })
        : managed.webp({ quality: 82, smartSubsample: true });
    const info = await encoded.toFile(temporary);
    await rename(temporary, outputPath);
    const orientation = metadata.orientation ?? 1;
    const swapped = orientation >= 5 && orientation <= 8;
    return {
      width: info.width,
      height: info.height,
      content_type: rung.contentType,
      source_width: swapped ? (metadata.height ?? 0) : (metadata.width ?? 0),
      source_height: swapped ? (metadata.width ?? 0) : (metadata.height ?? 0),
      ...(metadata.icc ? { source_profile: profileNameOf(metadata.icc) } : {}),
      ...(swapped || orientation > 1 ? { rotated: true } : {}),
    };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await opened.cleanup();
  }
};

/* An ICC profile's description tag, for the one line the UI shows. The tag
   table is fixed-format and the description is either 'desc' (v2) or 'desc'
   as a multi-localised string (v4); both start with a four byte type
   signature, and only the ASCII run matters here. A profile we cannot parse
   is simply unnamed, never an error. */
export const profileNameOf = (icc: Uint8Array): string | undefined => {
  try {
    const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    const count = view.getUint32(128);
    for (let index = 0; index < count && index < 128; index += 1) {
      const entry = 132 + index * 12;
      const signature = String.fromCharCode(
        icc[entry] ?? 0,
        icc[entry + 1] ?? 0,
        icc[entry + 2] ?? 0,
        icc[entry + 3] ?? 0,
      );
      if (signature !== "desc") continue;
      const offset = view.getUint32(entry + 4);
      const size = view.getUint32(entry + 8);
      const body = icc.subarray(offset, offset + size);
      const type = String.fromCharCode(
        body[0] ?? 0,
        body[1] ?? 0,
        body[2] ?? 0,
        body[3] ?? 0,
      );
      /* 'desc' carries an ASCII length then the string; 'mluc' carries a
         UTF-16BE record table. Both are read for their first name only. */
      if (type === "desc") {
        const length = view.getUint32(offset + 8);
        return new TextDecoder()
          .decode(body.subarray(12, 12 + Math.max(0, length - 1)))
          .trim();
      }
      if (type === "mluc") {
        const nameLength = view.getUint32(offset + 20);
        const nameOffset = view.getUint32(offset + 24);
        return new TextDecoder("utf-16be")
          .decode(
            icc.subarray(offset + nameOffset, offset + nameOffset + nameLength),
          )
          .trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/** What an already-rendered rung is, without rendering it again. A retry that
    finds last attempt's output still on disk reuses it, exactly as the encode
    path does, and this is how its meta is rebuilt. */
export const describeStillFile = async (
  file: string,
  rung: StillRung,
): Promise<StillRenderResult> => {
  const sharp = await loadSharp();
  const metadata = await sharp(file).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    content_type: rung.contentType,
    source_width: metadata.width ?? 0,
    source_height: metadata.height ?? 0,
  };
};

/** The rungs an image version gets at ingest. */
export const stillLadderFor = (filename: string): StillRung[] =>
  isStillSource(filename) ? STILL_LADDER : [];

/** Whether this source needs a still_full rendition for 1:1 zoom, or whether
    the original serves. */
export const needsStillFull = (filename: string): boolean =>
  isStillSource(filename) && !isBrowserStill(filename);
