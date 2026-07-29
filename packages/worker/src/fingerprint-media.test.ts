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
  AUDIO_MATCH_MAX_DISTANCE,
  CONTENT_MATCH_MIN_MARGIN,
  SHOT_OVERLAP_MIN,
  captureKeyOf,
  contentDistance,
  contentOverlap,
  hashDistance,
} from "@onelight/core";
import {
  CLIP_HASH_POSITIONS,
  clipHashPositions,
  fingerprintAudio,
  fingerprintClip,
  isFlat,
  parseRmsLevels,
  resampleEnvelope,
} from "./fingerprint-media.js";
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
      expect(first).toMatch(/^[0-9a-f]{16}(:[0-9a-f]{16}){15}$/);
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

describe("parseRmsLevels", () => {
  it("reads what astats prints, and treats silence as silence", () => {
    const levels = parseRmsLevels(
      [
        "frame:0 pts:0 pts_time:0",
        "lavfi.astats.Overall.RMS_level=-20.997745",
        "frame:1 pts:170 pts_time:0.02125",
        "lavfi.astats.Overall.RMS_level=-inf",
        "noise that is not a level",
      ].join("\n"),
    );
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[1]).toBe(0);
  });
});

describe("resampleEnvelope", () => {
  it("averages many frames into a fixed number of windows", () => {
    const levels = Array.from({ length: 300 }, (_, index) => index);
    const windows = resampleEnvelope(levels, 65);
    expect(windows).toHaveLength(65);
    /* Monotonic in, monotonic out. */
    expect(windows[0]).toBeLessThan(windows[64] as number);
  });

  it("leaves a short contour alone rather than inventing detail", () => {
    expect(resampleEnvelope([1, 2, 3], 65)).toHaveLength(3);
  });
});

