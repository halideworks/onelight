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
            if (engine.name === "webkit" && process.platform === "linux") {
              expect(result).toMatchObject({
                outcome: "warning",
                stage: "complete",
                patchMaxDelta: [3, 5, 3],
                failedPatches: ["white75", "yellow75", "cyan75", "green75"],
                failure: null,
              });
              const deltas = new Map(
                result.deltas.map((delta) => [delta.name, delta.delta]),
              );
              expect(deltas.get("white75")).toEqual([-3, -3, -3]);
              expect(deltas.get("yellow75")).toEqual([-3, -5, 0]);
              expect(deltas.get("cyan75")).toEqual([0, -5, -3]);
              expect(deltas.get("green75")).toEqual([0, -5, 0]);
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
