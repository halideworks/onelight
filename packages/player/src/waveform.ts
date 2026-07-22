/* Drawing maths for the audio stage: the waveform, and the frequency axis of
   the spectrogram under it. Everything here is pure so it can be tested
   without a canvas. */

import { decodePeaks, resamplePeaks } from "@onelight/core";
import type { PeaksData } from "@onelight/core";

export type { PeaksData };

/** Parse a fetched peak sidecar. Null for anything that is not one. */
export const readPeaks = (bytes: ArrayBuffer): PeaksData | null =>
  decodePeaks(new Uint8Array(bytes));

export interface WaveformBar {
  /** Left edge in device-independent pixels. */
  x: number;
  width: number;
  /** Top and bottom of the bar, in pixels down from the lane's top. */
  top: number;
  bottom: number;
}

/**
 * One bar per column of the lane, per channel. The bar is the loudest excursion
 * inside that column in both directions, so a lane at any width is a true
 * summary of the sound rather than a sampling of it.
 *
 * `gain` lifts quiet material: a dialogue stem peaking at -20 dBFS would
 * otherwise draw as a hairline. It scales the drawing only, and the readout
 * elsewhere still reports true level.
 */
export const waveformBars = (
  peaks: PeaksData,
  channel: number,
  width: number,
  height: number,
  gain = 1,
  barWidth = 2,
  gap = 1,
): WaveformBar[] => {
  if (width <= 0 || height <= 0) return [];
  const stride = Math.max(1, barWidth + gap);
  const columns = Math.max(1, Math.floor(width / stride));
  const reduced = resamplePeaks(peaks, columns);
  const middle = height / 2;
  const bars: WaveformBar[] = [];
  for (let column = 0; column < columns; column += 1) {
    const at = (column * peaks.channels + channel) * 2;
    const low = Math.max(-1, (reduced[at] ?? 0) * gain);
    const high = Math.min(1, (reduced[at + 1] ?? 0) * gain);
    /* Silence still draws a hairline: a gap in the drawing would read as
       "no data here", which is a different thing from "no sound here". */
    const top = middle - Math.max(high * middle, 0.5);
    const bottom = middle + Math.max(-low * middle, 0.5);
    bars.push({ x: column * stride, width: barWidth, top, bottom });
  }
  return bars;
};

/** Loudest sample in the sidecar, in -1..1, over both channels. */
export const peakLevel = (peaks: PeaksData): number => {
  let level = 0;
  for (let index = 0; index < peaks.samples.length; index += 1)
    level = Math.max(level, Math.abs(peaks.samples[index] ?? 0));
  return level;
};

/**
 * How much to lift the drawing so the loudest moment nearly fills the lane.
 * Capped, so a track of near-silence does not become a wall of noise, and
 * never below 1, so a hot master is never scaled down into looking quiet.
 */
export const autoGain = (peaks: PeaksData, ceiling = 0.92, cap = 8): number => {
  const level = peakLevel(peaks);
  if (level <= 0) return 1;
  return Math.min(cap, Math.max(1, ceiling / level));
};

/* ---- spectrogram ---- */

/**
 * Where a frequency sits on the spectrogram's vertical axis, as a fraction up
 * from the bottom.
 *
 * ffmpeg's showspectrumpic log frequency scale is not a plain logarithm and
 * the filter does not publish the curve, so this table is MEASURED from the
 * exact filter string the worker ships (see SPECTROGRAM_FILTER in
 * packages/worker/src/media.ts), at third-octave centres, by rendering a sine
 * at each frequency and finding the row it lands on. The worker resamples to
 * 48 kHz before the filter for this reason: the axis then does not depend on
 * what the source's sample rate happened to be, and one table is correct for
 * every file.
 *
 * qa/spectrogram-axis.test.ts regenerates the table and fails if a different
 * ffmpeg would put the tones somewhere else.
 */
