/* Waveform peak data: the sidecar an audio asset is drawn from.
 *
 * The pre-rendered showwavespic PNG the pipeline used to make is an image of a
 * waveform, not a waveform: it cannot be zoomed, it cannot be recoloured for
 * the two visual worlds, its resolution is whatever the render was, and the
 * player cannot ask it what the level is at a given frame. Peak DATA can do
 * all four, so audio assets carry this instead and the PNG lane is only a
 * fallback for versions transcoded before the change.
 *
 * The container is the BBC audiowaveform .dat format, version 2, which is
 * what the design doc names and what peaks.js reads. Keeping to a published
 * format means a self-hoster can generate the sidecar with audiowaveform
 * itself, or read ours with any tool that already speaks it, and it costs
 * nothing over a bespoke layout:
 *
 *   int32   version        2
 *   uint32  flags          bit 0 set = 8-bit samples, clear = 16-bit
 *   int32   sample_rate    Hz of the decoded audio
 *   int32   samples_per_pixel   how many input samples one min/max pair covers
 *   uint32  length         number of min/max pairs per channel
 *   int32   channels       1 or 2 (version 2 only)
 *   data    length * channels * 2 samples, little-endian, interleaved as
 *           min(ch0) max(ch0) min(ch1) max(ch1) ... per point
 *
 * Everything here is little-endian, which is what the format specifies and
 * what every machine that will run this is.
 */

const HEADER_BYTES = 24;
const VERSION = 2;
const FLAG_8BIT = 1;

export interface PeaksData {
  /** Sample rate of the decoded audio the peaks were measured from. */
  sampleRate: number;
  /** Input samples covered by one min/max pair. */
  samplesPerPixel: number;
  /** 1 for mono, 2 for stereo (any wider mix is folded to stereo upstream). */
  channels: number;
  /** Number of min/max pairs per channel. */
  length: number;
  /**
   * Interleaved min/max pairs, normalized to -1..1 rather than left as raw
   * PCM: the player draws a shape, and normalized floats keep the drawing
   * code free of the 8/16-bit distinction the file carries.
   */
  samples: Float32Array;
}

const peakIndex = (point: number, channel: number, channels: number): number =>
  (point * channels + channel) * 2;

/** Minimum of one channel at one point, in -1..1. */
export const peakMin = (data: PeaksData, point: number, channel = 0): number =>
  data.samples[peakIndex(point, channel, data.channels)] ?? 0;

/** Maximum of one channel at one point, in -1..1. */
export const peakMax = (data: PeaksData, point: number, channel = 0): number =>
  data.samples[peakIndex(point, channel, data.channels) + 1] ?? 0;

/** Seconds of audio the sidecar covers. */
export const peaksDuration = (data: PeaksData): number =>
  data.sampleRate > 0
    ? (data.length * data.samplesPerPixel) / data.sampleRate
    : 0;

/**
 * Reduce peaks to `buckets` min/max pairs per channel, which is how the
 * player fits a whole track to a lane of pixels. Every input point inside a
 * bucket contributes, so a single-sample transient survives the reduction
 * instead of being missed by sampling.
 */
export const resamplePeaks = (
  data: PeaksData,
  buckets: number,
): Float32Array => {
  const out = new Float32Array(Math.max(0, buckets) * data.channels * 2);
  if (buckets <= 0 || data.length === 0) return out;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = Math.floor((bucket * data.length) / buckets);
    /* At least one source point per bucket: when the lane is wider than the
       data, buckets repeat rather than collapse to silence. */
    const to = Math.max(
      from + 1,
      Math.floor(((bucket + 1) * data.length) / buckets),
    );
    for (let channel = 0; channel < data.channels; channel += 1) {
      let low = 0;
      let high = 0;
      for (let point = from; point < to && point < data.length; point += 1) {
        const at = peakIndex(point, channel, data.channels);
        low = Math.min(low, data.samples[at] ?? 0);
        high = Math.max(high, data.samples[at + 1] ?? 0);
      }
      const target = peakIndex(bucket, channel, data.channels);
      out[target] = low;
      out[target + 1] = high;
    }
  }
  return out;
};

export const encodePeaks = (data: {
  sampleRate: number;
  samplesPerPixel: number;
  channels: number;
  length: number;
  samples: Float32Array;
}): Uint8Array => {
  const count = data.length * data.channels * 2;
  const bytes = new Uint8Array(HEADER_BYTES + count * 2);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, VERSION, true);
  view.setUint32(4, 0, true);
  view.setInt32(8, data.sampleRate, true);
  view.setInt32(12, data.samplesPerPixel, true);
  view.setUint32(16, data.length, true);
  view.setInt32(20, data.channels, true);
  for (let index = 0; index < count; index += 1) {
    const value = data.samples[index] ?? 0;
    /* -1 maps to -32768 and 1 to 32767: the asymmetry is the int16 range, and
       clamping both ends keeps a hot source from wrapping. */
    const scaled = Math.round(Math.min(1, Math.max(-1, value)) * 32767);
    view.setInt16(HEADER_BYTES + index * 2, scaled, true);
  }
  return bytes;
};

export const decodePeaks = (bytes: Uint8Array): PeaksData | null => {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getInt32(0, true);
  if (version !== 1 && version !== VERSION) return null;
  const flags = view.getUint32(4, true);
  const eightBit = (flags & FLAG_8BIT) === FLAG_8BIT;
  const sampleRate = view.getInt32(8, true);
  const samplesPerPixel = view.getInt32(12, true);
  const length = view.getUint32(16, true);
  /* Version 1 has no channel field and its data starts four bytes earlier. */
  const channels = version === VERSION ? view.getInt32(20, true) : 1;
  const dataStart = version === VERSION ? HEADER_BYTES : HEADER_BYTES - 4;
  if (
    sampleRate <= 0 ||
    samplesPerPixel <= 0 ||
    channels < 1 ||
    channels > 8 ||
    length === 0
  )
    return null;
  const count = length * channels * 2;
  const width = eightBit ? 1 : 2;
  /* A truncated file is read as far as it goes rather than refused: a partial
     waveform still tells a reviewer where the sound is. */
  const available = Math.max(
    0,
    Math.floor((bytes.byteLength - dataStart) / width),
  );
  const usable = Math.min(count, available);
  const samples = new Float32Array(count);
  for (let index = 0; index < usable; index += 1) {
    const at = dataStart + index * width;
    samples[index] = eightBit
      ? view.getInt8(at) / 128
      : view.getInt16(at, true) / 32768;
  }
  return { sampleRate, samplesPerPixel, channels, length, samples };
};
