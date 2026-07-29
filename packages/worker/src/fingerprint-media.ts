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

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  contourHash,
  hasContourShape,
  dHashFromLuma,
  isSilentEnvelope,
  joinHashes,
} from "@onelight/core";
import { runProcess } from "./run-process.js";

/* Nobody waits on a fingerprint.

   The match endpoint is a dry run that reports "pending" and is asked again,
   and the backfill is a library being catalogued. Meanwhile these passes are
   full decodes: measured on nyx, one motion contour took 342% of a four core
   box that also serves the site. So every pass yields, the same way the
   software AV1 encode does, and the decode is capped so a single clip cannot
   take the machine even when the box is otherwise idle. An idle box still
   gives it everything going spare; the moment a request arrives, the request
   wins. */
const FINGERPRINT_NICENESS = 19;
const FINGERPRINT_THREADS = ["-threads", "2", "-filter_threads", "1"];

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
  ...FINGERPRINT_THREADS,
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
          undefined,
          undefined,
          FINGERPRINT_NICENESS,
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
export const AUDIO_ENVELOPE_FILTER =
  "aformat=channel_layouts=mono,aresample=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-";

export const buildAudioEnvelopeArgs = (source: string): string[] => [
  "-hide_banner",
  "-nostats",
  ...FINGERPRINT_THREADS,
  "-i",
  source,
  "-map",
  "0:a:0",
  "-af",
  AUDIO_ENVELOPE_FILTER,
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
    const result = await runProcess(
      ffmpeg,
      buildAudioEnvelopeArgs(source),
      undefined,
      undefined,
      FINGERPRINT_NICENESS,
    );
    /* ametadata prints to stdout; astats itself logs to stderr. */
    const levels = parseRmsLevels(`${result.stdout}\n${result.stderr}`);
    if (levels.length < 16 || isSilentEnvelope(levels)) return null;
    return contourHash(resampleEnvelope(levels, AUDIO_WINDOW_COUNT));
  } catch {
    /* No audio stream, or a decoder that would not play: not a failure. */
    return null;
  }
};

/* ---- what a clip does over its own length ----

   The same idea as the loudness contour, applied to the picture, for the case
   the loudness contour cannot answer: a colour pass delivered with no audio,
   which is common. One number per frame, the mean absolute difference between
   this frame and the last, at 160x90 greyscale. Cuts are spikes, camera moves
   are plateaus, a locked-off shot is a floor. That shape is the edit.

   A grade is a per pixel transform and cannot move a cut, so the contour is
   nearly untouched by one; a re-edit moves every spike. The hash only compares
   each window against the next, so even a grade that flattens the whole
   picture, which scales the differences down, moves no bit by scaling alone.

   One decode pass, at a size chosen so the decode dominates and the filter
   does not. tblend does the differencing and signalstats the reduction, so
   what crosses the process boundary is a column of numbers. */
export const MOTION_WINDOW_COUNT = 65;

export const MOTION_ENVELOPE_FILTER =
  "scale=160:90,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-";

export const buildMotionEnvelopeArgs = (source: string): string[] => [
  "-hide_banner",
  "-nostats",
  ...FINGERPRINT_THREADS,
  "-i",
  source,
  "-map",
  "0:v:0",
  "-an",
  "-vf",
  MOTION_ENVELOPE_FILTER,
  "-f",
  "null",
  "-",
];

/** The per frame motion signalstats printed, in order. */
export const parseMotionLevels = (text: string): number[] => {
  const levels: number[] = [];
  for (const line of text.split("\n")) {
    const match = /signalstats\.YAVG=(-?\d+(?:\.\d+)?)/.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) levels.push(value);
  }
  return levels;
};

/* Fewer frames than windows and there is nothing to contour; a picture that
   barely changes has no shape to speak of and its hash would be the encoder's
   noise, so hasContourShape refuses it. Both are the motion equivalents of
   silence. */
export const fingerprintMotion = async (
  source: string,
  options: { ffmpeg?: string } = {},
): Promise<string | null> => {
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  try {
    const result = await runProcess(
      ffmpeg,
      buildMotionEnvelopeArgs(source),
      undefined,
      undefined,
      FINGERPRINT_NICENESS,
    );
    const levels = parseMotionLevels(`${result.stdout}\n${result.stderr}`);
    if (levels.length < MOTION_WINDOW_COUNT) return null;
    const windows = resampleEnvelope(levels, MOTION_WINDOW_COUNT);
    if (!hasContourShape(windows)) return null;
    return contourHash(windows);
  } catch {
    /* No video stream, or a decoder that would not play: not a failure. */
    return null;
  }
};

