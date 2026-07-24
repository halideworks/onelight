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
      type: "opening" | "ready" | "stalled" | "unsupported" | "error";
      generation: number;
      frame?: number;
      reason?: string;
    };

type PreferenceProbe = {
  preference: "no-preference" | "prefer-hardware" | "prefer-software";
  readyPreference?: string | undefined;
  result: "raw" | "unsupported";
  format?: string;
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
  outputChromaLocation: "left",
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
        `${engine.name} records the native decoder plane format by acceleration preference`,
        async () => {
          const clip = manifest.rateClips[0];
          if (!clip) throw new Error("Reference decoder fixture is missing.");
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            const probes = await page.evaluate(
              async ([workerUrl, clipUrl, expected]) => {
                const preferences = [
                  "no-preference",
                  "prefer-hardware",
                  "prefer-software",
                ] as const;
                const results: PreferenceProbe[] = [];
                for (const preference of preferences) {
                  const result = await new Promise<PreferenceProbe>(
                    (resolve, reject) => {
                      const worker = new Worker(workerUrl, { type: "module" });
                      let readyPreference: string | undefined;
                      const timer = setTimeout(() => {
                        worker.terminate();
                        reject(
                          new Error(
                            `Reference decoder ${preference} probe timed out.`,
                          ),
                        );
                      }, 15_000);
                      const finish = (probe: PreferenceProbe): void => {
                        clearTimeout(timer);
                        worker.postMessage({ type: "close", generation: 3 });
                        worker.terminate();
                        resolve(probe);
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
                              track: { decoderPreference: string };
                            }
                          | {
                              type: "frame";
                              generation: number;
                              planes: { format: string };
                            }
                          | {
                              type: "unsupported" | "error";
                              generation: number;
                              reason: string;
                            }
                        >,
                      ) => {
                        const message = event.data;
                        if (
                          message.type === "ready" &&
                          message.generation === 1
                        ) {
                          readyPreference = message.track.decoderPreference;
                          worker.postMessage({
                            type: "seek",
                            generation: 2,
                            frame: 17,
                          });
                        } else if (
                          message.type === "frame" &&
                          message.generation === 2
                        )
                          finish({
                            preference,
                            readyPreference,
                            result: "raw",
                            format: message.planes.format,
                          });
                        else if (message.type === "unsupported")
                          finish({
                            preference,
                            readyPreference,
                            result: "unsupported",
                            reason: message.reason,
                          });
                        else if (message.type === "error") {
                          clearTimeout(timer);
                          worker.terminate();
                          reject(new Error(message.reason));
                        }
                      };
                      worker.postMessage({
                        type: "open",
                        generation: 1,
                        url: clipUrl,
                        expected,
                        hardwareAcceleration: preference,
                      });
                    },
                  );
                  results.push(result);
                }
                return results;
              },
              [
                `${server.baseUrl}/harness/reference-decoder.worker.js`,
                `${server.baseUrl}/fixtures/${clip.file}`,
                expectedFor(clip),
              ] as const,
            );

            console.log(
              `[qa] reference decoder ${engine.name} preferences: ${probes
                .map(
                  (probe) =>
                    `${probe.preference}=${probe.format ?? probe.reason ?? probe.result}`,
                )
                .join(", ")}`,
            );
            expect(probes.map((probe) => probe.preference)).toEqual([
              "no-preference",
              "prefer-hardware",
              "prefer-software",
            ]);
            for (const probe of probes) {
              if (probe.readyPreference)
                expect(probe.readyPreference).toBe(probe.preference);
              if (probe.result === "raw")
                expect(["I420", "NV12"]).toContain(probe.format);
            }

            if (engine.name === "firefox" && process.platform === "win32") {
              expect(probes).toEqual([
                {
                  preference: "no-preference",
                  readyPreference: "no-preference",
                  result: "unsupported",
                  reason: "Decoded pixel format BGRX is not I420 or NV12.",
                },
                {
                  preference: "prefer-hardware",
                  readyPreference: "prefer-hardware",
                  result: "unsupported",
                  reason: "Decoded pixel format BGRX is not I420 or NV12.",
                },
                {
                  preference: "prefer-software",
                  readyPreference: "prefer-software",
                  result: "unsupported",
                  reason: "Decoded pixel format BGRX is not I420 or NV12.",
                },
              ]);
            } else {
              expect(probes.some((probe) => probe.result === "raw")).toBe(true);
            }
          } finally {
            await browser.close();
          }
        },
      );

      it.skipIf(browserReason !== undefined)(
        engine.name === "firefox" && process.platform === "win32"
          ? "firefox on Windows reports the exact raw-plane blocker"
          : `${engine.name} preserves timestamps, cancels stale generations, and caps the frame window`,
        async () => {
          const clip = manifest.rateClips[0];
          const replacement = manifest.rateClips[1];
          if (!clip) throw new Error("Reference decoder fixture is missing.");
          if (!replacement)
            throw new Error(
              "Reference decoder replacement fixture is missing.",
            );
          const expectsRawPlanes = !(
            engine.name === "firefox" && process.platform === "win32"
          );
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            const events = await page.evaluate(
              ([
                workerUrl,
                clipUrl,
                expected,
                replacementUrl,
                replacementExpected,
                rawPlanesExpected,
              ]) =>
                new Promise<EventSummary[]>((resolve, reject) => {
                  const worker = new Worker(workerUrl, { type: "module" });
                  const summaries: EventSummary[] = [];
                  let cancellationStarted = false;
                  let sourceSwapStarted = false;
                  const finalStormGeneration = 22;
                  const finalStormFrame = 5;
                  const timer = setTimeout(() => {
                    worker.terminate();
                    reject(new Error("Reference decoder worker timed out."));
                  }, 15_000);
                  const finish = (): void => {
                    clearTimeout(timer);
                    worker.postMessage({ type: "close", generation: 40 });
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
                          type: "opening" | "ready";
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
                      for (
                        let generation = 3;
                        generation <= finalStormGeneration;
                        generation += 1
                      )
                        worker.postMessage({
                          type:
                            generation % 4 === 0
                              ? ("play" as const)
                              : ("seek" as const),
                          generation,
                          frame:
                            generation === finalStormGeneration
                              ? finalStormFrame
                              : (generation * 13) %
                                Math.max(1, expected.durationFrames ?? 1),
                          ...(generation % 4 === 0 ? { rate: 4 as const } : {}),
                        });
                    }
                    if (
                      message.type === "frame" &&
                      message.generation === finalStormGeneration &&
                      message.frame === finalStormFrame &&
                      !sourceSwapStarted
                    ) {
                      sourceSwapStarted = true;
                      worker.postMessage({
                        type: "open",
                        generation: 30,
                        url: replacementUrl,
                        expected: replacementExpected,
                      });
                    }
                    if (message.type === "ready" && message.generation === 30)
                      worker.postMessage({
                        type: "seek",
                        generation: 31,
                        frame: 7,
                      });
                    if (
                      message.type === "frame" &&
                      message.generation === 31 &&
                      message.frame === 7
                    )
                      setTimeout(finish, 50);
                    if (
                      (message.type === "error" ||
                        message.type === "unsupported") &&
                      (message.generation === 1 ||
                        message.generation === 2 ||
                        message.generation === finalStormGeneration ||
                        message.generation === 30 ||
                        message.generation === 31)
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
                `${server.baseUrl}/fixtures/${replacement.file}`,
                expectedFor(replacement),
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
            const stormWindow = framesByGeneration(22);
            const replacementWindow = framesByGeneration(31);
            expect(firstWindow.length).toBeLessThanOrEqual(MAX_OPEN_FRAMES);
            expect(stormWindow.length).toBeLessThanOrEqual(MAX_OPEN_FRAMES);
            expect(replacementWindow.length).toBeLessThanOrEqual(
              MAX_OPEN_FRAMES,
            );
            expect(firstWindow.some((event) => event.frame === 17)).toBe(true);
            expect(stormWindow.some((event) => event.frame === 5)).toBe(true);
            expect(replacementWindow.some((event) => event.frame === 7)).toBe(
              true,
            );
            expect(
              events.some(
                (event) => event.generation >= 3 && event.generation < 22,
              ),
            ).toBe(false);

            for (const event of [
              ...firstWindow,
              ...stormWindow,
              ...replacementWindow,
            ]) {
              expect(["I420", "NV12"]).toContain(event.format);
              expect(event.bufferBytes).toBeGreaterThan(0);
              expect(
                referenceFrameAtTimestamp(
                  event.timestampUs,
                  0,
                  event.generation === 31 ? replacement.rate : clip.rate,
                ),
              ).toBe(event.frame);
            }
          } finally {
            await browser.close();
          }
        },
      );
    }

    it.skipIf(skipReason(env, ["chromium"]) !== undefined)(
      "chromium keeps adjacent play windows contiguous across GOP boundaries",
      async () => {
        const clip = manifest.rateClips.find(
          (candidate) => candidate.rate.num === 25 && candidate.rate.den === 1,
        );
        if (!clip) throw new Error("The 25 fps decoder fixture is missing.");
        const browser = await chromium.launch();
        try {
          const page = await browser.newPage();
          await page.goto(`${server.baseUrl}/harness/harness.html`);
          const frames = await page.evaluate(
            ([workerUrl, clipUrl, expected]) =>
              new Promise<number[]>((resolve, reject) => {
                const worker = new Worker(workerUrl, { type: "module" });
                const received = new Set<number>();
                let generation = 1;
                let target = 0;
                const timer = setTimeout(() => {
                  worker.terminate();
                  reject(new Error("Continuous decoder probe timed out."));
                }, 15_000);
                const finish = (): void => {
                  clearTimeout(timer);
                  worker.postMessage({
                    type: "close",
                    generation: generation + 1,
                  });
                  worker.terminate();
                  resolve([...received].sort((left, right) => left - right));
                };
                worker.onerror = (event) => {
                  clearTimeout(timer);
                  worker.terminate();
                  reject(new Error(event.message));
                };
                worker.onmessage = (
                  event: MessageEvent<
                    | { type: "ready"; generation: number }
                    | {
                        type: "frame";
                        generation: number;
                        frame: number;
                        planes: { buffer: ArrayBuffer };
                      }
                    | {
                        type: "window";
                        generation: number;
                        target: number;
                      }
                    | {
                        type: "unsupported" | "error";
                        generation: number;
                        reason: string;
                      }
                  >,
                ) => {
                  const message = event.data;
                  if (message.type === "ready" && message.generation === 1) {
                    generation = 2;
                    worker.postMessage({
                      type: "seek",
                      generation,
                      frame: target,
                    });
                  } else if (
                    message.type === "frame" &&
                    message.generation === generation
                  ) {
                    received.add(message.frame);
                    worker.postMessage(
                      {
                        type: "release",
                        generation,
                        buffer: message.planes.buffer,
                      },
                      [message.planes.buffer],
                    );
                  } else if (
                    message.type === "window" &&
                    message.generation === generation
                  ) {
                    if (target >= 114) {
                      finish();
                      return;
                    }
                    target += 6;
                    generation += 1;
                    worker.postMessage({
                      type: "play",
                      generation,
                      frame: target,
                      rate: 1,
                    });
                  } else if (
                    message.type === "unsupported" ||
                    message.type === "error"
                  ) {
                    clearTimeout(timer);
                    worker.terminate();
                    reject(new Error(message.reason));
                  }
                };
                worker.postMessage({
                  type: "open",
                  generation,
                  url: clipUrl,
                  expected,
                });
              }),
            [
              `${server.baseUrl}/harness/reference-decoder.worker.js`,
              `${server.baseUrl}/fixtures/${clip.file}`,
              expectedFor(clip),
            ] as const,
          );
          expect(frames).toEqual(
            Array.from({ length: 118 }, (_, frame) => frame),
          );
        } finally {
          await browser.close();
        }
      },
    );
  },
);