describe.skipIf(!hasFfmpeg)("what a clip sounds like", () => {
  const withAudio = async (
    name: string,
    tone: string,
    video = "testsrc2=size=320x240:rate=12",
    extra: string[] = [],
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
      tone,
      "-f",
      "lavfi",
      "-i",
      video,
      "-map",
      "1:v",
      "-map",
      "0:a",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      ...extra,
      file,
    ]);
    return file;
  };

  it("matches a colour pass, where the picture moved and the sound did not", async () => {
    const tone =
      "sine=frequency=440:duration=6,volume=0.6:enable='between(t,2,4)'";
    const graded = await withAudio("grade-a.mp4", tone);
    /* The same cut, regraded and re-encoded: a different picture, the same
       soundtrack. This is the case a positional picture hash can miss and the
       audio cannot. */
    const regraded = await withAudio(
      "grade-b.mp4",
      tone,
      "testsrc2=size=320x240:rate=12",
      ["-vf", "eq=brightness=0.15:saturation=1.6"],
    );
    const first = await fingerprintAudio(graded, {
      durationSeconds: 6,
      ffmpeg,
    });
    const second = await fingerprintAudio(regraded, {
      durationSeconds: 6,
      ffmpeg,
    });
    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(hashDistance(first as string, second as string)).toBeLessThanOrEqual(
      AUDIO_MATCH_MAX_DISTANCE,
    );
  });

  it("separates two different soundtracks of the same length", async () => {
    const one = await withAudio(
      "sound-a.mp4",
      "sine=frequency=440:duration=6,volume=0.2:enable='between(t,1,2)'",
    );
    const other = await withAudio(
      "sound-b.mp4",
      "sine=frequency=440:duration=6,volume=0.2:enable='between(t,4,5)'",
    );
    const first = await fingerprintAudio(one, { durationSeconds: 6, ffmpeg });
    const second = await fingerprintAudio(other, {
      durationSeconds: 6,
      ffmpeg,
    });
    expect(hashDistance(first as string, second as string)).toBeGreaterThan(
      AUDIO_MATCH_MAX_DISTANCE,
    );
  });

  it("has nothing to say about silence or about no audio at all", async () => {
    const silent = await withAudio(
      "silent.mp4",
      "anullsrc=channel_layout=mono:sample_rate=48000:duration=6",
    );
    expect(
      await fingerprintAudio(silent, { durationSeconds: 6, ffmpeg }),
    ).toBeNull();
    const mute = path.join(directory, "mute.mp4");
    await runProcess(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=12:duration=4",
      "-pix_fmt",
      "yuv420p",
      mute,
    ]);
    expect(
      await fingerprintAudio(mute, { durationSeconds: 4, ffmpeg }),
    ).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)("a re-edit against a colour pass", () => {
  it.skipIf(!sharpAvailable)(
    "reads as reused footage even when every position disagrees",
    async () => {
      const source = path.join(directory, "edit-a.mp4");
      /* Two halves that genuinely look nothing like each other, so a sample
         taken from one is never mistaken for a sample from the other. A
         single synthetic pattern will not do: testsrc2 at six seconds still
         looks like testsrc2 at twelve. */
      await runProcess(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x240:rate=12:duration=6",
        "-f",
        "lavfi",
        "-i",
        "smptebars=size=320x240:rate=12:duration=6",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1[out]",
        "-map",
        "[out]",
        "-pix_fmt",
        "yuv420p",
        source,
      ]);
      /* The "re-edit": the same footage, trimmed and reordered. */
      const reedit = path.join(directory, "edit-b.mp4");
      await runProcess(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-filter_complex",
        "[0:v]trim=start=6:end=12,setpts=PTS-STARTPTS[a];[0:v]trim=start=0:end=6,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[out]",
        "-map",
        "[out]",
        "-pix_fmt",
        "yuv420p",
        reedit,
      ]);
      const first = (await fingerprintClip(source, {
        durationSeconds: 12,
        workDirectory: directory,
        ffmpeg,
        tag: "edit-a",
      })) as string;
      const second = (await fingerprintClip(reedit, {
        durationSeconds: 12,
        workDirectory: directory,
        ffmpeg,
        tag: "edit-b",
      })) as string;
      /* Position by position these two look like different clips, which is
         what a re-edit does to a positional hash. */
      expect(contentDistance(first, second)).toBeGreaterThan(
        CONTENT_MATCH_MIN_MARGIN,
      );
      /* As sets, most of the footage is the same footage. */
      expect(contentOverlap(second, first)).toBeGreaterThanOrEqual(
        SHOT_OVERLAP_MIN,
      );
    },
  );

  it("signs a clip too short to hold the full grid, and a single frame", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "onelight-short-"));
    try {
      const render = (name: string, args: string[]): string => {
        const file = path.join(dir, name);
        spawnSync("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          ...args,
          "-pix_fmt",
          "yuv420p",
          "-y",
          file,
        ]);
        return file;
      };
      /* A one second sting: four points fit, sixteen do not. */
      const sting = render("sting.mp4", [
        "-i",
        "testsrc2=duration=1:size=160x120:rate=24",
      ]);
      /* And a single frame in a container, which is what an HDR still
         delivered as .mkv is. The first version gave both of these no
         signature at all. */
      const frame = render("frame.mkv", [
        "-i",
        "testsrc2=duration=0.041:size=160x120:rate=24",
      ]);
      const short = await fingerprintClip(sting, {
        durationSeconds: 1,
        workDirectory: dir,
        tag: "sting",
      });
      expect(short?.split(":")).toHaveLength(clipHashPositions(1).length);
      expect(clipHashPositions(1).length).toBeLessThan(
        CLIP_HASH_POSITIONS.length,
      );
      const single = await fingerprintClip(frame, {
        durationSeconds: 0.041,
        workDirectory: dir,
        tag: "frame",
      });
      expect(single).toMatch(/^[0-9a-f]{16}$/);
      /* Counts differ, so a sting is never compared positionally with a spot,
         which is the property that keeps a short signature honest. */
      expect(contentDistance(single as string, short as string)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
