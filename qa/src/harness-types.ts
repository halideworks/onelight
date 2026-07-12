/* Types shared between the browser harness bundle and the Playwright specs
   that drive it via page.evaluate. */

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

export interface QaHarness {
  loadClip(url: string, rate: HarnessRate): Promise<void>;
  seekAndRead(frame: number): Promise<SeekReading>;
  webcodecsRead(
    url: string,
    rate: HarnessRate,
    frame: number,
  ): Promise<WebCodecsReading>;
  readPatches(rects: PatchRect[]): Promise<PatchReading[]>;
}

declare global {
  interface Window {
    qa: QaHarness;
  }
}
