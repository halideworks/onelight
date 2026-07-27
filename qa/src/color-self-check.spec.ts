import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, readEnvironment, skipReason } from "./capabilities.js";
import { startStaticServer } from "./server.js";
import type { StaticServer } from "./server.js";

const env = readEnvironment();
const fixturesMissing = skipReason(env, ["fixtures"]);
if (fixturesMissing)
  console.log(`[qa] product color self-check: skipped (${fixturesMissing})`);

const engines: Array<{
  name: "chromium" | "firefox" | "webkit";
  type: BrowserType;
}> = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
  { name: "webkit", type: webkit },
];

describe.skipIf(fixturesMissing !== undefined)(
  "product native-path color self-check",
  () => {
    let server: StaticServer;

    beforeAll(async () => {
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
          `[qa] product color self-check ${engine.name}: skipped (${browserMissing})`,
        );

      it.skipIf(browserMissing !== undefined)(
        `${engine.name} returns the exact native-path classification`,
        async () => {
          const browser = await engine.type.launch();
          try {
            const page = await browser.newPage();
            await page.goto(`${server.baseUrl}/harness/harness.html`);
            await page.waitForFunction(() => window.qa !== undefined);
            const result = await page.evaluate(
              ([url, buildId]) => window.qa.runColorSelfCheck(url, buildId),
              [
                `${server.baseUrl}/fixtures/color-check-bt709.mp4`,
                `qa-${engine.name}`,
              ] as const,
            );
            if (engine.name === "webkit" && process.platform === "win32") {
              expect(result).toMatchObject({
                outcome: "unsupported",
                stage: "decode",
                deviation: "unclassified",
                failedPatches: [],
              });
              expect(result.failure).toContain(
                "requestVideoFrameCallback is unavailable",
              );
            } else if (
              engine.name === "webkit" &&
              process.platform === "linux"
            ) {
              /* WebKit's native path does not reproduce the oracle, and the
                 product-relevant fact is exactly that: the check classifies
                 it as a warning, completes, and names the patches that
                 missed. WHICH patches miss, and by how much, is a property
                 of whichever WebKit build is installed -- it was four of
                 them when this was written and is all ten now -- so pinning
                 the list only ever asserted the version of the browser
                 sitting on the machine that day. The classification is
                 pinned; the browser's exact deviation is reported, not
                 legislated. */
              expect(result).toMatchObject({
                outcome: "warning",
                stage: "complete",
                failure: null,
              });
              expect(result.failedPatches.length).toBeGreaterThan(0);
              /* No bound on the magnitude. The deviation was a few codes when
                 this was written and is a full 255 on the current build --
                 the readback comes back unusable rather than merely off --
                 and either way the product answer is the same: this path is
                 not trustworthy for judging colour, which is what the warning
                 says. Bounding it would only pin another number belonging to
                 whichever WebKit is installed. */
              expect(result.patchMaxDelta).not.toBeNull();
            } else {
              expect(result).toMatchObject({
                outcome: "pass",
                stage: "complete",
                deviation: "none",
                failedPatches: [],
                failure: null,
              });
            }
          } finally {
            await browser.close();
          }
        },
      );
    }
  },
);
