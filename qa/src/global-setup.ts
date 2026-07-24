/* Vitest global setup for the qa package. Runs before any spec is
   collected: detects tools, synthesizes the fixture corpus when ffmpeg is
   available, bundles the browser harness, and writes the environment
   snapshot the specs use to decide run-or-skip. Missing tools are never an
   error here; each suite logs its own one-line skip reason. */

import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import {
  artifactsDir,
  detectEnvironment,
  envPath,
  fixturesDir,
  harnessDir,
  qaRoot,
  repoRoot,
} from "./capabilities.js";
import { synthesizeFixtures } from "./fixtures.js";

const bundleHarness = async (): Promise<void> => {
  await mkdir(harnessDir, { recursive: true });
  /* Bundling compiles packages/player/src/frame-clock.ts itself into the
     page, which is what makes formula drift impossible. Runs even when no
     browser is installed so a broken import path fails loudly everywhere. */
  await build({
    entryPoints: [path.join(qaRoot, "src", "harness-main.ts")],
    bundle: true,
    format: "iife",
    target: ["chrome110", "firefox115", "safari16"],
    outfile: path.join(harnessDir, "harness.js"),
    logLevel: "silent",
  });
  await copyFile(
    path.join(qaRoot, "src", "harness.html"),
    path.join(harnessDir, "harness.html"),
  );
};

export default async function setup(): Promise<void> {
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  const env = detectEnvironment();
  if (env.ffmpeg && env.ffprobe) {
    await synthesizeFixtures();
    env.fixturesReady = true;
  } else {
    console.log(
      "[qa] fixtures: not synthesized (ffmpeg/ffprobe not on PATH); media suites will skip",
    );
  }
  await copyFile(
    path.join(
      repoRoot,
      "packages",
      "web",
      "static",
      "media",
      "color-check-bt709.mp4",
    ),
    path.join(fixturesDir, "color-check-bt709.mp4"),
  );
  await bundleHarness();
  await writeFile(envPath, JSON.stringify(env, null, 2), "utf8");
}
