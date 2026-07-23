/* Audible, pitch-corrected shuttle regression.

   One real reviewer received advancing 2x and 4x picture with no sound across
   Chrome and Firefox on macOS and Windows. The primary path now removes audio
   from the browser's rate-changed media element: ffmpeg creates pitch-corrected
   2x and 4x sidecars, and the player runs the matching file at ordinary 1x.

   The fixtures below are built with the production worker's sidecarArgs, not a
   copied ffmpeg recipe. In each browser Web Audio measures both level and
   dominant frequency. Duration proves the temporal compression, and the
   997 Hz peak proves it did not become 1994 or 3988 Hz. A separate assertion
   keeps the direct-varispeed emergency path audible when a sidecar fails. */

import { chromium, firefox } from "playwright";
import type { BrowserType, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";
import type { FixtureManifest } from "./fixtures.js";
import { readManifest } from "./fixtures.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const env = readEnvironment();
const fixturesMissing = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (fixturesMissing)
  console.log(`[qa] shuttle-audio: skipped (${fixturesMissing})`);

const engines: Array<{
  name: "chromium" | "firefox";
  type: BrowserType;
}> = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
];

describe.skipIf(fixturesMissing !== undefined)(
  "shuttle audio: sidecars preserve pitch and the fallback remains audible",
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

    const browserTest = (
      engine: (typeof engines)[number],
      name: string,
      run: (page: Page) => Promise<void>,
    ): void => {
      const browserMissing = fixturesMissing
        ? undefined
        : skipReason(env, [engine.name]);
      if (!fixturesMissing && browserMissing)
        console.log(
          `[qa] shuttle-audio ${engine.name}: skipped (${browserMissing})`,
        );

      it.skipIf(browserMissing !== undefined)(name, async () => {
        const browser = await engine.type.launch();
        try {
          const context = await browser.newContext();
          const page = await context.newPage();
          page.on("pageerror", (error) =>
            console.log(`[qa] harness page error: ${error.message}`),
          );
          await page.goto(`${server.baseUrl}/harness/harness.html`);
          await page.waitForFunction(() => window.qa !== undefined);
          await run(page);
        } finally {
          await browser.close();
        }
      });
    };

    const probe = async (page: Page, url: string, playbackRate: number) => {
      await page.evaluate(
        ([clipUrl, targetRate]) => {
          const trigger = document.createElement("button");
          trigger.id = "shuttle-audio-trigger";
          trigger.addEventListener(
            "click",
            () => {
              window.shuttleAudioProbe = window.qa.probeShuttleAudio(
                clipUrl,
                targetRate,
              );
            },
            { once: true },
          );
          document.body.append(trigger);
        },
        [url, playbackRate] as const,
      );
      await page.click("#shuttle-audio-trigger");
      return page.evaluate(async () => {
        const pending = window.shuttleAudioProbe;
        if (!pending) throw new Error("shuttle audio probe not started");
        try {
          return await pending;
        } finally {
          document.getElementById("shuttle-audio-trigger")?.remove();
          window.shuttleAudioProbe = undefined;
        }
      });
    };

    for (const engine of engines) {
      browserTest(
        engine,
        `${engine.name} plays compressed sidecars at normal pitch`,
        async (page) => {
          for (const sidecar of manifest.shuttleAudio.sidecars) {
            const reading = await probe(
              page,
              `${server.baseUrl}/fixtures/${sidecar.file}`,
              1,
            );
            const label = `${engine.name} ${String(sidecar.rate)}x sidecar`;
            expect(reading.playbackRate, label).toBe(1);
            expect(reading.currentTime, label).toBeGreaterThan(0.1);
            expect(reading.rms, label).toBeGreaterThan(0.01);
            expect(reading.dominantHz, label).toBeCloseTo(
              manifest.shuttleAudio.toneHz,
              -1,
            );
            expect(reading.duration, label).toBeCloseTo(
              manifest.shuttleAudio.durationSeconds / sidecar.rate,
              1,
            );
            expect(sidecar.durationSeconds, label).toBeCloseTo(
              manifest.shuttleAudio.durationSeconds / sidecar.rate,
              1,
            );
          }
        },
      );

      browserTest(
        engine,
        `${engine.name} keeps direct-varispeed fallback audible`,
        async (page) => {
          const url = `${server.baseUrl}/fixtures/${manifest.shuttleAudio.file}`;
          for (const playbackRate of [2, 4]) {
            const reading = await probe(page, url, playbackRate);
            const label = `${engine.name} ${String(playbackRate)}x fallback`;
            expect(reading.playbackRate, label).toBe(playbackRate);
            expect(reading.preservesPitch, label).toBe(false);
            expect(reading.currentTime, label).toBeGreaterThan(0.1);
            expect(reading.rms, label).toBeGreaterThan(0.01);
          }
        },
      );
    }
  },
);
