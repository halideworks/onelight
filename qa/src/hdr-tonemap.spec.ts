/* HDR tonemap verification against the local ffmpeg.
 *
 * The product converts HDR sources to SDR proxies through
 * HDR_TONEMAP_FILTER (packages/worker/src/media.ts): a libplacebo chain
 * targeting bt709/yuv420p with bt.2390 tonemapping. This suite runs that
 * exact exported filter string against synthesized PQ and HLG fixtures
 * (see synthesizeHdrFixtures in fixtures.ts) and asserts:
 *
 *   1. the run completes (libplacebo initialized and processed frames),
 *   2. the output is tagged bt709 across primaries, transfer, and matrix,
 *      by libplacebo's own frame metadata, not by explicit -colorspace
 *      flags, and the pixel format is the product's yuv420p,
 *   3. the center-pixel luma of the tonemapped frame lands in a sane SDR
 *      mid range: the fixtures are a uniform 25 percent grey, so a black
 *      or blown output means the tonemap produced garbage even when the
 *      tags look right.
 *
 * Skip policy (always logged, one line): the suite skips when ffmpeg or
 * ffprobe are missing, when ffmpeg lacks the libplacebo filter (detected
 * via ffmpeg -filters; apt ffmpeg on ubuntu 24.04 has it, other builds may
 * not), and when libplacebo is present but cannot initialize a device on
 * this machine (a one-frame smoke run; software Vulkan is not guaranteed
 * outside the worker container). The docker integration workflow
 * (.github/workflows/integration.yml) is the hard gate that fails when
 * libplacebo cannot initialize inside the worker container. */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HDR_TONEMAP_FILTER,
  VULKAN_HWDEVICE_ARGS,
  probeFile,
  runProcess,
} from "../../packages/worker/src/media.js";
import { fixturesDir, readEnvironment, skipReason } from "./capabilities.js";
import { synthesizeHdrFixtures } from "./fixtures.js";
import type { HdrClipFixture } from "./fixtures.js";

const ffmpegBin = (): string => process.env.FFMPEG_PATH ?? "ffmpeg";

const WIDTH = 640;
const HEIGHT = 360;

/* Two-stage detection at collection time, mirroring how capabilities.ts
   detects tools: cheap filter listing first, then a one-frame smoke run so
   "compiled in but no usable Vulkan/OpenGL device" skips instead of
   failing every HDR test on developer machines. */
const detectLibplacebo = (): string | undefined => {
  const filters = spawnSync(ffmpegBin(), ["-hide_banner", "-filters"], {
    encoding: "utf8",
  });
  if (filters.status !== 0)
    return "ffmpeg -filters failed; cannot detect libplacebo";
  if (!/\blibplacebo\b/.test(filters.stdout ?? ""))
    return "ffmpeg lacks the libplacebo filter";
  /* The worker never lets vf_libplacebo create its own Vulkan context: it
     always prepends VULKAN_HWDEVICE_ARGS (see media.ts). Mirror that here,
     both because it is the invocation being verified and because
     libplacebo's own device selection refuses software implementations
     like lavapipe, which is all a headless CI runner has. */
  const smoke = spawnSync(
    ffmpegBin(),
    [
      "-hide_banner",
      ...VULKAN_HWDEVICE_ARGS,
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=64x64:r=25:d=0.04",
      "-vf",
      HDR_TONEMAP_FILTER,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  if (smoke.status !== 0) {
    const firstLine = (smoke.stderr ?? "").trim().split("\n")[0] ?? "unknown";
    return `libplacebo is present but failed to initialize (${firstLine})`;
  }
  return undefined;
};

const env = readEnvironment();
const toolReason = skipReason(env, ["ffmpeg", "ffprobe"]);
const placeboReason = toolReason ? undefined : detectLibplacebo();
const reason = toolReason ?? placeboReason;
if (reason) console.log(`[qa] hdr-tonemap: skipped (${reason})`);
else
  console.log(
    "[qa] hdr-tonemap: libplacebo detected and initialized; running the PQ and HLG tonemap verification",
  );

/* The tonemap of a uniform 25 percent grey must land in visible SDR
   mid-tones. The exact value depends on the transfer interpretation and
   libplacebo's mapping curve; the band below catches the real failure
   modes (all-black output, blown-to-white output, tags without pixels)
   while staying stable across libplacebo versions. Limited-range 8-bit:
   black is 16, white is 235. */
const LUMA_MIN = 32;
const LUMA_MAX = 208;

const centerLuma = async (file: string): Promise<number> => {
  const rawPath = `${file}.gray`;
  await runProcess(ffmpegBin(), [
    "-hide_banner",
    "-y",
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    rawPath,
  ]);
  const plane = await readFile(rawPath);
  if (plane.length < WIDTH * HEIGHT)
    throw new Error(`Unexpected raw frame size ${plane.length}.`);
  return plane[Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)] ?? -1;
};

describe.skipIf(reason !== undefined)(
  "hdr tonemap: the product filter chain converts PQ and HLG to bt709 SDR",
  () => {
    let fixtures: HdrClipFixture[] | undefined;
    const fixturesOnce = async (): Promise<HdrClipFixture[]> => {
      fixtures ??= await synthesizeHdrFixtures();
      return fixtures;
    };

    for (const id of ["hdr-pq", "hdr-hlg"] as const) {
      it(`${id}: HDR_TONEMAP_FILTER produces a sane bt709 result`, async () => {
        const clip = (await fixturesOnce()).find((entry) => entry.id === id);
        expect(clip, `fixture ${id} synthesized`).toBeDefined();
        if (!clip) return;
        const outputPath = path.join(fixturesDir, `${id}-tonemapped.mp4`);
        /* The literal product filter string with the worker's own Vulkan
           device args, one GOP of frames, and no explicit
           -colorspace/-color_trc flags: the bt709 tags asserted below must
           come from libplacebo's output frames. */
        await runProcess(ffmpegBin(), [
          "-hide_banner",
          "-y",
          ...VULKAN_HWDEVICE_ARGS,
          "-i",
          path.join(fixturesDir, clip.file),
          "-vf",
          HDR_TONEMAP_FILTER,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          "-frames:v",
          "5",
          outputPath,
        ]);
        const probe = await probeFile(outputPath);
        const video = probe.streams.find(
          (stream) => stream.codec_type === "video",
        );
        expect(video, "tonemapped output has a video stream").toBeDefined();
        expect(video?.color_transfer, `${id} transfer`).toBe("bt709");
        expect(video?.color_primaries, `${id} primaries`).toBe("bt709");
        expect(video?.color_space ?? video?.colorspace, `${id} matrix`).toBe(
          "bt709",
        );
        expect(video?.pix_fmt, `${id} pixel format`).toBe("yuv420p");
        const luma = await centerLuma(outputPath);
        expect(
          luma,
          `${id} tonemapped center-pixel luma ${luma} should sit in the SDR mid band [${LUMA_MIN}, ${LUMA_MAX}]`,
        ).toBeGreaterThanOrEqual(LUMA_MIN);
        expect(luma).toBeLessThanOrEqual(LUMA_MAX);
      });
    }
  },
);
