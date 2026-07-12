/* Tool and browser detection plus the shared on-disk layout for the qa
   package. Everything the suites need to decide "run or skip with a reason"
   lives here. The environment snapshot is written once by global-setup and
   read synchronously by every spec at collection time. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

export const qaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const repoRoot = path.resolve(qaRoot, "..");
export const artifactsDir = path.join(qaRoot, ".artifacts");
export const fixturesDir = path.join(artifactsDir, "fixtures");
export const harnessDir = path.join(artifactsDir, "harness");
export const envPath = path.join(artifactsDir, "env.json");
export const manifestPath = path.join(fixturesDir, "manifest.json");

export interface BrowserAvailability {
  chromium: boolean;
  firefox: boolean;
  webkit: boolean;
}

export interface QaEnvironment {
  ffmpeg: boolean;
  ffprobe: boolean;
  browsers: BrowserAvailability;
  fixturesReady: boolean;
}

const commandWorks = (command: string): boolean => {
  try {
    return spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};

const browserInstalled = (browserType: {
  executablePath: () => string;
}): boolean => {
  try {
    const executable = browserType.executablePath();
    return executable.length > 0 && existsSync(executable);
  } catch {
    return false;
  }
};

export const detectEnvironment = (): QaEnvironment => ({
  ffmpeg: commandWorks(process.env.FFMPEG_PATH ?? "ffmpeg"),
  ffprobe: commandWorks(process.env.FFPROBE_PATH ?? "ffprobe"),
  browsers: {
    chromium: browserInstalled(chromium),
    firefox: browserInstalled(firefox),
    webkit: browserInstalled(webkit),
  },
  fixturesReady: false,
});

export const readEnvironment = (): QaEnvironment => {
  if (!existsSync(envPath)) {
    // Spec loaded outside the vitest global setup (should not happen); be
    // honest and skip everything.
    return {
      ffmpeg: false,
      ffprobe: false,
      browsers: { chromium: false, firefox: false, webkit: false },
      fixturesReady: false,
    };
  }
  return JSON.parse(readFileSync(envPath, "utf8")) as QaEnvironment;
};

export const skipReason = (
  env: QaEnvironment,
  needs: Array<"ffmpeg" | "ffprobe" | "fixtures" | keyof BrowserAvailability>,
): string | undefined => {
  for (const need of needs) {
    if (need === "ffmpeg" && !env.ffmpeg) return "ffmpeg not found on PATH";
    if (need === "ffprobe" && !env.ffprobe) return "ffprobe not found on PATH";
    if (need === "fixtures" && !env.fixturesReady)
      return "fixtures were not synthesized (ffmpeg/ffprobe missing)";
    if (
      (need === "chromium" || need === "firefox" || need === "webkit") &&
      !env.browsers[need]
    )
      return `Playwright ${need} is not installed (npx playwright install ${need})`;
  }
  return undefined;
};
