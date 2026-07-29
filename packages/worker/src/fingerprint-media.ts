/* Fingerprinting a file: the pixels half, which needs a decoder.

   The arithmetic and the rules live in core; this is only the part that has to
   open the media. A still is hashed once from the picture itself. A clip is
   hashed at four points along its own length, because two takes of the same
   set-up share an opening frame and diverge later, and one hash of frame one
   would call them the same clip.

   The clip's four points come from the sprite the pipeline already builds: a
   10x10 montage sampled across the whole runtime. Reading four of its tiles
   costs one open of a small PNG, against decoding the movie again. */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  captureIdentityFromExif,
  dHashFromLuma,
  joinHashes,
} from "@onelight/core";
import type { CaptureIdentity } from "@onelight/core";
import { runProcess } from "./run-process.js";

const loadSharp = async () => (await import("sharp")).default;

/** The sample geometry a difference hash wants: one column wider than tall. */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/* Which tiles of a 10x10 sprite to hash. Spread across the clip and away from
   both ends, where a slate, a fade or black would make every clip identical. */
export const SPRITE_HASH_TILES = [12, 34, 56, 78];

/* Nothing to tell apart: every sample within a hair of every other. */
const FLAT_TILE_RANGE = 4;

export const isFlat = (luma: Uint8Array): boolean => {
  if (!luma.length) return true;
  let low = 255;
  let high = 0;
  for (const value of luma) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return high - low <= FLAT_TILE_RANGE;
};

export interface MediaFingerprint {
  contentHash: string | null;
  capture: CaptureIdentity;
}

const hashOfPipeline = async (image: {
  clone: () => {
    greyscale: () => {
      resize: (options: unknown) => {
        raw: () => { toBuffer: () => Promise<Buffer> };
      };
    };
  };
}): Promise<string> => {
  const raw = await image
    .clone()
    .greyscale()
    .resize({ width: HASH_WIDTH, height: HASH_HEIGHT, fit: "fill" })
    .raw()
    .toBuffer();
  return dHashFromLuma(new Uint8Array(raw), HASH_WIDTH, HASH_HEIGHT);
};

/** A still: one hash of the picture, and whatever its EXIF says about it. */
export const fingerprintStill = async (
  file: string,
): Promise<MediaFingerprint> => {
  const sharp = await loadSharp();
  const image = sharp(file, { failOn: "none", limitInputPixels: 500_000_000 });
  const metadata = await image.metadata();
  /* Orientation first: a portrait frame stored landscape must hash as the
     picture, or it will never match its own re-export. */
  const upright = image.rotate();
  return {
    contentHash: await hashOfPipeline(
      upright as unknown as Parameters<typeof hashOfPipeline>[0],
    ),
    capture: captureIdentityFromExif(metadata.exif),
  };
};

/** A clip: four hashes taken from the sprite the pipeline already made.

    `tiles` is how many of the montage's cells hold an actual frame. ffmpeg's
    tile filter pads a short clip's montage out to the full grid with flat
    colour, and hashing that would give every short clip the same signature,
    so a clip without frames at all four sampling points gets no signature at
    all rather than a shared one. */
export const fingerprintSprite = async (
  spriteFile: string,
  grid: { columns: number; rows: number; tiles: number },
): Promise<string | null> => {
  const sharp = await loadSharp();
  const image = sharp(spriteFile, { failOn: "none" });
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height || grid.columns < 1 || grid.rows < 1) return null;
  const tileWidth = Math.floor(width / grid.columns);
  const tileHeight = Math.floor(height / grid.rows);
  if (tileWidth < HASH_WIDTH || tileHeight < HASH_HEIGHT) return null;
  const hashes: string[] = [];
  for (const index of SPRITE_HASH_TILES) {
    if (index >= grid.tiles) continue;
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    if (row >= grid.rows) continue;
    const raw = await sharp(spriteFile, { failOn: "none" })
      .extract({
        left: column * tileWidth,
        top: row * tileHeight,
        width: tileWidth,
        height: tileHeight,
      })
      .greyscale()
      .resize({ width: HASH_WIDTH, height: HASH_HEIGHT, fit: "fill" })
      .raw()
      .toBuffer();
    /* A flat tile (black, a fade, a white card) hashes to nothing but zeros,
       and two clips that both have one would look alike at that position.
       One flat sample is enough to refuse the whole signature. */
    if (isFlat(new Uint8Array(raw))) return null;
    hashes.push(dHashFromLuma(new Uint8Array(raw), HASH_WIDTH, HASH_HEIGHT));
  }
  /* All four or none: a signature is only comparable to one of its own
     shape, so a short clip whose sprite has fewer tiles gets no signature
     rather than one nothing else can be compared against. */
  return hashes.length === SPRITE_HASH_TILES.length ? joinHashes(hashes) : null;
};

/* A clip that has no sprite yet: four seeks rather than a full decode.

   This is the path an upload takes while it is still being matched, before it
   is a version with a pipeline behind it. The sampling points are the same
   fractions the sprite's tiles fall on, so a signature taken here is
   comparable with one taken from a sprite later. */
export const CLIP_HASH_POSITIONS = [0.12, 0.34, 0.56, 0.78];

export const buildClipFrameArgs = (
  source: string,
  seconds: number,
  outputPath: string,
): string[] => [
  "-hide_banner",
  "-y",
  "-ss",
  seconds.toFixed(3),
  "-i",
  source,
  "-frames:v",
  "1",
  "-vf",
  "scale=160:90:force_original_aspect_ratio=decrease",
  outputPath,
];

export const fingerprintClip = async (
  source: string,
  options: {
    durationSeconds: number;
    workDirectory: string;
    ffmpeg?: string;
    tag?: string;
  },
): Promise<string | null> => {
  const { durationSeconds: duration, workDirectory } = options;
  if (!(duration > 0)) return null;
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const sharp = await loadSharp();
  await mkdir(workDirectory, { recursive: true });
  const tag = options.tag ?? "clip";
  const hashes: string[] = [];
  const written: string[] = [];
  try {
    for (const [index, fraction] of CLIP_HASH_POSITIONS.entries()) {
      const frame = path.join(
        workDirectory,
        `.print-${tag}-${String(index)}.png`,
      );
      written.push(frame);
      await runProcess(
        ffmpeg,
        buildClipFrameArgs(source, duration * fraction, frame),
      );
      const raw = await sharp(frame, { failOn: "none" })
        .greyscale()
        .resize({ width: HASH_WIDTH, height: HASH_HEIGHT, fit: "fill" })
        .raw()
        .toBuffer();
      const luma = new Uint8Array(raw);
      /* Same rule as the sprite: one flat sample and the whole signature is
         refused, because flat samples make different clips look alike. */
      if (isFlat(luma)) return null;
      hashes.push(dHashFromLuma(luma, HASH_WIDTH, HASH_HEIGHT));
    }
  } catch {
    return null;
  } finally {
    for (const frame of written)
      await rm(frame, { force: true }).catch(() => undefined);
  }
  return hashes.length === CLIP_HASH_POSITIONS.length
    ? joinHashes(hashes)
    : null;
};
