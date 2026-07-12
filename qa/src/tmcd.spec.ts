/* tmcd verification (node-only, ffprobe).

   The product re-embeds source start timecode into proxies with
   -timecode ... -write_tmcd on (packages/worker/src/media.ts,
   buildSdrProxyArgs). This suite synthesizes a 29.97 drop-frame clip with
   that exact recipe shape and proves:

   1. ffmpeg actually wrote a tmcd track and the probe normalizer
      (normalizeProbe) surfaces the label and its drop-frame flag.
   2. @onelight/core parseTimecode/framesFromTimecode agree with ffmpeg
      about what that label means: the label round-trips through the core
      math to the exact start frame and back to the identical string. */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatTimecode,
  framesFromTimecode,
  parseTimecode,
  timecodeFromFrames,
} from "../../packages/core/src/timecode.js";
import { probeFile } from "../../packages/worker/src/media.js";
import { fixturesDir, readEnvironment, skipReason } from "./capabilities.js";
import { DF_RATE, DF_START_TIMECODE, readManifest } from "./fixtures.js";

/* Hand-derived per SMPTE ST 12-1 (Heidelberger/Duncan formula, see
   docs/research/playback-transcode.md section 1.5):
   frames = (59*60 + 55) * 30 + 0 - 2 * (59 - floor(59/10))
          = 107850 - 108 = 107742 */
const EXPECTED_START_FRAME = 107742;

const env = readEnvironment();
const reason = skipReason(env, ["ffmpeg", "ffprobe", "fixtures"]);
if (reason) console.log(`[qa] tmcd: skipped (${reason})`);

describe.skipIf(reason !== undefined)(
  "tmcd: drop-frame start timecode round-trips through core math",
  () => {
    it("ffmpeg writes the tmcd track and the probe surfaces it", async () => {
      const manifest = await readManifest();
      const probe = await probeFile(
        path.join(fixturesDir, manifest.dropFrame.file),
      );
      expect(probe.sourceTimecodeStart).toBe(DF_START_TIMECODE);
      expect(probe.dropFrame).toBe(true);
      expect(probe.frameRateNum).toBe(DF_RATE.num);
      expect(probe.frameRateDen).toBe(DF_RATE.den);
      const tmcdStream = probe.streams.find(
        (stream) =>
          stream.codec_tag_string === "tmcd" || stream.codec_name === "tmcd",
      );
      expect(tmcdStream, "tmcd timecode track present").toBeDefined();
    });

    it("the label decodes to the exact start frame and re-encodes verbatim", async () => {
      const manifest = await readManifest();
      const probe = await probeFile(
        path.join(fixturesDir, manifest.dropFrame.file),
      );
      const label = probe.sourceTimecodeStart;
      expect(label).toBeDefined();
      if (label === undefined) return;
      const parsed = parseTimecode(label, DF_RATE);
      expect(parsed.dropFrame).toBe(true);
      const startFrame = framesFromTimecode(parsed, DF_RATE);
      expect(startFrame).toBe(EXPECTED_START_FRAME);
      expect(
        formatTimecode(timecodeFromFrames(startFrame, DF_RATE, true)),
      ).toBe(DF_START_TIMECODE);
    });
  },
);
