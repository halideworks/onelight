import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import {
  MAX_OPEN_FRAMES,
  type ExpectedTrack,
} from "../../packages/player/src/reference/protocol.js";
import type { ReferencePlaybackProbe } from "./harness-types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";
import type { FixtureManifest } from "./fixtures.js";
import { readManifest } from "./fixtures.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const env = readEnvironment();
const fixtureReason = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (fixtureReason)
  console.log(`[qa] reference performance: skipped (${fixtureReason})`);

const engines: Array<{
  name: "chromium" | "firefox" | "webkit";
  type: BrowserType;
}> = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
  { name: "webkit", type: webkit },
];

const expectedFor = (manifest: FixtureManifest): ExpectedTrack => ({
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

const expected4kFor = (manifest: FixtureManifest): ExpectedTrack => ({
  frameRate: manifest.reference4k.rate,
  durationFrames: manifest.reference4k.frames,
  codedWidth: manifest.reference4k.width,
  codedHeight: manifest.reference4k.height,
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
  "production reference scheduler performance",
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

      it.skipIf(browserReason !== undefined)(
        `${engine.name} maintains the continuous six-frame decode scheduler`,
        async () => {
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            await page.waitForFunction(() => window.qa !== undefined);
            const result = await page.evaluate(
              ([workerUrl, clipUrl, expected]) =>
                window.qa.probeReferencePlayback(
                  workerUrl,
                  clipUrl,
                  expected,
                  4_500,
                  "none",
                ),
              [
                `${server.baseUrl}/harness/reference-decoder.worker.js`,
                `${server.baseUrl}/fixtures/${manifest.bars.file}`,
                expectedFor(manifest),
              ] as const,
            );
            console.log(
              `[qa] reference scheduler ${engine.name}: ${JSON.stringify(result)}`,
            );
            expect(result.maximumBufferedFrames).toBeLessThanOrEqual(
              MAX_OPEN_FRAMES,
            );
            expect(result.clockSkippedFrames).toBe(0);
            expect(result.droppedFrames).toBeLessThanOrEqual(1);
            expect(result.presentedFrames).toBeGreaterThan(100);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (engine.name === "firefox" && process.platform === "win32") {
              expect(message).toContain("BGRX is not I420 or NV12");
              return;
            }
            if (engine.name === "webkit") {
              expect(message).toContain(
                "WebCodecs VideoDecoder is unavailable",
              );
              return;
            }
            throw error;
          } finally {
            await browser.close();
          }
        },
      );

      it.skipIf(browserReason !== undefined)(
        `${engine.name} runs the production six-frame scheduler without long tasks`,
        async () => {
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            await page.waitForFunction(() => window.qa !== undefined);
            const durationMs = Math.max(
              2_000,
              Number(process.env.QA_REFERENCE_SOAK_MS ?? 5_000),
            );
            const result = await page.evaluate(
              ([workerUrl, clipUrl, expected, duration]) =>
                window.qa
                  .probeReferencePlayback(
                    workerUrl,
                    clipUrl,
                    expected,
                    duration,
                  )
                  .then(
                    (probe) => ({ status: "measured", probe }) as const,
                    (error: unknown) =>
                      ({
                        status: "unsupported",
                        reason:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      }) as const,
                  ),
              [
                `${server.baseUrl}/harness/reference-decoder.worker.js`,
                `${server.baseUrl}/fixtures/${manifest.bars.file}`,
                expectedFor(manifest),
                durationMs,
              ] as const,
            );
            if (result.status === "unsupported") {
              console.log(
                `[qa] reference performance ${engine.name} unsupported: ${result.reason}`,
              );
              expect(result.reason).toMatch(
                /BGRX is not I420 or NV12|Hardware-capable WebGL2 is unavailable|Reference renderer context was lost|WebCodecs VideoDecoder is unavailable/,
              );
              return;
            }
            expect(result.status).toBe("measured");
            if (result.status !== "measured") return;
            const probe: ReferencePlaybackProbe = result.probe;
            console.log(
              `[qa] reference performance ${engine.name}: ${JSON.stringify(probe)}`,
            );
            expect(probe.maximumBufferedFrames).toBeLessThanOrEqual(
              MAX_OPEN_FRAMES,
            );
            expect(probe.maximumLongTaskMs).toBeLessThanOrEqual(50);
            expect(probe.droppedFrames).toBeLessThanOrEqual(1);
          } finally {
            await browser.close();
          }
        },
      );
    }

    it("chromium reaches the end with bounded skipping during 4x shuttle", async () => {
      const browserReason = fixtureReason
        ? undefined
        : skipReason(env, ["chromium"]);
      if (browserReason) return;
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${server.baseUrl}/harness/harness.html`);
        await page.waitForFunction(() => window.qa !== undefined);
        const result = await page.evaluate(
          ([workerUrl, clipUrl, expected]) =>
            window.qa.probeReferencePlayback(
              workerUrl,
              clipUrl,
              expected,
              1_300,
              "none",
              4,
            ),
          [
            `${server.baseUrl}/harness/reference-decoder.worker.js`,
            `${server.baseUrl}/fixtures/${manifest.bars.file}`,
            expectedFor(manifest),
          ] as const,
        );
        console.log(
          `[qa] reference scheduler chromium 4x: ${JSON.stringify(result)}`,
        );
        expect(result.expectedFrames).toBe(125);
        expect(result.requestedFrames).toBeGreaterThan(50);
        expect(result.presentedFrames).toBeGreaterThan(30);
        expect(result.lastPresentedFrame).toBe(124);
        expect(result.droppedFrames).toBeLessThan(result.requestedFrames / 2);
        expect(result.maximumBufferedFrames).toBeLessThanOrEqual(
          MAX_OPEN_FRAMES,
        );
        expect(result.seekP95Ms).toBeLessThan(250);
      } finally {
        await browser.close();
      }
    });

    it("chromium reaches the end of a bounded 4K 30 fps reference timeline", async () => {
      const browserReason = fixtureReason
        ? undefined
        : skipReason(env, ["chromium"]);
      if (browserReason) return;
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${server.baseUrl}/harness/harness.html`);
        await page.waitForFunction(() => window.qa !== undefined);
        const result = await page.evaluate(
          ([workerUrl, clipUrl, expected]) =>
            window.qa.probeReferencePlayback(
              workerUrl,
              clipUrl,
              expected,
              3_100,
              "none",
            ),
          [
            `${server.baseUrl}/harness/reference-decoder.worker.js`,
            `${server.baseUrl}/fixtures/${manifest.reference4k.file}`,
            expected4kFor(manifest),
          ] as const,
        );
        console.log(
          `[qa] reference scheduler chromium 4K30: ${JSON.stringify(result)}`,
        );
        expect(result.expectedFrames).toBe(manifest.reference4k.frames);
        expect(result.requestedFrames).toBe(manifest.reference4k.frames);
        expect(result.presentedFrames).toBeGreaterThanOrEqual(60);
        expect(result.lastPresentedFrame).toBe(manifest.reference4k.frames - 1);
        expect(result.droppedFrames).toBeLessThanOrEqual(30);
        expect(result.maximumBufferedFrames).toBeLessThanOrEqual(
          MAX_OPEN_FRAMES,
        );
        expect(result.seekP95Ms).toBeLessThan(750);
      } finally {
        await browser.close();
      }
    });

    it("chromium qualifies accelerated 4K 30 fps playback when hardware is required", async () => {
      const browserReason = fixtureReason
        ? undefined
        : skipReason(env, ["chromium"]);
      if (browserReason) return;
      const requireHardware = process.env.QA_REFERENCE_REQUIRE_HARDWARE === "1";
      const browser = await chromium.launch({
        headless: process.env.QA_REFERENCE_HEADED !== "1",
      });
      try {
        const page = await browser.newPage();
        await page.goto(`${server.baseUrl}/harness/harness.html`);
        await page.waitForFunction(() => window.qa !== undefined);
        const result = await page.evaluate(
          ([workerUrl, clipUrl, expected]) =>
            window.qa
              .probeReferencePlayback(
                workerUrl,
                clipUrl,
                expected,
                3_100,
                "hardware",
              )
              .then(
                (probe) => ({ status: "measured", probe }) as const,
                (error: unknown) =>
                  ({
                    status: "unsupported",
                    reason:
                      error instanceof Error ? error.message : String(error),
                  }) as const,
              ),
          [
            `${server.baseUrl}/harness/reference-decoder.worker.js`,
            `${server.baseUrl}/fixtures/${manifest.reference4k.file}`,
            expected4kFor(manifest),
          ] as const,
        );
        if (result.status === "unsupported") {
          console.log(
            `[qa] reference hardware chromium 4K30 unsupported: ${result.reason}`,
          );
          expect(result.reason).toMatch(
            /Hardware-capable WebGL2 is unavailable|WebCodecs does not support|pixel format/,
          );
          if (requireHardware)
            throw new Error(
              `Required 4K30 hardware path was unavailable: ${result.reason}`,
            );
          return;
        }
        console.log(
          `[qa] reference hardware chromium 4K30: ${JSON.stringify(result.probe)}`,
        );
        expect(result.probe.lastPresentedFrame).toBe(
          manifest.reference4k.frames - 1,
        );
        expect(result.probe.droppedFrames).toBeLessThanOrEqual(1);
        expect(result.probe.maximumBufferedFrames).toBeLessThanOrEqual(
          MAX_OPEN_FRAMES,
        );
        expect(result.probe.maximumLongTaskMs).toBeLessThanOrEqual(50);
        expect(result.probe.seekP95Ms).toBeLessThan(250);
      } finally {
        await browser.close();
      }
    });

    it("chromium uploads and renders 4K reference planes", async () => {
      const browserReason = fixtureReason
        ? undefined
        : skipReason(env, ["chromium"]);
      if (browserReason) return;
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${server.baseUrl}/harness/harness.html`);
        await page.waitForFunction(() => window.qa !== undefined);
        const result = await page.evaluate(
          ([workerUrl, clipUrl, expected]) =>
            window.qa.probeReferencePlayback(
              workerUrl,
              clipUrl,
              expected,
              650,
              "software",
            ),
          [
            `${server.baseUrl}/harness/reference-decoder.worker.js`,
            `${server.baseUrl}/fixtures/${manifest.reference4k.file}`,
            expected4kFor(manifest),
          ] as const,
        );
        console.log(
          `[qa] reference renderer chromium 4K30: ${JSON.stringify(result)}`,
        );
        expect(result.presentedFrames).toBeGreaterThan(0);
        expect(result.lastPresentedFrame).toBeGreaterThanOrEqual(0);
        expect(result.maximumBufferedFrames).toBeLessThanOrEqual(
          MAX_OPEN_FRAMES,
        );
      } finally {
        await browser.close();
      }
    });
  },
);
