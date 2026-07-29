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

import { mkdir, readFile, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import {
  isFfmpegStill,
  isHeifStill,
  isPhotoshopStill,
  isRawStill,
  isSharpStill,
  isStillSource,
} from "@onelight/core";
import { readNetpbm } from "./netpbm.js";
import { readPsdComposite } from "./psd-image.js";
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

/* The format table lives in core: the API needs it to decide what an image
   is, and the review room needs it to decide whether 1:1 zoom can use the
   original. Re-exported here so this module still reads as the whole story. */
export {
  BROWSER_STILL_EXTENSIONS,
  FFMPEG_STILL_EXTENSIONS,
  HEIF_STILL_EXTENSIONS,
  PHOTOSHOP_STILL_EXTENSIONS,
  RAW_STILL_EXTENSIONS,
  SHARP_STILL_EXTENSIONS,
  isBrowserStill,
  isFfmpegStill,
  isHeifStill,
  isPhotoshopStill,
  isRawStill,
  isSharpStill,
  isStillSource,
  needsStillFull,
} from "@onelight/core";

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

/* RAW as libraw's own tool renders it: half-size demosaic (plenty for a 2048
   review still and several times faster than a full one), the white balance
   the photographer set in camera, sRGB, 16 bits, TIFF out. -a would guess at
   the white balance; -w shows them the picture they took.

   The output is netpbm rather than TIFF on purpose: dcraw's TIFF is not
   something the libvips in this image will open, and netpbm has no tags to
   disagree about (see netpbm.ts). dcraw_emu names its output after its input
   and will not be argued out of it, so the caller hands it a path inside the
   work directory, a symlink to the real source, and reads back that path
   plus ".ppm". */
export const buildRawDecodeArgs = (linkedSource: string): string[] => [
  "-w",
  "-h",
  "-o",
  "1",
  "-6",
  linkedSource,
];

/** HEIC and HEIF through libheif, which is the only decoder here that opens
    them. PNG out, so nothing is thrown away twice. */
export const buildHeifDecodeArgs = (
  source: string,
  outputPath: string,
): string[] => [source, outputPath];

interface OpenedSource {
  /** A path sharp can open, when the decode produced a file. */
  file?: string;
  /** Interleaved RGB, when the decode happened in this process. */
  raw?: { data: Uint8Array; width: number; height: number };
  cleanup: () => Promise<void>;
}

const noCleanup = async (): Promise<void> => {};

/** Whatever it takes to get pixels out of this file and into sharp. */
const openable = async (
  source: string,
  workDirectory: string,
  tools: { ffmpeg: string; dcraw: string; heif: string },
): Promise<OpenedSource> => {
  if (isSharpStill(source)) return { file: source, cleanup: noCleanup };

  /* Photoshop first, and in this process: ffmpeg refuses PSB outright, and
     one reader handles both containers. A PSD it cannot make sense of (an
     exotic compression, say) falls through to ffmpeg, which is where PSDs
     were read before this. */
  if (isPhotoshopStill(source)) {
    try {
      const composite = readPsdComposite(await readFile(source));
      return {
        raw: {
          data: composite.data,
          width: composite.width,
          height: composite.height,
        },
        cleanup: noCleanup,
      };
    } catch (error) {
      if (!isFfmpegStill(source)) throw error;
      console.warn(
        `[onelight-worker] reading ${path.basename(source)} directly failed, falling back to ffmpeg: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await mkdir(workDirectory, { recursive: true });
  const decodeTo = async (
    extension: string,
    command: string,
    args: (output: string) => string[],
  ): Promise<OpenedSource> => {
    const decoded = path.join(
      workDirectory,
      `.decode-${path.basename(source)}.${extension}`,
    );
    await runProcess(command, args(decoded));
    if (!(await fileExists(decoded)))
      throw new Error(
        `${path.basename(command)} decoded no image from ${path.basename(source)}.`,
      );
    return {
      file: decoded,
      cleanup: async () => {
        await rm(decoded, { force: true }).catch(() => undefined);
      },
    };
  };

  if (isRawStill(source)) {
    /* A symlink rather than a copy: a RAW is tens of megabytes and the
       decoder only ever reads it. The blob store is never written to. */
    const linked = path.join(workDirectory, `.raw-${path.basename(source)}`);
    await rm(linked, { force: true }).catch(() => undefined);
    await symlink(source, linked);
    const decoded = `${linked}.ppm`;
    const cleanup = async (): Promise<void> => {
      await rm(linked, { force: true }).catch(() => undefined);
      await rm(decoded, { force: true }).catch(() => undefined);
    };
    try {
      await runProcess(tools.dcraw, buildRawDecodeArgs(linked));
      if (!(await fileExists(decoded)))
        throw new Error(
          `dcraw_emu decoded no image from ${path.basename(source)}.`,
        );
      const image = readNetpbm(await readFile(decoded));
      await cleanup();
      return {
        raw: { data: image.data, width: image.width, height: image.height },
        cleanup: noCleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  if (isHeifStill(source))
    return decodeTo("png", tools.heif, (output) =>
      buildHeifDecodeArgs(source, output),
    );
  return decodeTo("png", tools.ffmpeg, (output) =>
    buildStillDecodeArgs(source, output),
  );
};

/* Every rung is written to a temp name and renamed on success, the same
   contract runTranscode keeps for encodes: a crash never leaves a truncated
   file sitting at a final path where the next run would reuse it. */
export const renderStillRung = async (
  source: string,
  outputPath: string,
  rung: StillRung,
  options: {
    ffmpeg?: string;
    dcraw?: string;
    heif?: string;
    maxEdge?: number;
  } = {},
): Promise<StillRenderResult> => {
  const tools = {
    ffmpeg: options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg",
    dcraw: options.dcraw ?? process.env.DCRAW_PATH ?? "dcraw_emu",
    heif: options.heif ?? process.env.HEIF_DEC_PATH ?? "heif-dec",
  };
  const sharp = await loadSharp();
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const opened = await openable(source, directory, tools);
  const temporary = path.join(directory, `.tmp-${path.basename(outputPath)}`);
  try {
    /* failOn "none" so a truncated JPEG with a good first two thirds still
       produces a picture; a reviewer being shown most of a frame beats being
       shown a monogram and the word "failed". */
    const input = opened.raw
      ? sharp(opened.raw.data, {
          raw: {
            width: opened.raw.width,
            height: opened.raw.height,
            channels: 3,
          },
          limitInputPixels: false,
        })
      : sharp(opened.file as string, {
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
