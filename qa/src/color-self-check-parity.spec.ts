import { stat } from "node:fs/promises";
import path from "node:path";
import { COLOR_ORACLE_PATCHES } from "../../packages/player/src/color-oracle.js";
import { COLOR_SELF_CHECK_CLIP_SHA256 } from "../../packages/player/src/color-self-check.js";
import { probeFile, runProcess } from "../../packages/worker/src/media.js";
import { describe, expect, it } from "vitest";
import { readEnvironment, repoRoot, skipReason } from "./capabilities.js";
import { analyzeBars, analyzeBarsAtPatches } from "./fixtures.js";

const env = readEnvironment();
const unavailable = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (unavailable)
  console.log(`[qa] color-self-check parity: skipped (${unavailable})`);

const clipPath = path.join(
  repoRoot,
  "packages",
  "web",
  "static",
  "media",
  "color-check-bt709.mp4",
);

describe.skipIf(unavailable !== undefined)(
  "embedded color self-check clip",
  () => {
    it("matches the synthesized QA oracle and production media contract", async () => {
      const file = await stat(clipPath);
      expect(file.size).toBeLessThan(100 * 1024);

      const mediaInfo = await probeFile(clipPath);
      const video = mediaInfo.streams.find(
        (stream) => stream.codec_type === "video",
      );
      expect(video).toMatchObject({
        codec_name: "h264",
        pix_fmt: "yuv420p",
        color_space: "bt709",
        color_transfer: "bt709",
        color_primaries: "bt709",
        color_range: "tv",
        nb_frames: "2",
      });

      const frames = JSON.parse(
        (
          await runProcess(process.env.FFPROBE_PATH ?? "ffprobe", [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=key_frame",
            "-of",
            "json",
            clipPath,
          ])
        ).stdout,
      ) as { frames?: Array<{ key_frame?: number }> };
      expect(frames.frames?.map((frame) => frame.key_frame)).toEqual([1, 1]);

      const discovered = await analyzeBars(clipPath);
      expect(
        discovered.map(({ name, srgb, nominal, tolerance }) => ({
          name,
          srgb,
          nominal,
          tolerance,
        })),
      ).toEqual(
        COLOR_ORACLE_PATCHES.map(({ name, srgb, nominal, tolerance }) => ({
          name,
          srgb,
          nominal,
          tolerance,
        })),
      );
      expect(
        await analyzeBarsAtPatches(clipPath, COLOR_ORACLE_PATCHES),
      ).toEqual(COLOR_ORACLE_PATCHES);
      expect(COLOR_SELF_CHECK_CLIP_SHA256).toHaveLength(64);
    });
  },
);