/* ---- all three signatures, in one decode ----

   A clip used to cost seventeen ffmpeg invocations: sixteen seeks for the
   positional signature, a full decode for the motion contour, and one more for
   the audio. Every one of them opened the container and started a decoder
   again, and each seek decoded from its preceding keyframe to get one frame.

   The decode the motion contour already does passes through every frame the
   seeks were looking for. So do it once. The decoded video is split: one branch
   goes to the difference filter, the other through a select that keeps the same
   frames a seek would have landed on, and the audio rides along on its own
   output over a stream that is already demuxed. The frames are scaled by the
   same filter and hashed by the same sharp path as before, so the answers are
   not merely close, they are identical, which is asserted rather than assumed.

   Measured on nyx: a thirty second 1080p clip goes 7.8 s to 2.9 s, and a
   ninety-four second spot 30.5 s to 11.1 s with hardware decode. */

export type ClipSignatures = {
  content: string | null;
  motion: string | null;
  audio: string | null;
};

/* Why the sound is NOT in the fold.

   It was, and on real footage it came out different. Both signatures the fold
   produced agreed with each other and disagreed with the standalone pass by a
   few bits, which is what a shifted window boundary looks like: with video and
   audio mapped from one input, ffmpeg aligns the streams at the earliest start
   time, and the astats frames the contour is averaged from land a frame off.
   The library is already signed by the standalone pass, and a fingerprint that
   changes when the command around it changes is not a fingerprint. So the
   audio keeps its own command. It was never the cost: 0.6 s against 28 s of
   decode on a ninety-four second spot.

   A synthetic clip did not show this. Two real spots did. */

export const buildClipPassArgs = (
  source: string,
  options: {
    positions: number[];
    durationSeconds: number;
    frameIntervalSeconds: number;
    framePattern: string;
    decodeArgs?: string[];
  },
): string[] => {
  const { durationSeconds: duration, frameIntervalSeconds: interval } = options;
  /* A generous window per point rather than a surgical one. Trying to admit
     exactly one frame is a trap: a window a hair under one frame misses the
     point that falls just after a frame, and a hair over admits two. So take
     everything within a couple of frames and let showinfo say what actually
     came out; the choice of which frame answers each point is made in JS,
     where it can be the same rule an input seek follows. A few extra small
     PNGs cost nothing next to a decode. */
  const select = options.positions
    .map((fraction) => {
      const at = duration * fraction;
      return `between(t\\,${at.toFixed(6)}\\,${(at + interval * 2).toFixed(6)})`;
    })
    .join("+");
  return [
    "-hide_banner",
    "-nostats",
    ...(options.decodeArgs ?? []),
    ...FINGERPRINT_THREADS,
    "-i",
    source,
    "-filter_complex",
    [
      "[0:v]split=2[motion][frames]",
      `[motion]${MOTION_ENVELOPE_FILTER}[contour]`,
      `[frames]select='${select}',showinfo,scale=160:90:force_original_aspect_ratio=decrease[sampled]`,
    ].join(";"),
    "-map",
    "[contour]",
    "-f",
    "null",
    "-",
    "-map",
    "[sampled]",
    /* No frame rate conversion: one written file per selected frame, in order,
       which is what pairs them with what showinfo reported. */
    "-fps_mode",
    "passthrough",
    "-y",
    options.framePattern,
  ];
};

/* The presentation times showinfo reported, in the order the frames came.

   Only showinfo's own lines: metadata=print heads every frame it reports with
   a pts_time of its own, and the motion branch reports every frame in the
   clip, so a bare search for pts_time reads the wrong stream entirely. That
   was a real bug, and the symptom was 1223 times for 16 frames. */
export const parseShowinfoTimes = (text: string): number[] => {
  const times: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("showinfo")) continue;
    const match = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
    if (match) times.push(Number(match[1]));
  }
  return times;
};

/* Which written frame answers each point: the first one at or after it, which
   is exactly what an input seek to that point returns. A point with nothing at
   or after it has no answer, and the caller falls back rather than guess. */
export const chooseSampledFrames = (
  positions: number[],
  durationSeconds: number,
  times: number[],
  frameIntervalSeconds: number,
): number[] | null => {
  const chosen: number[] = [];
  for (const fraction of positions) {
    const at = durationSeconds * fraction;
    /* A hair of tolerance: ffmpeg's own seek accepts the frame whose time
       rounds to the point, and showinfo prints six decimals. */
    const index = times.findIndex((time) => time >= at - 0.001);
    const time = index === -1 ? undefined : times[index];
    /* And the frame has to actually belong to this point. Without this a point
       whose window came back empty would silently borrow the next point's
       frame, which is a wrong answer rather than a refusal. */
    if (time === undefined || time > at + frameIntervalSeconds * 1.5)
      return null;
    chosen.push(index);
  }
  return chosen;
};

