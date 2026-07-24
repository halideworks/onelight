import { stat } from "node:fs/promises";
import path from "node:path";
import { chromium, firefox } from "playwright";
import type { BrowserType } from "playwright";
import {
  MAX_OPEN_FRAMES,
  referenceFrameAtTimestamp,
  type ExpectedTrack,
} from "../../packages/player/src/reference/protocol.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  artifactsDir,
  harnessDir,
  readEnvironment,
  skipReason,
} from "./capabilities.js";
import type { FixtureManifest, RateClipFixture } from "./fixtures.js";
import { readManifest } from "./fixtures.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const env = readEnvironment();
const fixtureReason = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (fixtureReason)
  console.log(`[qa] reference decoder: skipped (${fixtureReason})`);

const engines: Array<{
  name: "chromium" | "firefox";
  type: BrowserType;
}> = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
];

type FrameSummary = {
  type: "frame";
  generation: number;
  frame: number;
  format: string;
  timestampUs: number;
  bufferBytes: number;
};

type EventSummary =
  | FrameSummary
  | {
      type: "ready" | "stalled" | "unsupported" | "error";
      generation: number;
      frame?: number;
      reason?: string;
    };

const expectedFor = (clip: RateClipFixture): ExpectedTrack => ({
  frameRate: clip.rate,
  durationFrames: clip.frames,
  codedWidth: 1280,
  codedHeight: 720,
  codec: null,
  outputColor: {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    range: "tv",
  },
});

describe.skipIf(fixtureReason !== undefined)(
  "reference decoder worker prototype",
  () => {
    let manifest: FixtureManifest;
    let server: StaticServer;

    beforeAll(async () => {
      manifest = await readManifest();
      server = await startStaticServer(artifactsDir);
    });

    afterAll(async () => {
      await server?.close();
    });

    it("stays in a separately loaded bundle below 512 KiB", async () => {
      const worker = await stat(
        path.join(harnessDir, "reference-decoder.worker.js"),
      );
      expect(worker.size).toBeLessThan(512 * 1024);
    });

    for (const engine of engines) {
      const browserReason = fixtureReason
        ? undefined
        : skipReason(env, [engine.name]);
      if (!fixtureReason && browserReason)
        console.log(
          `[qa] reference decoder ${engine.name}: skipped (${browserReason})`,
        );

      it.skipIf(browserReason !== undefined)(
        engine.name === "firefox" && process.platform === "win32"
          ? "firefox on Windows reports the exact raw-plane blocker"
          : `${engine.name} preserves timestamps, cancels stale generations, and caps the frame window`,
        async () => {
          const clip = manifest.rateClips[0];
          if (!clip) throw new Error("Reference decoder fixture is missing.");
          const expectsRawPlanes = !(
            engine.name === "firefox" && process.platform === "win32"
          );
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            const events = await page.evaluate(
              ([workerUrl, clipUrl, expected, rawPlanesExpected]) =>
                new Promise<EventSummary[]>((resolve, reject) => {
                  const worker = new Worker(workerUrl, { type: "module" });
                  const summaries: EventSummary[] = [];
                  let cancellationStarted = false;
                  const timer = setTimeout(() => {
                    worker.terminate();
                    reject(new Error("Reference decoder worker timed out."));
                  }, 15_000);
                  const finish = (): void => {
                    clearTimeout(timer);
                    worker.postMessage({ type: "close", generation: 5 });
                    worker.terminate();
                    resolve(summaries);
                  };
                  worker.onerror = (event) => {
                    clearTimeout(timer);
                    worker.terminate();
                    reject(new Error(event.message));
                  };
                  worker.onmessage = (
                    event: MessageEvent<
                      | {
                          type: "ready";
                          generation: number;
                        }
                      | {
                          type: "frame";
                          generation: number;
                          frame: number;
                          planes: {
                            format: string;
                            timestampUs: number;
                            buffer: ArrayBuffer;
                          };
                        }
                      | {
                          type: "stalled" | "unsupported" | "error";
                          generation: number;
                          frame?: number;
                          reason?: string;
                        }
                    >,
                  ) => {
                    const message = event.data;
                    if (message.type === "frame")
                      summaries.push({
                        type: "frame",
                        generation: message.generation,
                        frame: message.frame,
                        format: message.planes.format,
                        timestampUs: message.planes.timestampUs,
                        bufferBytes: message.planes.buffer.byteLength,
                      });
                    else summaries.push({ ...message });

                    if (message.type === "ready" && message.generation === 1)
                      worker.postMessage({
                        type: "seek",
                        generation: 2,
                        frame: 17,
                      });
                    if (
                      message.type === "frame" &&
                      message.generation === 2 &&
                      message.frame === 17 &&
                      !cancellationStarted
                    ) {
                      cancellationStarted = true;
                      worker.postMessage({
                        type: "play",
                        generation: 3,
                        frame: 80,
                        rate: 4,
                      });
                      worker.postMessage({
                        type: "seek",
                        generation: 4,
                        frame: 5,
                      });
                    }
                    if (
                      message.type === "frame" &&
                      message.generation === 4 &&
                      message.frame === 5
                    )
                      setTimeout(finish, 50);
                    if (
                      (message.type === "error" ||
                        message.type === "unsupported") &&
                      (message.generation === 1 ||
                        message.generation === 2 ||
                        message.generation === 4)
                    ) {
                      if (
                        !rawPlanesExpected &&
                        message.type === "unsupported" &&
                        message.generation === 2
                      ) {
                        finish();
                        return;
                      }
                      clearTimeout(timer);
                      worker.terminate();
                      reject(
                        new Error(
                          `${message.type}: ${message.reason ?? "unknown"}`,
                        ),
                      );
                    }
                  };
                  worker.postMessage({
                    type: "open",
                    generation: 1,
                    url: clipUrl,
                    expected,
                  });
                }),
              [
                `${server.baseUrl}/harness/reference-decoder.worker.js`,
                `${server.baseUrl}/fixtures/${clip.file}`,
                expectedFor(clip),
                expectsRawPlanes,
              ] as const,
            );

            if (!expectsRawPlanes) {
              expect(events).toContainEqual({
                type: "unsupported",
                generation: 2,
                reason: "Decoded pixel format BGRX is not I420 or NV12.",
              });
              expect(events.some((event) => event.type === "frame")).toBe(
                false,
              );
              return;
            }

            const framesByGeneration = (generation: number): FrameSummary[] =>
              events.filter(
                (event): event is FrameSummary =>
                  event.type === "frame" && event.generation === generation,
              );
            const firstWindow = framesByGeneration(2);
            const replacementWindow = framesByGeneration(4);
            expect(firstWindow.length).toBeLessThanOrEqual(MAX_OPEN_FRAMES);
            expect(replacementWindow.length).toBeLessThanOrEqual(
              MAX_OPEN_FRAMES,
            );
            expect(firstWindow.some((event) => event.frame === 17)).toBe(true);
            expect(replacementWindow.some((event) => event.frame === 5)).toBe(
              true,
            );
            expect(events.some((event) => event.generation === 3)).toBe(false);

            for (const event of [...firstWindow, ...replacementWindow]) {
              expect(["I420", "NV12"]).toContain(event.format);
              expect(event.bufferBytes).toBeGreaterThan(0);
              expect(
                referenceFrameAtTimestamp(event.timestampUs, 0, clip.rate),
              ).toBe(event.frame);
            }
          } finally {
            await browser.close();
          }
        },
      );
    }
  },
);
