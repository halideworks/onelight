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
import { ReferenceGlRenderer } from "../../packages/player/src/reference/gl-renderer.js";
import { ReferencePictureBackend } from "../../packages/player/src/reference/reference-backend.js";
import type {
  ExpectedTrack,
  PlaneTransfer,
} from "../../packages/player/src/reference/protocol.js";
import { configurePlaybackRate } from "../../packages/player/src/transport-state.js";
import { decodeStripe } from "./stripe.js";
import type {
  HarnessRate,
  PatchReading,
  PatchRect,
  QaHarness,
  ReferenceRenderReadings,
  ReferencePlaybackProbe,
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

const seekForCanvas = (frame: number): Promise<void> => {
  if (typeof video.requestVideoFrameCallback === "function")
    return seekAndRead(frame).then(() => undefined);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = (): void => {
      cleanup();
      const deadline = performance.now() + 15_000;
      const poll = (): void => {
        const image = drawVideoFrame();
        for (let offset = 0; offset < image.data.length; offset += 4)
          if (
            (image.data[offset] ?? 0) > 0 ||
            (image.data[offset + 1] ?? 0) > 0 ||
            (image.data[offset + 2] ?? 0) > 0
          ) {
            video.pause();
            resolve();
            return;
          }
        if (performance.now() >= deadline) {
          video.pause();
          reject(
            new Error(`video frame stayed black for frame ${String(frame)}`),
          );
          return;
        }
        setTimeout(poll, 8);
      };
      void video.play().then(poll, (error: unknown) => {
        video.pause();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`video seek failed for frame ${String(frame)}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`seeked did not fire for frame ${String(frame)}`));
    }, 15_000);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = mediaTimeInsideFrame(frame, rate);
  });
};

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
  return Promise.resolve(readPatchesFromImage(image, rects));
};

const readPatchesFromImage = (
  image: ImageData,
  rects: PatchRect[],
): PatchReading[] =>
  rects.map((rect) => {
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

const tightPlane = (
  source: PlaneTransfer,
  plane: number,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array => {
  const layout = source.layout[plane];
  if (!layout) throw new Error(`Reference plane ${plane} is missing.`);
  const result = new Uint8Array(width * height * bytesPerPixel);
  const input = new Uint8Array(source.buffer);
  const rowBytes = width * bytesPerPixel;
  for (let row = 0; row < height; row += 1) {
    const start = layout.offset + row * layout.stride;
    result.set(input.subarray(start, start + rowBytes), row * rowBytes);
  }
  return result;
};

const referenceVariants = (
  source: PlaneTransfer,
): { i420: PlaneTransfer; nv12: PlaneTransfer } => {
  const width = source.codedRect.width;
  const height = source.codedRect.height;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const y = tightPlane(source, 0, width, height, 1);
  let u: Uint8Array;
  let v: Uint8Array;
  if (source.format === "I420") {
    u = tightPlane(source, 1, chromaWidth, chromaHeight, 1);
    v = tightPlane(source, 2, chromaWidth, chromaHeight, 1);
  } else {
    const uv = tightPlane(source, 1, chromaWidth, chromaHeight, 2);
    u = new Uint8Array(chromaWidth * chromaHeight);
    v = new Uint8Array(chromaWidth * chromaHeight);
    for (let index = 0; index < u.length; index += 1) {
      u[index] = uv[index * 2] ?? 128;
      v[index] = uv[index * 2 + 1] ?? 128;
    }
  }

  const i420Buffer = new Uint8Array(y.length + u.length + v.length);
  i420Buffer.set(y, 0);
  i420Buffer.set(u, y.length);
  i420Buffer.set(v, y.length + u.length);
  const nv12Buffer = new Uint8Array(y.length + u.length * 2);
  nv12Buffer.set(y, 0);
  for (let index = 0; index < u.length; index += 1) {
    nv12Buffer[y.length + index * 2] = u[index] ?? 128;
    nv12Buffer[y.length + index * 2 + 1] = v[index] ?? 128;
  }

  return {
    i420: {
      ...source,
      format: "I420",
      buffer: i420Buffer.buffer,
      layout: [
        { offset: 0, stride: width },
        { offset: y.length, stride: chromaWidth },
        { offset: y.length + u.length, stride: chromaWidth },
      ],
    },
    nv12: {
      ...source,
      format: "NV12",
      buffer: nv12Buffer.buffer,
      layout: [
        { offset: 0, stride: width },
        { offset: y.length, stride: chromaWidth * 2 },
      ],
    },
  };
};

const referenceCanvas = document.createElement("canvas");
let referenceRenderer: ReferenceGlRenderer | undefined;

const renderReference = (
  planes: PlaneTransfer,
  rects: PatchRect[],
): PatchReading[] => {
  referenceRenderer ??= new ReferenceGlRenderer(referenceCanvas, {
    requireAcceleration: false,
  });
  referenceRenderer.render(planes);
  canvas.width = referenceCanvas.width;
  canvas.height = referenceCanvas.height;
  context.drawImage(referenceCanvas, 0, 0);
  return readPatchesFromImage(
    context.getImageData(0, 0, canvas.width, canvas.height),
    rects,
  );
};

const renderReferenceVariants = (
  planes: PlaneTransfer,
  rects: PatchRect[],
): Promise<ReferenceRenderReadings> => {
  const variants = referenceVariants(planes);
  return Promise.resolve({
    sourceFormat: planes.format,
    i420: renderReference(variants.i420, rects),
    nv12: renderReference(variants.nv12, rects),
  });
};

const probeReferenceContextLoss = (planes: PlaneTransfer): Promise<string> => {
  const lossCanvas = document.createElement("canvas");
  const lossRenderer = new ReferenceGlRenderer(lossCanvas, {
    requireAcceleration: false,
  });
  const extension = lossRenderer.gl.getExtension("WEBGL_lose_context");
  if (!extension) {
    lossRenderer.close();
    return Promise.resolve("WEBGL_lose_context is unavailable.");
  }
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      lossRenderer.close();
      reject(new Error("Reference context-loss event timed out."));
    }, 3_000);
    lossCanvas.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        window.clearTimeout(timer);
        try {
          lossRenderer.render(planes);
          reject(
            new Error("Reference rendering continued after context loss."),
          );
        } catch (error) {
          resolve(error instanceof Error ? error.message : String(error));
        } finally {
          lossRenderer.close();
        }
      },
      { once: true },
    );
    extension.loseContext();
  });
};

/*
 * Browser-native patch reads stay separate from reference rendering. The
 * latter only draws an already rendered sRGB canvas into this 2D readback
 * canvas, so no browser YUV conversion re-enters the reference path.
 */

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

const percentile95 = (values: readonly number[]): number => {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return (
    ordered[
      Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)
    ] ?? 0
  );
};

const probeReferencePlayback = async (
  workerUrl: string,
  clipUrl: string,
  expected: ExpectedTrack,
  durationMs: number,
  renderMode: "hardware" | "software" | "none" = "hardware",
  playbackRate: 1 | 2 | 4 = 1,
): Promise<ReferencePlaybackProbe> => {
  let maximumBufferedFrames = 0;
  let maximumLongTaskMs = 0;
  const presented = new Set<number>();
  const requestedFrames = new Set<number>();
  const requestedAt = new Map<number, number>();
  const latencies: number[] = [];
  let firstFrameResolve: (() => void) | null = null;
  let failureReject: ((reason: Error) => void) | null = null;
  let terminalFailure: Error | null = null;
  const firstFrame = new Promise<void>((resolve, reject) => {
    firstFrameResolve = resolve;
    failureReject = reject;
  });
  let renderer: ReferenceGlRenderer | null = null;
  const observer =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            maximumLongTaskMs = Math.max(maximumLongTaskMs, entry.duration);
        })
      : null;
  const backend = new ReferencePictureBackend(
    {
      render: (planes) => {
        if (renderMode === "none") return;
        renderer ??= new ReferenceGlRenderer(referenceCanvas, {
          requireAcceleration: renderMode === "hardware",
        });
        renderer.render(planes);
      },
      onFrame: (frame) => {
        presented.add(frame);
        maximumBufferedFrames = Math.max(
          maximumBufferedFrames,
          backend.bufferedFrames.length,
        );
        const requested = requestedAt.get(frame);
        if (requested !== undefined) {
          latencies.push(performance.now() - requested);
          requestedAt.delete(frame);
        }
        firstFrameResolve?.();
        firstFrameResolve = null;
      },
      onFailure: (failure) => {
        terminalFailure = new Error(
          `${failure.reason} Requested [${[...requestedFrames].join(",")}]. Presented [${[...presented].sort((left, right) => left - right).join(",")}].`,
        );
        failureReject?.(terminalFailure);
        failureReject = null;
      },
    },
    {
      workerFactory: () => new Worker(workerUrl, { type: "module" }),
      starvationMs: 1_500,
    },
  );
  try {
    await backend.load({ url: clipUrl, expected }, 0);
    await firstFrame;
    await backend.waitUntilBuffered(0);
    observer?.observe({ entryTypes: ["longtask"] });
    backend.play(0, playbackRate);
    const started = performance.now();
    let lastRequested = -1;
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const elapsed = performance.now() - started;
        const target = Math.min(
          (expected.durationFrames ?? Number.MAX_SAFE_INTEGER) - 1,
          Math.floor(
            ((elapsed * expected.frameRate.num) /
              (1000 * expected.frameRate.den)) *
              playbackRate,
          ),
        );
        if (target !== lastRequested) {
          lastRequested = target;
          requestedFrames.add(target);
          requestedAt.set(target, performance.now());
          backend.seek(target);
        }
        if (elapsed >= durationMs) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsedMs = performance.now() - started;
    if (terminalFailure) throw new Error(String(terminalFailure));
    const expectedFrames = Math.max(1, lastRequested + 1);
    const missingRequestedFrames = [...requestedFrames].filter(
      (frame) => !presented.has(frame),
    );
    return {
      elapsedMs,
      expectedFrames,
      requestedFrames: requestedFrames.size,
      clockSkippedFrames: Math.max(0, expectedFrames - requestedFrames.size),
      presentedFrames: presented.size,
      lastPresentedFrame: Math.max(-1, ...presented),
      droppedFrames: missingRequestedFrames.length,
      missingRequestedFrames,
      maximumBufferedFrames,
      maximumLongTaskMs,
      seekP95Ms: percentile95(latencies),
    };
  } finally {
    observer?.disconnect();
    backend.close();
    (renderer as ReferenceGlRenderer | null)?.close();
  }
};

const harness: QaHarness = {
  loadClip,
  seekAndRead,
  seekForCanvas,
  webcodecsRead,
  readPatches,
  renderReferenceVariants,
  probeReferenceContextLoss,
  probeShuttleAudio,
  probeReferencePlayback,
  runColorSelfCheck: (url, buildId) =>
    runColorSelfCheck({
      buildId,
      clipUrl: url,
      clipHash: COLOR_SELF_CHECK_CLIP_SHA256,
      storage: null,
    }),
};
window.qa = harness;
