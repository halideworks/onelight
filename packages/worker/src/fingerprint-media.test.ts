/* Fingerprinting real media.

   The question these answer is not "does it hash" but "does the hash tell the
   right pictures apart and the wrong ones together". So the fixtures are a
   frame, that frame retouched, the next frame of the same burst, and a
   different set-up, and the assertions are about the distances between them,
   which is what the matcher's margin rule is built on. */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTENT_MATCH_MIN_MARGIN,
  captureKeyOf,
  contentDistance,
} from "@onelight/core";
import { fingerprintClip, isFlat } from "./fingerprint-media.js";
import { fingerprintStillSource } from "./stills.js";
import { runProcess } from "./run-process.js";

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

const WIDTH = 640;
const HEIGHT = 427;

let directory = "";
let sharpAvailable = true;

/* A scene: a subject on a graded background, with grain. `shift` moves the
   camera, which is what the next frame of a burst looks like. */
const scene = (options: {
  shift?: number;
  gain?: number;
  retouch?: boolean;
}): Buffer => {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  const shift = options.shift ?? 0;
  const gain = options.gain ?? 1;
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 3;
      const sx = x + shift;
      const background = 120 + Math.sin(sx / 90) * 40 + Math.cos(y / 70) * 25;
      const dx = sx - 300;
      const dy = y - 200;
      const inSubject = (dx * dx) / 9000 + (dy * dy) / 5000 < 1;
      const value = inSubject ? (options.retouch ? 205 : 190) : background;
      const grain = ((x * 7 + y * 13) % 11) - 5;
      const clamp = (channel: number): number =>
        Math.max(0, Math.min(255, Math.round(channel * gain)));
      pixels[index] = clamp(value + grain);
      pixels[index + 1] = clamp(value * 0.9 + grain);
      pixels[index + 2] = clamp(value * 0.8 + grain);
    }
  return pixels;
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "onelight-print-"));
  try {
    await import("sharp");
  } catch {
    sharpAvailable = false;
  }
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const writeJpeg = async (name: string, pixels: Buffer): Promise<string> => {
  const sharp = (await import("sharp")).default;
  const file = path.join(directory, name);
  await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .jpeg({ quality: 90 })
    .toFile(file);
  return file;
};

