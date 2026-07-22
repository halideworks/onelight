import { describe, expect, it } from "vitest";
import {
  decodePeaks,
  encodePeaks,
  peakMax,
  peakMin,
  peaksDuration,
  resamplePeaks,
} from "./peaks.js";

const stereo = {
  sampleRate: 48000,
  samplesPerPixel: 256,
  channels: 2,
  length: 3,
  /* point 0: L -0.5..0.5  R -0.25..0.75
     point 1: L -1..1      R 0..0
     point 2: L -0.1..0.2  R -0.9..0.9 */
  samples: new Float32Array([
    -0.5, 0.5, -0.25, 0.75, -1, 1, 0, 0, -0.1, 0.2, -0.9, 0.9,
  ]),
};

describe("waveform peak sidecars", () => {
  it("round-trips a stereo sidecar through the .dat container", () => {
    const decoded = decodePeaks(encodePeaks(stereo));
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.sampleRate).toBe(48000);
    expect(decoded.samplesPerPixel).toBe(256);
    expect(decoded.channels).toBe(2);
    expect(decoded.length).toBe(3);
    for (let point = 0; point < 3; point += 1)
      for (const channel of [0, 1]) {
        expect(peakMin(decoded, point, channel)).toBeCloseTo(
          stereo.samples[(point * 2 + channel) * 2] ?? 0,
          4,
        );
        expect(peakMax(decoded, point, channel)).toBeCloseTo(
          stereo.samples[(point * 2 + channel) * 2 + 1] ?? 0,
          4,
        );
      }
  });

  it("writes the documented version 2 header", () => {
    const bytes = encodePeaks(stereo);
    const view = new DataView(bytes.buffer);
    expect(view.getInt32(0, true)).toBe(2);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getInt32(8, true)).toBe(48000);
    expect(view.getInt32(12, true)).toBe(256);
    expect(view.getUint32(16, true)).toBe(3);
    expect(view.getInt32(20, true)).toBe(2);
    expect(bytes.byteLength).toBe(24 + 3 * 2 * 2 * 2);
  });

  it("clamps hot samples instead of wrapping them", () => {
    const decoded = decodePeaks(
      encodePeaks({
        sampleRate: 44100,
        samplesPerPixel: 512,
        channels: 1,
        length: 1,
        samples: new Float32Array([-4, 4]),
      }),
    );
    expect(peakMin(decoded!, 0)).toBeCloseTo(-1, 4);
    expect(peakMax(decoded!, 0)).toBeCloseTo(1, 4);
  });

  it("reads an 8-bit sidecar, which is what audiowaveform -b 8 writes", () => {
    const bytes = new Uint8Array(24 + 2);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 2, true);
    view.setUint32(4, 1, true);
    view.setInt32(8, 44100, true);
    view.setInt32(12, 256, true);
    view.setUint32(16, 1, true);
    view.setInt32(20, 1, true);
    view.setInt8(24, -64);
    view.setInt8(25, 64);
    const decoded = decodePeaks(bytes);
    expect(peakMin(decoded!, 0)).toBeCloseTo(-0.5, 3);
    expect(peakMax(decoded!, 0)).toBeCloseTo(0.5, 3);
  });

  it("rejects a header that is not a waveform sidecar", () => {
    expect(decodePeaks(new Uint8Array(8))).toBeNull();
    const wrongVersion = encodePeaks(stereo);
    new DataView(wrongVersion.buffer).setInt32(0, 7, true);
    expect(decodePeaks(wrongVersion)).toBeNull();
  });

  it("reads a truncated sidecar as far as it goes", () => {
    const full = encodePeaks(stereo);
    const decoded = decodePeaks(full.slice(0, full.byteLength - 6));
    expect(decoded).not.toBeNull();
    expect(decoded?.length).toBe(3);
    expect(peakMin(decoded!, 0)).toBeCloseTo(-0.5, 4);
    /* The points the file lost read as silence rather than as noise. */
    expect(peakMin(decoded!, 2, 1)).toBe(0);
  });

  it("keeps transients when reducing to fewer buckets than points", () => {
    const source = {
      sampleRate: 48000,
      samplesPerPixel: 128,
      channels: 1,
      length: 4,
      samples: new Float32Array([0, 0.1, -1, 1, 0, 0.05, 0, 0.02]),
    };
    const reduced = resamplePeaks(source, 2);
    /* The spike at point 1 shares a bucket with point 0 and survives it. */
    expect(reduced[0]).toBeCloseTo(-1, 4);
    expect(reduced[1]).toBeCloseTo(1, 4);
    expect(reduced[2]).toBeCloseTo(0, 4);
    expect(reduced[3]).toBeCloseTo(0.05, 4);
  });

  it("repeats points rather than silencing them when the lane is wider than the data", () => {
    const source = {
      sampleRate: 48000,
      samplesPerPixel: 128,
      channels: 1,
      length: 2,
      samples: new Float32Array([-0.5, 0.5, -0.25, 0.25]),
    };
    const reduced = resamplePeaks(source, 6);
    expect(reduced.length).toBe(12);
    for (let bucket = 0; bucket < 6; bucket += 1)
      expect(reduced[bucket * 2 + 1]).toBeGreaterThan(0);
  });

  it("reports the running time the sidecar covers", () => {
    expect(peaksDuration({ ...stereo, length: 375 })).toBeCloseTo(2, 6);
  });
});
