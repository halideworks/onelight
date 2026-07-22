/* Spectrogram frequency-axis verification (node-only, ffmpeg).

   The audio stage draws a frequency scale over the spectrogram the worker
   renders. ffmpeg's showspectrumpic log frequency scale is not a plain
   logarithm, the filter does not publish its curve, and the curve depends on
   the input's Nyquist frequency -- which is why the worker resamples to 48
   kHz first (SPECTROGRAM_RATE) and why the player's axis table
   (SPECTROGRAM_AXIS in packages/player/src/waveform.ts) is a MEASUREMENT of
   that filter rather than a formula.

   A measurement is only as good as the day it was taken. This suite retakes
   it: for each labelled frequency it renders a sine through the exact filter
   string the worker ships, finds the row the energy lands on, and fails if the
   player would have drawn the label somewhere else. An ffmpeg upgrade that
   changes the scale is then a red test, not a silently lying axis. */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPECTROGRAM_HEIGHT,
  SPECTROGRAM_RATE,
} from "../../packages/worker/src/media.js";
import { spectrogramY } from "../../packages/player/src/waveform.js";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";

const env = readEnvironment();
const reason = skipReason(env, ["ffmpeg"]);
if (reason) console.log(`[qa] spectrogram axis: skipped (${reason})`);

const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const workDir = path.join(artifactsDir, "spectrogram");

/* The same filter the worker builds, with the width cut down: the axis is
   vertical, so one narrow column carries the whole measurement. */
const FILTER = `aresample=${SPECTROGRAM_RATE},showspectrumpic=s=64x${SPECTROGRAM_HEIGHT}:mode=combined:legend=0:scale=log:fscale=log:color=magma,format=gray`;

const run = (args: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(Buffer.concat(err).toString("utf8").slice(-2000))),
    );
  });

/** Fraction up the rendered spectrogram where a pure tone actually lands. */
const measure = async (hz: number): Promise<number> => {
  const file = path.join(workDir, `tone-${hz}.png`);
  await run([
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${hz}:duration=1:sample_rate=${SPECTROGRAM_RATE}`,
    "-filter_complex",
    `[0:a]${FILTER}[spec]`,
    "-map",
    "[spec]",
    "-frames:v",
    "1",
    file,
  ]);
  const raw = await run([
    "-v",
    "error",
    "-i",
    file,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);
  const width = 64;
  const column = 32;
  let brightest = 0;
  for (let y = 0; y < SPECTROGRAM_HEIGHT; y += 1)
    brightest = Math.max(brightest, raw[y * width + column] ?? 0);
  /* Intensity-weighted centroid of the band the tone lit up, so the answer is
     sub-pixel rather than whichever row won by one level. */
  let weighted = 0;
  let total = 0;
  for (let y = 0; y < SPECTROGRAM_HEIGHT; y += 1) {
    const value = raw[y * width + column] ?? 0;
    if (value > brightest * 0.6) {
      weighted += y * value;
      total += value;
    }
  }
  const row = weighted / total;
  /* Row 0 is the top of the picture and the top is the high end. */
  return (SPECTROGRAM_HEIGHT - 1 - row) / (SPECTROGRAM_HEIGHT - 1);
};

describe.skipIf(reason !== undefined)(
  "spectrogram: the drawn frequency axis matches where ffmpeg puts the tones",
  () => {
    it("places every labelled frequency within two pixels of the table", async () => {
      await mkdir(workDir, { recursive: true });
      /* The labelled decades, plus the third-octave centres either side of
         them: a scale that is right at 1 kHz and wrong at 800 Hz is still a
         wrong scale. Below 200 Hz the filter's own resolution smears a tone
         over enough rows that a centroid is not a measurement, so the low end
         is left out of the assertion (the table still carries it, and the
         drawing puts no label there). */
      for (const hz of [200, 500, 800, 1000, 1250, 4000, 10000, 16000]) {
        const measured = await measure(hz);
        const drawn = spectrogramY(hz);
        const offBy = Math.abs(measured - drawn) * SPECTROGRAM_HEIGHT;
        expect(
          offBy,
          `${hz} Hz: drawn at ${(drawn * 100).toFixed(2)}% of the height, ffmpeg puts it at ${(measured * 100).toFixed(2)}%`,
        ).toBeLessThanOrEqual(2);
      }
    });
  },
);
