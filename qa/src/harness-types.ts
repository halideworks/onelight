/* Types shared between the browser harness bundle and the Playwright specs
   that drive it via page.evaluate. */

import type { ColorSelfCheckResult } from "../../packages/player/src/color-self-check.js";
import type {
  ExpectedTrack,
  PlaneTransfer,
} from "../../packages/player/src/reference/protocol.js";

export interface HarnessRate {
  num: number;
  den: number;
}

export interface SeekReading {
  mediaTime: number;
  currentTime: number;
  /* Frame identity per the player's rVFC path (frameAtMediaTime). */
  rvfcFrame: number;
  /* Frame identity per the player's currentTime fallback path. */
  currentTimeFrame: number;
  /* Burned-in ground truth: frame mod 256 decoded from the pixel stripe. */
  stripeValue: number;
}

export interface WebCodecsReading {
  /* Presentation timestamp in seconds of the decoded VideoSample whose
     interval contains the seek target. */
  timestamp: number;
  /* frameAtMediaTime applied to that timestamp. */
  wcFrame: number;
  stripeValue: number;
}

export interface PatchRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PatchReading {
  name: string;
  rgb: [number, number, number];
}

export interface ReferenceRenderReadings {
  sourceFormat: PlaneTransfer["format"];
  i420: PatchReading[];
  nv12: PatchReading[];
}

export interface ShuttleAudioReading {
  currentTime: number;
  duration: number;
  playbackRate: number;
  preservesPitch: boolean;
  rms: number;
  dominantHz: number;
}

export interface ReferencePlaybackProbe {
  openMs: number;
  startupMs: number;
  elapsedMs: number;
  expectedFrames: number;
  requestedFrames: number;
  clockSkippedFrames: number;
  presentedFrames: number;
  lastPresentedFrame: number;
  droppedFrames: number;
  missingRequestedFrames: number[];
  maximumBufferedFrames: number;
  maximumLongTaskMs: number;
  seekP95Ms: number;
}

export interface ReferenceScrubProbe {
  elapsedMs: number;
  requestedFrames: number;
  presentedFrames: number;
  finalTargetFrame: number;
  finalPresentedFrame: number;
  settleMs: number;
  maximumPresentationGapMs: number;
  maximumBufferedFrames: number;
  maximumLongTaskMs: number;
}

export interface QaHarness {
  loadClip(url: string, rate: HarnessRate): Promise<void>;
  seekAndRead(frame: number): Promise<SeekReading>;
  seekForCanvas(frame: number): Promise<void>;
  webcodecsRead(
    url: string,
    rate: HarnessRate,
    frame: number,
  ): Promise<WebCodecsReading>;
  readPatches(rects: PatchRect[]): Promise<PatchReading[]>;
  renderReferenceVariants(
    planes: PlaneTransfer,
    rects: PatchRect[],
  ): Promise<ReferenceRenderReadings>;
  probeReferenceContextLoss(planes: PlaneTransfer): Promise<string>;
  probeShuttleAudio(
    url: string,
    playbackRate: number,
  ): Promise<ShuttleAudioReading>;
  probeReferencePlayback(
    workerUrl: string,
    clipUrl: string,
    expected: ExpectedTrack,
    durationMs: number,
    renderMode?: "hardware" | "software" | "none",
    playbackRate?: 1 | 2 | 4,
  ): Promise<ReferencePlaybackProbe>;
  probeReferenceScrub(
    workerUrl: string,
    clipUrl: string,
    expected: ExpectedTrack,
    durationMs: number,
    renderMode?: "hardware" | "software" | "none",
  ): Promise<ReferenceScrubProbe>;
  runColorSelfCheck(
    url: string,
    buildId: string,
  ): Promise<ColorSelfCheckResult>;
}

declare global {
  interface Window {
    qa: QaHarness;
    shuttleAudioProbe: Promise<ShuttleAudioReading> | undefined;
  }
}
