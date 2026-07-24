/* Browser harness. Bundled by esbuild in global-setup, so the frame math
   below is the LITERAL packages/player/src/frame-clock.ts source, compiled
   into the page: there is no copied formula that can drift. */

import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from "mediabunny";
import {
  frameAtCurrentTime,
  frameAtMediaTime,
  mediaTimeInsideFrame,
} from "../../packages/player/src/frame-clock.js";
import {
  COLOR_SELF_CHECK_CLIP_SHA256,
  runColorSelfCheck,
} from "../../packages/player/src/color-self-check.js";
import { configurePlaybackRate } from "../../packages/player/src/transport-state.js";
import { decodeStripe } from "./stripe.js";
import type {
  HarnessRate,
  PatchReading,
  PatchRect,
  QaHarness,
  SeekReading,
  ShuttleAudioReading,
  WebCodecsReading,
} from "./harness-types.js";

const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const context = canvas.getContext("2d", { willReadFrequently: true });
if (!context) throw new Error("2d canvas context unavailable");

let rate: HarnessRate = { num: 24, den: 1 };

const drawVideoFrame = (): ImageData => {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
};

const loadClip = (url: string, clipRate: HarnessRate): Promise<void> =>
  new Promise((resolve, reject) => {
    rate = clipRate;
    video.onloadeddata = () => resolve();
    video.onerror = () =>
      reject(new Error(`video element failed to load ${url}`));
    video.src = url;
    video.load();
  });

/* Seek to the middle of the target frame exactly as the player's stepper
   does, then identify the presented frame from the next rVFC callback's
   mediaTime. The callback is registered BEFORE currentTime changes so the
   presentation triggered by the seek is never missed. Callers guarantee
   consecutive targets differ, so every seek presents a new frame. */
const seekAndRead = (frame: number): Promise<SeekReading> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`rVFC did not fire for frame ${frame}`)),
      15_000,
    );
    video.requestVideoFrameCallback((_now, metadata) => {
      clearTimeout(timer);
      const image = drawVideoFrame();
      resolve({
        mediaTime: metadata.mediaTime,
        currentTime: video.currentTime,
        rvfcFrame: frameAtMediaTime(metadata.mediaTime, rate),
        currentTimeFrame: frameAtCurrentTime(video.currentTime, rate),
        stripeValue: decodeStripe(image.data, image.width, image.height),
      });
    });
    video.currentTime = mediaTimeInsideFrame(frame, rate);
  });

/* WebCodecs path: mediabunny demuxes the MP4 and drives VideoDecoder; the
   sink returns the decoded frame whose presentation interval contains the
   requested timestamp. This is the design doc's ground truth: a decode-level
   frame identity with no <video> element in the loop. */
const sinks = new Map<string, Promise<VideoSampleSink>>();
const sinkFor = (url: string): Promise<VideoSampleSink> => {
  let pending = sinks.get(url);
  if (!pending) {
    pending = (async () => {
      const input = new Input({
        source: new UrlSource(url),
        formats: ALL_FORMATS,
      });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error(`no video track in ${url}`);
      if (!(await track.canDecode()))
        throw new Error(`WebCodecs cannot decode the video track in ${url}`);
      return new VideoSampleSink(track);
    })();
    sinks.set(url, pending);
  }
  return pending;
};

const offscreen = document.createElement("canvas");
const offscreenContext = offscreen.getContext("2d", {
  willReadFrequently: true,
});
if (!offscreenContext) throw new Error("2d canvas context unavailable");

const webcodecsRead = async (
  url: string,
  clipRate: HarnessRate,
  frame: number,
): Promise<WebCodecsReading> => {
  const sink = await sinkFor(url);
  const sample = await sink.getSample(mediaTimeInsideFrame(frame, clipRate));
  if (!sample) throw new Error(`no decoded sample for frame ${frame}`);
  try {
    offscreen.width = sample.displayWidth;
    offscreen.height = sample.displayHeight;
    sample.draw(offscreenContext, 0, 0);
    const image = offscreenContext.getImageData(
      0,
      0,
      offscreen.width,
      offscreen.height,
    );
    return {
      timestamp: sample.timestamp,
      wcFrame: frameAtMediaTime(sample.timestamp, clipRate),
      stripeValue: decodeStripe(image.data, image.width, image.height),
    };
  } finally {
    sample.close();
  }
};

const readPatches = (rects: PatchRect[]): Promise<PatchReading[]> => {
  const image = drawVideoFrame();
  const readings = rects.map((rect) => {
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 1)
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const offset = (y * image.width + x) * 4;
        red += image.data[offset] ?? 0;
        green += image.data[offset + 1] ?? 0;
        blue += image.data[offset + 2] ?? 0;
      }
    const count = rect.w * rect.h;
    return {
      name: rect.name,
      rgb: [
        Math.round(red / count),
        Math.round(green / count),
        Math.round(blue / count),
      ] as [number, number, number],
    };
  });
  return Promise.resolve(readings);
};

const waitForEvent = (
  target: EventTarget,
  event: string,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      target.removeEventListener(event, onEvent);
      reject(new Error(`${event} did not fire within ${timeoutMs} ms`));
    }, timeoutMs);
    const onEvent = (): void => {
      window.clearTimeout(timeout);
      resolve();
    };
    target.addEventListener(event, onEvent, { once: true });
  });

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const probeShuttleAudio = async (
  url: string,
  playbackRate: number,
): Promise<ShuttleAudioReading> => {
  const media = document.createElement("video");
  media.crossOrigin = "anonymous";
  media.src = url;
  media.preload = "auto";
  document.body.append(media);

  const audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(media);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 8192;
  source.connect(analyser);
  analyser.connect(audioContext.destination);
  const samples = new Float32Array(analyser.fftSize);
  const frequencyBins = new Float32Array(analyser.frequencyBinCount);

  try {
    const canPlay = waitForEvent(media, "canplay", 15_000);
    media.load();
    configurePlaybackRate(media, playbackRate, false);
    await Promise.all([canPlay, audioContext.resume(), media.play()]);

    let rms = 0;
    let dominantHz = 0;
    let dominantDb = Number.NEGATIVE_INFINITY;
    for (let sample = 0; sample < 8; sample += 1) {
      await wait(50);
      analyser.getFloatTimeDomainData(samples);
      let sumSquares = 0;
      for (const value of samples) sumSquares += value * value;
      rms = Math.max(rms, Math.sqrt(sumSquares / samples.length));
      analyser.getFloatFrequencyData(frequencyBins);
      for (let bin = 1; bin < frequencyBins.length; bin += 1) {
        const db = frequencyBins[bin] ?? Number.NEGATIVE_INFINITY;
        if (db > dominantDb) {
          dominantDb = db;
          dominantHz = (bin * audioContext.sampleRate) / analyser.fftSize;
        }
      }
    }

    return {
      currentTime: media.currentTime,
      duration: media.duration,
      playbackRate: media.playbackRate,
      preservesPitch: media.preservesPitch,
      rms,
      dominantHz,
    };
  } finally {
    media.pause();
    media.remove();
    source.disconnect();
    analyser.disconnect();
    await audioContext.close();
  }
};

const harness: QaHarness = {
  loadClip,
  seekAndRead,
  webcodecsRead,
  readPatches,
  probeShuttleAudio,
  runColorSelfCheck: (url, buildId) =>
    runColorSelfCheck({
      buildId,
      clipUrl: url,
      clipHash: COLOR_SELF_CHECK_CLIP_SHA256,
      storage: null,
    }),
};
window.qa = harness;