describe("isFlat", () => {
  it("calls a sample with nothing in it flat", () => {
    expect(isFlat(new Uint8Array(72))).toBe(true);
    expect(isFlat(new Uint8Array(72).fill(18))).toBe(true);
    const varied = new Uint8Array(72);
    varied.forEach((_, index) => {
      varied[index] = index * 3;
    });
    expect(isFlat(varied)).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("fingerprinting a still", () => {
  it.skipIf(!sharpAvailable)(
    "puts a retouch nearer than the next frame of the burst, by a margin",
    async () => {
      const frame = await writeJpeg("frame.jpg", scene({}));
      const retouched = await writeJpeg(
        "retouched.jpg",
        scene({ gain: 1.08, retouch: true }),
      );
      const burst = await writeJpeg("burst.jpg", scene({ shift: 3 }));
      const other = await writeJpeg("other.jpg", scene({ shift: 400 }));

      const base = (await fingerprintStillSource(frame)).contentHash as string;
      const toRetouch = contentDistance(
        base,
        (await fingerprintStillSource(retouched)).contentHash as string,
      );
      const toBurst = contentDistance(
        base,
        (await fingerprintStillSource(burst)).contentHash as string,
      );
      const toOther = contentDistance(
        base,
        (await fingerprintStillSource(other)).contentHash as string,
      );

      /* The retouch is the nearest thing to the frame. */
      expect(toRetouch).toBeLessThan(toBurst);
      /* A different set-up is nowhere near either, which is what makes the
         hash useful for ruling things out. */
      expect(toOther).toBeGreaterThan(toBurst + CONTENT_MATCH_MIN_MARGIN);
      /* And the gap between the right answer and the frame beside it is
         small, which is why the matcher may not decide on distance alone. */
      expect(toBurst - toRetouch).toBeLessThan(CONTENT_MATCH_MIN_MARGIN);
    },
  );

  it.skipIf(!sharpAvailable)(
    "hashes the picture, not the file: a re-encode still matches",
    async () => {
      const sharp = (await import("sharp")).default;
      const pixels = scene({});
      const original = await writeJpeg("original.jpg", pixels);
      const reencoded = path.join(directory, "reencoded.png");
      await sharp(pixels, {
        raw: { width: WIDTH, height: HEIGHT, channels: 3 },
      })
        .png()
        .toFile(reencoded);
      const a = (await fingerprintStillSource(original)).contentHash as string;
      const b = (await fingerprintStillSource(reencoded)).contentHash as string;
      expect(contentDistance(a, b)).toBeLessThan(CONTENT_MATCH_MIN_MARGIN);
    },
  );

  it.skipIf(!sharpAvailable)(
    "reads the capture identity a camera writes",
    async () => {
      const sharp = (await import("sharp")).default;
      const file = path.join(directory, "tagged.jpg");
      await sharp(scene({}), {
        raw: { width: WIDTH, height: HEIGHT, channels: 3 },
      })
        .withExifMerge({
          IFD0: { Make: "NIKON CORPORATION", Model: "NIKON Z 9" },
          IFD2: {
            DateTimeOriginal: "2026:07:29 14:03:11",
            SubSecTimeOriginal: "470",
            BodySerialNumber: "3005421",
          },
        })
        .jpeg()
        .toFile(file);
      const print = await fingerprintStillSource(file);
      expect(print.capture.takenAt).toContain("2026:07:29 14:03:11");
      expect(captureKeyOf(print.capture)).toBeTruthy();
    },
  );

  it.skipIf(!sharpAvailable)(
    "has no identity to offer for a bare file",
    async () => {
      const file = await writeJpeg("bare.jpg", scene({}));
      const print = await fingerprintStillSource(file);
      expect(captureKeyOf(print.capture)).toBeNull();
      /* But it still has a picture, which is the whole point of tier three. */
      expect(print.contentHash).toMatch(/^[0-9a-f]{16}$/);
    },
  );
});

describe.skipIf(!hasFfmpeg)("fingerprinting a clip", () => {
  const makeClip = async (
    name: string,
    source: string,
    seconds = 4,
  ): Promise<string> => {
    const file = path.join(directory, name);
    await runProcess(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      source,
      "-t",
      String(seconds),
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    return file;
  };

  it.skipIf(!sharpAvailable)(
    "signs a clip at four points, and tells two clips apart",
    async () => {
      const one = await makeClip("one.mp4", "testsrc2=size=320x240:rate=12");
      const two = await makeClip("two.mp4", "smptebars=size=320x240:rate=12");
      const first = await fingerprintClip(one, {
        durationSeconds: 4,
        workDirectory: directory,
        ffmpeg,
        tag: "one",
      });
      const again = await fingerprintClip(one, {
        durationSeconds: 4,
        workDirectory: directory,
        ffmpeg,
        tag: "one-again",
      });
      const second = await fingerprintClip(two, {
        durationSeconds: 4,
        workDirectory: directory,
        ffmpeg,
        tag: "two",
      });
      expect(first).toMatch(/^[0-9a-f]{16}(:[0-9a-f]{16}){3}$/);
      /* The same clip, twice: identical. */
      expect(contentDistance(first as string, again as string)).toBe(0);
      /* A different clip: nowhere near. */
      expect(
        contentDistance(first as string, second as string),
      ).toBeGreaterThan(CONTENT_MATCH_MIN_MARGIN);
    },
  );

  it.skipIf(!sharpAvailable)(
    "refuses a signature it cannot take honestly",
    async () => {
      const black = await makeClip(
        "black.mp4",
        "color=c=black:size=320x240:rate=12",
      );
      /* Every sample flat: two black clips would otherwise look identical. */
      expect(
        await fingerprintClip(black, {
          durationSeconds: 4,
          workDirectory: directory,
          ffmpeg,
          tag: "black",
        }),
      ).toBeNull();
      /* And a clip with no duration to sample. */
      expect(
        await fingerprintClip(black, {
          durationSeconds: 0,
          workDirectory: directory,
          ffmpeg,
          tag: "empty",
        }),
      ).toBeNull();
    },
  );
});

describe("a signature is only comparable to its own shape", () => {
  it("refuses a still against a clip", () => {
    /* One hash against four: a still and a clip are never compared, which is
       what stops a poster frame pairing with a photograph of the same set. */
    expect(
      contentDistance("0000000000000000", "0000000000000000:0000000000000000"),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps the file honest about what it could not do", async () => {
    await writeFile(path.join(directory, "not-media.txt"), "hello");
    await expect(
      fingerprintStillSource(path.join(directory, "not-media.txt")),
    ).rejects.toBeInstanceOf(Error);
  });
});