/* And the pass itself. Anything that does not come back exactly right is a
   fallback rather than a guess: the hashes it produces have to be the same
   numbers the seek path produces, because a library is already signed with
   them, so a short yield, a missing point or a broken decoder means the proven
   path runs instead. */
export const fingerprintClipPass = async (
  source: string,
  options: {
    durationSeconds: number;
    frameIntervalSeconds: number;
    workDirectory: string;
    ffmpeg?: string;
    tag?: string;
    decodeArgs?: string[];
  },
): Promise<Omit<ClipSignatures, "audio"> | null> => {
  const { durationSeconds: duration } = options;
  if (!(duration > 0) || !(options.frameIntervalSeconds > 0)) return null;
  const ffmpeg = options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const tag = options.tag ?? "clip";
  const positions = clipHashPositions(duration);
  const frames = path.join(options.workDirectory, `.pass-${tag}`);
  await mkdir(frames, { recursive: true });
  try {
    const result = await runProcess(
      ffmpeg,
      buildClipPassArgs(source, {
        positions,
        durationSeconds: duration,
        frameIntervalSeconds: options.frameIntervalSeconds,
        framePattern: path.join(frames, "point-%04d.png"),
        ...(options.decodeArgs ? { decodeArgs: options.decodeArgs } : {}),
      }),
      undefined,
      undefined,
      FINGERPRINT_NICENESS,
    );
    const text = `${result.stdout}\n${result.stderr}`;
    const written = (await readdir(frames)).sort();
    const times = parseShowinfoTimes(text);
    if (written.length !== times.length) return null;
    const chosen = chooseSampledFrames(
      positions,
      duration,
      times,
      options.frameIntervalSeconds,
    );
    if (!chosen) return null;
    const sharp = await loadSharp();
    const hashes: string[] = [];
    for (const index of chosen) {
      const file = written[index];
      if (!file) return null;
      const raw = await sharp(path.join(frames, file), { failOn: "none" })
        .greyscale()
        .resize({ width: HASH_WIDTH, height: HASH_HEIGHT, fit: "fill" })
        .raw()
        .toBuffer();
      const luma = new Uint8Array(raw);
      /* The same refusal as the seek path: one flat sample voids the picture,
         because flat samples make different clips look alike. */
      if (isFlat(luma)) return { content: null, motion: null };
      hashes.push(dHashFromLuma(luma, HASH_WIDTH, HASH_HEIGHT));
    }
    const motionLevels = parseMotionLevels(text);
    const motionWindows =
      motionLevels.length >= MOTION_WINDOW_COUNT
        ? resampleEnvelope(motionLevels, MOTION_WINDOW_COUNT)
        : null;
    return {
      content: joinHashes(hashes),
      motion:
        motionWindows && hasContourShape(motionWindows)
          ? contourHash(motionWindows)
          : null,
    };
  } catch {
    return null;
  } finally {
    await rm(frames, { recursive: true, force: true }).catch(() => undefined);
  }
};

/* What the callers use. One decode with the GPU if the caller offered it, one
   without if that fails, and the seek path as the floor. Each step is slower
   and more certain than the last. */
export const fingerprintClipSignatures = async (
  source: string,
  options: {
    durationSeconds: number;
    frameIntervalSeconds: number;
    workDirectory: string;
    withAudio: boolean;
    ffmpeg?: string;
    tag?: string;
    decodeArgs?: string[];
  },
): Promise<ClipSignatures> => {
  /* The sound, on its own command, which is where its numbers come from. */
  const audio = options.withAudio
    ? await fingerprintAudio(source, {
        durationSeconds: options.durationSeconds,
        ...(options.ffmpeg ? { ffmpeg: options.ffmpeg } : {}),
      }).catch(() => null)
    : null;
  const attempts = options.decodeArgs?.length
    ? [options.decodeArgs, [] as string[]]
    : [[] as string[]];
  for (const decodeArgs of attempts) {
    const folded = await fingerprintClipPass(source, {
      ...options,
      decodeArgs,
    });
    if (folded) return { ...folded, audio };
  }
  const content = await fingerprintClip(source, {
    durationSeconds: options.durationSeconds,
    workDirectory: options.workDirectory,
    ...(options.ffmpeg ? { ffmpeg: options.ffmpeg } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
  }).catch(() => null);
  const motion = await fingerprintMotion(source, {
    ...(options.ffmpeg ? { ffmpeg: options.ffmpeg } : {}),
  }).catch(() => null);
  return { content, motion, audio };
};
