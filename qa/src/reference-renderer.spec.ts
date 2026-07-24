import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import {
  COLOR_ORACLE_PATCHES,
  type ColorTriplet,
} from "../../packages/player/src/color-oracle.js";
import type {
  ExpectedTrack,
  PlaneTransfer,
} from "../../packages/player/src/reference/protocol.js";
import type { PatchReading, ReferenceRenderReadings } from "./harness-types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";
import type { FixtureManifest } from "./fixtures.js";
import { readManifest } from "./fixtures.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const env = readEnvironment();
const fixtureReason = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (fixtureReason)
  console.log(`[qa] reference renderer: skipped (${fixtureReason})`);

const engines: Array<{
  name: "chromium" | "firefox" | "webkit";
  type: BrowserType;
}> = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
  { name: "webkit", type: webkit },
];

type RendererResult =
  | {
      status: "rendered";
      readings: ReferenceRenderReadings;
      contextLossReason: string;
    }
  | {
      status: "unsupported";
      reason: string;
    };

const expectedTrack = (manifest: FixtureManifest): ExpectedTrack => ({
  frameRate: { num: 25, den: 1 },
  durationFrames: 125,
  codedWidth: manifest.bars.width,
  codedHeight: manifest.bars.height,
  codec: null,
  outputColor: {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    range: "tv",
  },
  outputChromaLocation: "left",
});

const assertWithinOne = (
  engine: string,
  format: string,
  readings: readonly PatchReading[],
): void => {
  const byName = new Map(readings.map((reading) => [reading.name, reading]));
  for (const patch of COLOR_ORACLE_PATCHES) {
    const reading = byName.get(patch.name);
    expect(reading, `${engine} ${format} omitted ${patch.name}`).toBeDefined();
    if (!reading) continue;
    for (const channel of [0, 1, 2] as const)
      expect(
        Math.abs(reading.rgb[channel] - patch.srgb[channel]),
        `${engine} ${format} ${patch.name}: ${reading.rgb.join(",")} versus ${patch.srgb.join(",")}`,
      ).toBeLessThanOrEqual(1);
  }
};

describe.skipIf(fixtureReason !== undefined)(
  "raw-plane WebGL2 reference renderer",
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

    for (const engine of engines) {
      const browserReason = fixtureReason
        ? undefined
        : skipReason(env, [engine.name]);
      if (!fixtureReason && browserReason)
        console.log(
          `[qa] reference renderer ${engine.name}: skipped (${browserReason})`,
        );

      it.skipIf(browserReason !== undefined)(
        engine.name === "firefox" && process.platform === "win32"
          ? "firefox on Windows refuses BGRX before reference rendering"
          : `${engine.name} renders decoded I420 and repacked NV12 within 1/255`,
        async () => {
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            await page.waitForFunction(() => window.qa !== undefined);
            const rects = COLOR_ORACLE_PATCHES.map((patch) => ({
              name: patch.name,
              ...patch.rect,
            }));
            const result = await page.evaluate(
              ([workerUrl, clipUrl, expected, patchRects]) =>
                new Promise<RendererResult>((resolve, reject) => {
                  const worker = new Worker(workerUrl, { type: "module" });
                  let finished = false;
                  const timer = setTimeout(() => {
                    worker.terminate();
                    reject(new Error("Reference renderer worker timed out."));
                  }, 15_000);
                  const finish = (value: RendererResult): void => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    worker.postMessage({ type: "close", generation: 3 });
                    worker.terminate();
                    resolve(value);
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
                          planes: PlaneTransfer;
                        }
                      | {
                          type: "unsupported" | "error";
                          generation: number;
                          reason: string;
                        }
                    >,
                  ) => {
                    const message = event.data;
                    if (message.type === "ready" && message.generation === 1)
                      worker.postMessage({
                        type: "seek",
                        generation: 2,
                        frame: 60,
                      });
                    else if (
                      message.type === "frame" &&
                      message.generation === 2 &&
                      message.frame === 60
                    )
                      void window.qa
                        .renderReferenceVariants(message.planes, patchRects)
                        .then(async (readings) => ({
                          readings,
                          contextLossReason:
                            await window.qa.probeReferenceContextLoss(
                              message.planes,
                            ),
                        }))
                        .then(({ readings, contextLossReason }) =>
                          finish({
                            status: "rendered",
                            readings,
                            contextLossReason,
                          }),
                        )
                        .catch((error: unknown) => {
                          clearTimeout(timer);
                          worker.terminate();
                          reject(
                            error instanceof Error
                              ? error
                              : new Error(String(error)),
                          );
                        });
                    else if (message.type === "unsupported")
                      finish({
                        status: "unsupported",
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
                  });
                }),
              [
                `${server.baseUrl}/harness/reference-decoder.worker.js`,
                `${server.baseUrl}/fixtures/${manifest.bars.file}`,
                expectedTrack(manifest),
                rects,
              ] as const,
            );

            if (engine.name === "firefox" && process.platform === "win32") {
              expect(result).toEqual({
                status: "unsupported",
                reason: "Decoded pixel format BGRX is not I420 or NV12.",
              });
              return;
            }
            if (engine.name === "webkit" && result.status === "unsupported") {
              expect(result.reason).toBe(
                "WebCodecs VideoDecoder is unavailable.",
              );
              return;
            }

            expect(result.status).toBe("rendered");
            if (result.status !== "rendered") return;
            expect(result.contextLossReason).toBe(
              "Reference renderer context was lost.",
            );
            expect(["I420", "NV12"]).toContain(result.readings.sourceFormat);
            assertWithinOne(engine.name, "I420", result.readings.i420);
            assertWithinOne(engine.name, "NV12", result.readings.nv12);
            expect(
              result.readings.i420.map(
                (reading) => reading.rgb as ColorTriplet,
              ),
            ).toEqual(
              result.readings.nv12.map(
                (reading) => reading.rgb as ColorTriplet,
              ),
            );
          } finally {
            await browser.close();
          }
        },
      );
    }
  },
);
