/* Golden-frame color QC (design doc sections 18 and 21: the bug class users
   punish hardest).

   The BT.709-tagged, limited-range SMPTE RP 219 bars clip is played in a
   real <video> element, drawn to a canvas, and defined patches are compared
   against the sidecar reference computed at synthesis time (exact float
   BT.709 conversion of the encoded YUV). A correct browser pipeline (709
   matrix, 16-235 expansion, no gamma mangling) reproduces the reference
   within rounding noise.

   Tolerances are per patch and per channel, embedded in the sidecar:
   2/255 baseline (pure quantization headroom), 12/255 only for the blue
   channel of chroma-saturated patches, where the browsers' shared libyuv
   readback kernel clamps the BT.709 U-to-B coefficient (int8 lane limit).
   The full derivation and the bug classes each patch catches (range
   mishandling ~16-20 off, 601/709 matrix confusion 15+ off on R/G, gamma
   shift 10-20 off on midtone neutrals) live in patchTolerance in
   qa/src/fixtures.ts and docs/research/playback-transcode.md section 2.4. */

import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";
import type { FixtureManifest } from "./fixtures.js";
import { readManifest } from "./fixtures.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const env = readEnvironment();
const fixturesMissing = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (fixturesMissing) console.log(`[qa] color-qc: skipped (${fixturesMissing})`);

const engines: Array<{
  name: "chromium" | "firefox" | "webkit";
  type: BrowserType;
}> = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
  /* webkit runs when its Playwright build is installed; CI installs all
       three engines. Playwright webkit is not real Safari (no macOS media
       stack), so real Safari stays on the manual QC pass, see qa/README.md. */
  { name: "webkit", type: webkit },
];

/* Known engine decode deviations, pinned EXACTLY (2026-07-17).

   Playwright WebKit on Linux decodes video through its bundled
   GStreamer/GL path, not a macOS media stack, and reads the 75 percent
   bars low: a uniform -3 on the neutral (which no matrix confusion can
   produce) plus a further -2 on the green channel of saturated patches
   (which no level shift can produce), a small gamma-like compression
   stacked on a chroma coefficient error. Chromium and Firefox are exact
   on the same clip, and real Safari (VideoToolbox/ColorSync) does not
   share this path; it stays on the manual QC pass per qa/README.md.

   The reference and its tolerances are NOT widened. Each pinned patch
   must reproduce these bytes exactly: if a WebKit or GStreamer update
   shifts the deviation, or fixes it, the run fails and this table has to
   be re-derived or deleted deliberately. Pins are scoped to the exact
   engine and platform measured; every other engine and platform stays on
   the reference. */
const PINNED_DECODE_DEVIATIONS: Record<
  string,
  Record<string, [number, number, number]> | undefined
> = {
  "webkit-linux": {
    white75: [188, 188, 188],
    yellow75: [188, 186, 0],
    cyan75: [0, 186, 187],
    green75: [0, 186, 0],
  },
};

describe.skipIf(fixturesMissing !== undefined)(
  "color QC: golden bars decode identically across browsers",
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
          `[qa] color-qc ${engine.name}: skipped (${browserMissing})`,
        );

      it.skipIf(browserMissing !== undefined)(
        `${engine.name} reproduces the reference patches within tolerance`,
        async () => {
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            page.on("pageerror", (error) =>
              console.log(`[qa] harness page error: ${error.message}`),
            );
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            await page.waitForFunction(() => window.qa !== undefined);
            await page.evaluate(
              ([url, rate]) => window.qa.loadClip(url, rate),
              [
                `${server.baseUrl}/fixtures/${manifest.bars.file}`,
                { num: 25, den: 1 },
              ] as const,
            );
            /* Land mid-clip so the reading never depends on first-frame
               presentation edge cases; every bars frame is identical. */
            await page.evaluate(([frame]) => window.qa.seekAndRead(frame), [
              60,
            ] as const);
            const rects = manifest.bars.patches.map((patch) => ({
              name: patch.name,
              ...patch.rect,
            }));
            const readings = await page.evaluate(
              ([patchRects]) => window.qa.readPatches(patchRects),
              [rects] as const,
            );
            /* Collect every out-of-tolerance channel before failing, so a
               deviation reads as a full vector across the patch set (a
               uniform level shift, a matrix confusion, and a gamma bend
               all look different across patches but identical on the
               first failing channel alone). */
            const pins =
              PINNED_DECODE_DEVIATIONS[`${engine.name}-${process.platform}`];
            const failures: string[] = [];
            for (const patch of manifest.bars.patches) {
              const reading = readings.find(
                (entry) => entry.name === patch.name,
              );
              expect(reading, `patch ${patch.name} missing`).toBeDefined();
              if (!reading) continue;
              const pinned = pins?.[patch.name];
              if (pinned) {
                /* A pinned patch must match its recorded deviation byte for
                   byte; drift in either direction is a decoder change that
                   demands re-deriving the pin. */
                if (
                  reading.rgb[0] !== pinned[0] ||
                  reading.rgb[1] !== pinned[1] ||
                  reading.rgb[2] !== pinned[2]
                )
                  failures.push(
                    `${patch.name}: got ${reading.rgb.join(",")}, pinned deviation ${pinned.join(",")} (reference ${patch.srgb.join(",")}); the ${engine.name} decoder changed, re-derive or delete the pin`,
                  );
                continue;
              }
              for (let channel = 0; channel < 3; channel += 1) {
                const got = reading.rgb[channel] ?? -1;
                const want = patch.srgb[channel] ?? -1;
                const tolerance = patch.tolerance[channel] ?? 0;
                if (Math.abs(got - want) > tolerance)
                  failures.push(
                    `${patch.name} channel ${channel}: got ${reading.rgb.join(",")}, reference ${patch.srgb.join(",")} (nominal ${patch.nominal.join(",")}, tolerance ${tolerance})`,
                  );
              }
            }
            expect(
              failures,
              `${engine.name} out-of-tolerance patches:\n${failures.join("\n")}`,
            ).toEqual([]);
          } finally {
            await browser.close();
          }
        },
      );
    }
  },
);
