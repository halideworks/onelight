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
import {
  audioHashFromEnvelope,
  dHashFromLuma,
  isSilentEnvelope,
  joinHashes,
} from "@onelight/core";
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
/* Sixteen points, not four.

   Four was enough to say "the same cut, differently graded", because the
   samples line up. It is nowhere near enough to recognise a re-edit, where
   the question is how much of the FOOTAGE is shared and the answer is a
   fraction: four samples can only answer in quarters. Sixteen makes the
   overlap score mean something, and sixteen seeks is still a fixed cost that
   does not care how long the clip is.

   They avoid both ends, where a slate, a fade or black would make every clip
   look like every other. */
export const CLIP_HASH_POSITIONS = Array.from(
  { length: 16 },
  (_, index) => 0.06 + (index * 0.88) / 15,
);

/* A clip shorter than the grid is spaced on cannot answer sixteen distinct
   seeks: the same frame comes back over and over, or nothing does past the
   end. A 41 ms single frame delivery is a real thing, and the first version
   gave it no signature at all. So the grid shrinks for short clips, to the
   points that can land on their own frame, and one is a valid answer. A count
   is part of the signature, so a short clip only ever compares positionally
   with another of the same count, which is what we want: it is a still that
   happens to be in a container. */
const MIN_SAMPLE_GAP_SECONDS = 0.25;

export const clipHashPositions = (durationSeconds: number): number[] => {
  const room = Math.floor(durationSeconds / MIN_SAMPLE_GAP_SECONDS);
  if (room >= CLIP_HASH_POSITIONS.length) return CLIP_HASH_POSITIONS;
  const count = Math.max(1, room);
  /* A clip with one frame has no interior: any nonzero seek lands past the
     only picture in it and ffmpeg writes nothing. Measured, not assumed. */
  if (count === 1) return [0];
  return Array.from(
    { length: count },
    (_, index) => 0.06 + (index * 0.88) / (count - 1),
  );
};

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
  const positions = clipHashPositions(duration);
  /* Where the grid has shrunk, the clip is short enough that the last point
     can land between the final frame and the reported duration, and ffmpeg
     writes nothing rather than failing loudly. Stopping there and keeping
     what came out is deterministic for a given file, which is all a
     signature needs; a clip long enough for the full grid still has to
     sample all sixteen or none. */
  const tolerateShortTail = positions.length < CLIP_HASH_POSITIONS.length;
  try {
    for (const [index, fraction] of positions.entries()) {
      const frame = path.join(
        workDirectory,
        `.print-${tag}-${String(index)}.png`,
      );
      written.push(frame);
      let luma: Uint8Array;
      try {
        await runProcess(
          ffmpeg,
          buildClipFrameArgs(source, duration * fraction, frame),
        );
        const raw = await sharp(frame, { failOn: "none" })
          .greyscale()
          .resize({ width: HASH_WIDTH, height: HASH_HEIGHT, fit: "fill" })
          .raw()
          .toBuffer();
        luma = new Uint8Array(raw);
      } catch (error) {
        if (tolerateShortTail && hashes.length) break;
        throw error;
      }
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
  if (!hashes.length) return null;
  return tolerateShortTail || hashes.length === positions.length
    ? joinHashes(hashes)
    : null;
};

/* ---- what a clip sounds like ----

   A loudness contour, decoded once at a low rate: mono, 8 kHz, and reduced to
   one number per window. ffmpeg's astats does the reduction, so nothing but a
   little text crosses the process boundary. Silence produces no signature,
   because a silent slate would otherwise sound like every other silent slate.

   This is the tier that answers a colour pass: a grade changes every pixel and
   not one sample of the audio. */
export const AUDIO_WINDOW_COUNT = 65;

/* astats resets by FRAME, not by seconds, and how many frames a clip has
   depends on its sample rate and the resampler's block size. So it measures
   every frame and the contour is normalised here instead: whatever came back
   is averaged into a fixed number of windows, which is what makes a fifteen
   second spot and a thirty second one produce hashes of the same shape. */
export const buildAudioEnvelopeArgs = (source: string): string[] => [
  "-hide_banner",
  "-nostats",
  "-i",
  source,
  "-map",
  "0:a:0",
  "-af",
  "aformat=channel_layouts=mono,aresample=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
  "-f",
  "null",
  "-",
];

/** The measured frames, averaged into a fixed number of windows. */
export const resampleEnvelope = (
  levels: number[],
  windows: number,
): number[] => {
  if (levels.length < windows) return levels;
  const out: number[] = [];
  for (let index = 0; index < windows; index += 1) {
    const from = Math.floor((index * levels.length) / windows);
    const to = Math.max(
      from + 1,
      Math.floor(((index + 1) * levels.length) / windows),
    );
    let total = 0;
    for (let at = from; at < to; at += 1) total += levels[at] as number;
    out.push(total / (to - from));
  }
  return out;
};

/** The windows astats printed, in order. */
export const parseRmsLevels = (text: string): number[] => {
  const levels: number[] = [];
  for (const line of text.split("\n")) {
    const match = /RMS_level=(-?\d+(?:\.\d+)?|-inf)/.exec(line);
    if (!match) continue;
    const value = match[1] as string;
    /* astats speaks in dBFS; silence is -inf. Back to a linear amplitude so
       the contour compares as loudness rather than as decibels. */
    levels.push(value === "-inf" ? 0 : 10 ** (Number(value) / 20));
  }
  return levels;
};

export const fingerprintAudio = async (
  source: string,
  options: { durationSeconds: number; ffmpeg?: string },
): Promise<string | null> => {
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  if (!(options.durationSeconds > 0)) return null;
  try {
    const result = await runProcess(ffmpeg, buildAudioEnvelopeArgs(source));
    /* ametadata prints to stdout; astats itself logs to stderr. */
    const levels = parseRmsLevels(`${result.stdout}\n${result.stderr}`);
    if (levels.length < 16 || isSilentEnvelope(levels)) return null;
    return audioHashFromEnvelope(resampleEnvelope(levels, AUDIO_WINDOW_COUNT));
  } catch {
    /* No audio stream, or a decoder that would not play: not a failure. */
    return null;
  }
};