export const SPECTROGRAM_AXIS: ReadonlyArray<readonly [number, number]> = [
  [31.5, 0.1274],
  [63, 0.1395],
  [125, 0.1761],
  [200, 0.2779],
  [250, 0.3219],
  [315, 0.3698],
  [400, 0.4091],
  [500, 0.445],
  [630, 0.48],
  [800, 0.5167],
  [1000, 0.549],
  [1250, 0.5814],
  [1600, 0.6173],
  [2000, 0.6496],
  [2500, 0.681],
  [3150, 0.7142],
  [4000, 0.7477],
  [5000, 0.7798],
  [6300, 0.8122],
  [8000, 0.8464],
  [10000, 0.8778],
  [12500, 0.9092],
  [16000, 0.9443],
  [20000, 0.9758],
];

/** Fraction up the spectrogram for a frequency in Hz, interpolated in log f. */
export const spectrogramY = (hz: number): number => {
  const first = SPECTROGRAM_AXIS[0] as readonly [number, number];
  const last = SPECTROGRAM_AXIS[SPECTROGRAM_AXIS.length - 1] as readonly [
    number,
    number,
  ];
  if (hz <= first[0]) return first[1];
  if (hz >= last[0]) return last[1];
  for (let index = 1; index < SPECTROGRAM_AXIS.length; index += 1) {
    const above = SPECTROGRAM_AXIS[index] as readonly [number, number];
    if (hz > above[0]) continue;
    const below = SPECTROGRAM_AXIS[index - 1] as readonly [number, number];
    const span = Math.log(above[0] / below[0]);
    const into = Math.log(hz / below[0]);
    return below[1] + ((above[1] - below[1]) * into) / span;
  }
  return last[1];
};

/** The frequencies the axis is labelled at: one per decade, plus the ends. */
export const SPECTROGRAM_TICKS: ReadonlyArray<{ hz: number; label: string }> = [
  { hz: 100, label: "100" },
  { hz: 1000, label: "1k" },
  { hz: 10000, label: "10k" },
];

/**
 * A 256-entry lookup from the spectrogram's luminance to ink.
 *
 * The worker writes the spectrogram in grey on purpose: amplitude is the only
 * thing in the file, and the colour is chosen here, where the room is known.
 * The ramp is a three-stop gradient from the Japanese palette, which is the
 * same grammar the rest of the product is drawn in -- a matplotlib colour map
 * baked into the PNG could never be restyled, and no amount of it would look
 * like this application.
 */
/* The ramp is walked with a gamma above 1 so the middle of the range stays
   dark. Straight through, ordinary programme material sits around mid grey
   and the whole picture came out one flat wash of the middle stop: the
   loudest parts of a mix have to earn the bright end for the picture to say
   anything about where the energy is. */
const SPECTROGRAM_GAMMA = 1.7;

export const spectrogramLut = (
  stops: readonly [string, string, string],
): Uint8ClampedArray => {
  const rgb = stops.map(hexToRgb);
  const table = new Uint8ClampedArray(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const t = Math.pow(index / 255, SPECTROGRAM_GAMMA);
    const [from, to, local] =
      t < 0.5
        ? [rgb[0] as RGB, rgb[1] as RGB, t * 2]
        : [rgb[1] as RGB, rgb[2] as RGB, (t - 0.5) * 2];
    table[index * 3] = from[0] + (to[0] - from[0]) * local;
    table[index * 3 + 1] = from[1] + (to[1] - from[1]) * local;
    table[index * 3 + 2] = from[2] + (to[2] - from[2]) * local;
  }
  return table;
};

type RGB = [number, number, number];

export const hexToRgb = (hex: string): RGB => {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
};

/**
 * Recolour a greyscale spectrogram in place. The source's red channel carries
 * the amplitude (it is grey, so all three agree); alpha is left alone.
 */
export const colorizeSpectrogram = (
  pixels: Uint8ClampedArray,
  lut: Uint8ClampedArray,
): void => {
  for (let at = 0; at < pixels.length; at += 4) {
    const level = pixels[at] ?? 0;
    pixels[at] = lut[level * 3] ?? 0;
    pixels[at + 1] = lut[level * 3 + 1] ?? 0;
    pixels[at + 2] = lut[level * 3 + 2] ?? 0;
  }
};
