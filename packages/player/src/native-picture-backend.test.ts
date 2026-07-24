import { describe, expect, it, vi } from "vitest";
import { NativePictureBackend } from "./native-picture-backend.js";
import type { SourceContract } from "./picture-backend.js";

class FakeVideo extends EventTarget {
  currentSrc = "";
  currentTime = 0;
  playbackRate = 1;
  preservesPitch = true;
  readyState = 1;
  src = "";
  load = vi.fn();
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());
}

const source: SourceContract = {
  url: "/proxy.mp4",
  expected: {
    frameRate: { num: 24_000, den: 1_001 },
    durationFrames: 240,
    codedWidth: 1920,
    codedHeight: 1080,
    codec: "avc1.640028",
    outputColor: {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      range: "tv",
    },
    outputChromaLocation: "left",
  },
};

describe("native picture backend", () => {
  it("loads, seeks inside the exact rational frame, and plays", async () => {
    const video = new FakeVideo();
    const backend = new NativePictureBackend({
      element: () => video,
    });
    await backend.load(source, 24);
    expect(video.src).toBe("/proxy.mp4");
    expect(video.load).toHaveBeenCalledOnce();
    expect(video.currentTime).toBeCloseTo(((24 + 0.25) * 1_001) / 24_000, 10);

    backend.play(48, 4);
    expect(video.currentTime).toBeCloseTo(((48 + 0.25) * 1_001) / 24_000, 10);
    expect(video.playbackRate).toBe(4);
    expect(video.preservesPitch).toBe(false);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it("restores native rate and pitch state when paused or closed", async () => {
    const video = new FakeVideo();
    const backend = new NativePictureBackend({
      element: () => video,
    });
    await backend.load(source, 0);
    backend.play(0, 2);
    backend.close();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.playbackRate).toBe(1);
    expect(video.preservesPitch).toBe(true);
  });

  it("reports a rejected native play without throwing from transport", async () => {
    const video = new FakeVideo();
    const rejected = new Error("blocked");
    video.play.mockRejectedValueOnce(rejected);
    const onPlayRejected = vi.fn();
    const backend = new NativePictureBackend({
      element: () => video,
      onPlayRejected,
    });
    await backend.load(source, 0);
    backend.play(0, 1);
    await Promise.resolve();
    expect(onPlayRejected).toHaveBeenCalledWith(rejected);
  });
});
