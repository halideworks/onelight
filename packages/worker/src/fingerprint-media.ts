/* Fingerprinting a file: the pixels half, which needs a decoder.

   The arithmetic and the rules live in core; this is only the part that has to
   open the media. A still is hashed once from the picture itself. A clip is
   hashed at four points along its own length, because two takes of the same
   set-up share an opening frame and diverge later, and one hash of frame one
   would call them the same clip.

   The clip's four points are fixed fractions of its own length, seeked. The
   sprite the pipeline builds was the obvious free source for them and is the
   wrong one: its tiles only land on those fractions when the montage has a
   full hundred, so a shorter clip would be signed at different moments than
   the file it is meant to match. Four seeks are cheap and always agree. */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { dHashFromLuma, joinHashes } from "@onelight/core";
import { runProcess } from "./run-process.js";

const loadSharp = async () => (await import("sharp")).default;

/** The sample geometry a difference hash wants: one column wider than tall. */
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

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

/* A clip's signature: four seeks rather than a full decode.

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
