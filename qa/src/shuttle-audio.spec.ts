/* Audible shuttle regression.

   The original failure advanced picture at the requested L shuttle speed
   while Chrome and Firefox produced no audio. This suite measures decoded
   media-element output through Web Audio at every forward shuttle rate.
   It also asserts that the player selects direct varispeed resampling,
   keeping the browser's pitch-preserving time stretcher out of this path. */

import { chromium, firefox } from "playwright";
import type { BrowserType } from "playwright";
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
  "shuttle audio: forward varispeed remains audible",
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
      const browserMissing = fixturesMissing
        ? undefined
        : skipReason(env, [engine.name]);
      if (!fixturesMissing && browserMissing)
        console.log(
          `[qa] shuttle-audio ${engine.name}: skipped (${browserMissing})`,
        );

      it.skipIf(browserMissing !== undefined)(
        `${engine.name} emits audio at 1x, 2x, and 4x`,
        async () => {
          const browser = await engine.type.launch();
          try {
            const context = await browser.newContext();
            const page = await context.newPage();
            page.on("pageerror", (error) =>
              console.log(`[qa] harness page error: ${error.message}`),
            );
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            await page.waitForFunction(() => window.qa !== undefined);
            const url = `${server.baseUrl}/fixtures/${manifest.shuttleAudio.file}`;

            for (const playbackRate of [1, 2, 4]) {
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
              const reading = await page.evaluate(async () => {
                const pending = window.shuttleAudioProbe;
                if (!pending)
                  throw new Error("shuttle audio probe not started");
                try {
                  return await pending;
                } finally {
                  document.getElementById("shuttle-audio-trigger")?.remove();
                  window.shuttleAudioProbe = undefined;
                }
              });
              const label = `${engine.name} at ${playbackRate}x`;
              expect(reading.playbackRate, label).toBe(playbackRate);
              expect(reading.preservesPitch, label).toBe(false);
              expect(reading.currentTime, label).toBeGreaterThan(0.1);
              expect(reading.rms, label).toBeGreaterThan(0.01);
            }
          } finally {
            await browser.close();
          }
        },
      );
    }
  },
);
