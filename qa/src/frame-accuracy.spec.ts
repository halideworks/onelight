/* WebCodecs frame-accuracy ground truth (design doc sections 7 and 21).

   For every supported rate: 20 pseudo-random seeks (seeded RNG, seed
   printed). Each seek is verified two independent ways against the
   burned-in per-frame pixel stripe:

   (a) <video> + rVFC: the player's real path. The stripe decoded from the
       presented pixels must equal the requested frame (mod 256, combined
       with the requested frame for exact identity), and frameAtMediaTime /
       frameAtCurrentTime (the literal frame-clock.ts source, bundled into
       the harness) must both name that frame.
   (b) WebCodecs: mediabunny demuxes the MP4 and VideoDecoder decodes the
       sample whose presentation interval contains the seek target; the
       stripe in the decoded pixels must again match, and the player math
       applied to the decoded sample's timestamp must agree.

   Acceptance (design doc): frame counter matches at 20 random seeks across
   all supported rates. */

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";
import type { FixtureManifest } from "./fixtures.js";
import { readManifest } from "./fixtures.js";
import { mulberry32, resolveSeed, uniqueRandomFrames } from "./rng.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const SEEKS_PER_CLIP = 20;

const env = readEnvironment();
const reason = skipReason(env, ["ffmpeg", "ffprobe", "fixtures", "chromium"]);
if (reason) console.log(`[qa] frame-accuracy: skipped (${reason})`);

const seed = resolveSeed();

describe.skipIf(reason !== undefined)(
  "frame accuracy: player math vs burned-in ground truth",
  () => {
    let manifest: FixtureManifest;
    let server: StaticServer;
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
      console.log(
        `[qa] frame-accuracy: seed ${seed} (run with QA_SEED=${seed} to reproduce)`,
      );
      manifest = await readManifest();
      server = await startStaticServer(artifactsDir);
      browser = await chromium.launch();
      page = await browser.newPage();
      page.on("pageerror", (error) =>
        console.log(`[qa] harness page error: ${error.message}`),
      );
      await page.goto(`${server.baseUrl}/harness/harness.html`);
      await page.waitForFunction(() => window.qa !== undefined);
    });

    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("covers every supported rate", () => {
      const rates = manifest.rateClips.map(
        (clip) => `${clip.rate.num}/${clip.rate.den}`,
      );
      expect(rates).toEqual([
        "24000/1001",
        "24/1",
        "25/1",
        "30000/1001",
        "30/1",
        "48/1",
        "50/1",
        "60000/1001",
        "60/1",
      ]);
    });

    it("seeks land on the exact frame at every supported rate (video + rVFC)", async () => {
      for (const clip of manifest.rateClips) {
        const url = `${server.baseUrl}/fixtures/${clip.file}`;
        const random = mulberry32(seed);
        const frames = uniqueRandomFrames(random, clip.frames, SEEKS_PER_CLIP);
        await page.evaluate(
          ([clipUrl, rate]) => window.qa.loadClip(clipUrl, rate),
          [url, clip.rate] as const,
        );
        for (const frame of frames) {
          const reading = await page.evaluate(
            ([target]) => window.qa.seekAndRead(target),
            [frame] as const,
          );
          const label = `${clip.id} frame ${frame} seed ${seed} (mediaTime ${reading.mediaTime})`;
          expect(reading.stripeValue, `stripe ground truth, ${label}`).toBe(
            frame % 256,
          );
          expect(reading.rvfcFrame, `frameAtMediaTime, ${label}`).toBe(frame);
          expect(reading.currentTimeFrame, `frameAtCurrentTime, ${label}`).toBe(
            frame,
          );
        }
      }
    });

    it("player math agrees with WebCodecs decode at every supported rate", async () => {
      for (const clip of manifest.rateClips) {
        const url = `${server.baseUrl}/fixtures/${clip.file}`;
        const random = mulberry32(seed);
        const frames = uniqueRandomFrames(random, clip.frames, SEEKS_PER_CLIP);
        for (const frame of frames) {
          const reading = await page.evaluate(
            ([clipUrl, rate, target]) =>
              window.qa.webcodecsRead(clipUrl, rate, target),
            [url, clip.rate, frame] as const,
          );
          const label = `${clip.id} frame ${frame} seed ${seed} (sample timestamp ${reading.timestamp})`;
          expect(
            reading.stripeValue,
            `stripe in decoded sample, ${label}`,
          ).toBe(frame % 256);
          expect(
            reading.wcFrame,
            `frameAtMediaTime on decoded timestamp, ${label}`,
          ).toBe(frame);
        }
      }
    });
  },
);
