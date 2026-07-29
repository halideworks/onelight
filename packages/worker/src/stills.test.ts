/* The stills ladder, run for real against synthesized fixtures.

   These tests execute sharp and, for PSD, ffmpeg. Fixtures are synthesized
   here rather than committed, the same rule the qa harness keeps. The PSD
   writer below emits the composite image section, which is what every reader
   that is not Photoshop reads and what a "maximize compatibility" save
   produces.

   The test that matters most is the JPEG poster: the shipped ffmpeg recipe
   emitted zero frames for a JPEG source (thumbnail=100 over a single frame),
   so every JPEG in the library had no tile anywhere. */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type sharpModule from "sharp";
import {
  STILL_FULL_RUNG,
  STILL_LADDER,
  isBrowserStill,
  isStillSource,
  needsStillFull,
  profileNameOf,
  renderStillRung,
} from "./stills.js";

type SharpModule = typeof sharpModule;

const WIDTH = 600;
const HEIGHT = 400;

const gradient = (): Buffer => {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 3;
      pixels[index] = Math.round((x / (WIDTH - 1)) * 255);
      pixels[index + 1] = Math.round((y / (HEIGHT - 1)) * 255);
      pixels[index + 2] = 128;
    }
  return pixels;
};

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
};
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

/** A PSD carrying an uncompressed RGB composite: header, three empty
    sections, then planar channel data. */
const psdOf = (pixels: Buffer): Buffer => {
  const planes = [0, 1, 2].map((channel) => {
    const plane = Buffer.alloc(WIDTH * HEIGHT);
    for (let index = 0; index < WIDTH * HEIGHT; index += 1)
      plane[index] = pixels[index * 3 + channel] ?? 0;
    return plane;
  });
  return Buffer.concat([
    Buffer.from("8BPS", "ascii"),
    u16(1),
    Buffer.alloc(6),
    u16(3),
    u32(HEIGHT),
    u32(WIDTH),
    u16(8),
    u16(3),
    u32(0),
    u32(0),
    u32(0),
    u16(0),
    ...planes,
  ]);
};

let directory = "";
let sharpAvailable = true;

const sourceFiles: Record<string, string> = {};

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "onelight-stills-"));
  let sharp: SharpModule;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    sharpAvailable = false;
    return;
  }
  const pixels = gradient();
  const raw = {
    raw: { width: WIDTH, height: HEIGHT, channels: 3 as const },
  };
  const write = async (name: string, data: Buffer): Promise<void> => {
    const file = path.join(directory, name);
    await writeFile(file, data);
    sourceFiles[name] = file;
  };
  await write(
    "plain.jpg",
    await sharp(pixels, raw).jpeg({ quality: 90 }).toBuffer(),
  );
  await write(
    "rotated.jpg",
    await sharp(pixels, raw)
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toBuffer(),
  );
  await write("plain.png", await sharp(pixels, raw).png().toBuffer());
  await write(
    "deep.tif",
    await sharp(pixels, raw)
      .toColorspace("rgb16")
      .tiff({ compression: "lzw" })
      .toBuffer(),
  );
  await write(
    "cmyk.tif",
    await sharp(pixels, raw)
      .toColorspace("cmyk")
      .tiff({ compression: "lzw" })
      .toBuffer(),
  );
  await write("flat.psd", psdOf(pixels));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const poster = STILL_LADDER.find((rung) => rung.kind === "poster");
const review = STILL_LADDER.find((rung) => rung.kind === "still_review");

describe("still source classification", () => {
  it("routes the four formats a shoot actually delivers", () => {
    for (const name of [
      "a.jpg",
      "a.JPEG",
      "b.png",
      "c.tif",
      "c.tiff",
      "d.psd",
      "d.PSD",
    ])
      expect(isStillSource(name)).toBe(true);
    expect(isStillSource("a.mov")).toBe(false);
    /* RAW and HEIC have decoders now; see stills-decoders.test.ts. */
    expect(isStillSource("a.cr3")).toBe(true);
    expect(isStillSource("a.heic")).toBe(true);
  });

  it("knows which sources a browser can zoom on its own", () => {
    expect(isBrowserStill("a.jpg")).toBe(true);
    expect(isBrowserStill("a.png")).toBe(true);
    expect(needsStillFull("a.jpg")).toBe(false);
    /* A TIFF and a PSD are not browser formats, so 1:1 zoom needs a rendition
       rather than the original. */
    expect(needsStillFull("a.tif")).toBe(true);
    expect(needsStillFull("a.psd")).toBe(true);
    expect(needsStillFull("a.mov")).toBe(false);
    /* A RAW and a HEIC are not browser formats either. */
    expect(needsStillFull("a.cr3")).toBe(true);
    expect(needsStillFull("a.heic")).toBe(true);
  });
});

describe("the stills ladder", () => {
  it.skipIf(!sharpAvailable)(
    "renders a poster for a JPEG, which the ffmpeg recipe never did",
    async () => {
      const out = path.join(directory, "jpeg-poster.jpg");
      const result = await renderStillRung(
        sourceFiles["plain.jpg"] as string,
        out,
        poster!,
      );
      const info = await stat(out);
      expect(info.size).toBeGreaterThan(0);
      expect(result.content_type).toBe("image/jpeg");
      expect(result.width).toBe(600);
      expect(result.height).toBe(400);
    },
  );

  it.skipIf(!sharpAvailable)(
    "does not enlarge a source smaller than the rung",
    async () => {
      const out = path.join(directory, "small-review.webp");
      const result = await renderStillRung(
        sourceFiles["plain.png"] as string,
        out,
        review!,
      );
      expect(result.width).toBe(WIDTH);
      expect(result.height).toBe(HEIGHT);
    },
  );

  it.skipIf(!sharpAvailable)(
    "applies EXIF orientation, so a portrait frame is portrait",
    async () => {
      const out = path.join(directory, "rotated-review.webp");
      const result = await renderStillRung(
        sourceFiles["rotated.jpg"] as string,
        out,
        review!,
      );
      /* Orientation 6 is a quarter turn: the stored 600x400 is a 400x600
         picture, and both the rendition and the reported source size say so. */
      expect(result.width).toBe(HEIGHT);
      expect(result.height).toBe(WIDTH);
      expect(result.source_width).toBe(HEIGHT);
      expect(result.source_height).toBe(WIDTH);
      expect(result.rotated).toBe(true);
    },
  );

  it.skipIf(!sharpAvailable)("renders a 16 bit TIFF", async () => {
    const out = path.join(directory, "tiff-review.webp");
    const result = await renderStillRung(
      sourceFiles["deep.tif"] as string,
      out,
      review!,
    );
    expect(result.content_type).toBe("image/webp");
    expect((await stat(out)).size).toBeGreaterThan(0);
  });

  it.skipIf(!sharpAvailable)("renders a CMYK TIFF as sRGB", async () => {
    const out = path.join(directory, "cmyk-poster.jpg");
    await renderStillRung(sourceFiles["cmyk.tif"] as string, out, poster!);
    const sharp = (await import("sharp")).default;
    const metadata = await sharp(out).metadata();
    expect(metadata.space).toBe("srgb");
  });

  it.skipIf(!sharpAvailable)(
    "renders a PSD, which sharp cannot open and ffmpeg can",
    async () => {
      const out = path.join(directory, "psd-review.webp");
      const result = await renderStillRung(
        sourceFiles["flat.psd"] as string,
        out,
        review!,
      );
      expect(result.width).toBe(WIDTH);
      expect(result.height).toBe(HEIGHT);
      expect((await stat(out)).size).toBeGreaterThan(0);
      /* The intermediate decode is cleaned up rather than left in the
         rendition directory where the GC would never claim it. */
      const sharp = (await import("sharp")).default;
      const drawn = await sharp(out).raw().toBuffer();
      /* The gradient survived the round trip: left edge dark, right edge
         bright, which proves a picture came through and not a black frame. */
      expect(drawn[0] ?? 255).toBeLessThan(40);
      expect(drawn[(WIDTH - 1) * 3] ?? 0).toBeGreaterThan(215);
    },
  );

  it.skipIf(!sharpAvailable)(
    "caps the on-demand full rung rather than trusting a source's size",
    async () => {
      const out = path.join(directory, "full.webp");
      const result = await renderStillRung(
        sourceFiles["plain.png"] as string,
        out,
        STILL_FULL_RUNG,
        { maxEdge: 128 },
      );
      expect(Math.max(result.width, result.height)).toBe(128);
    },
  );

  it.skipIf(!sharpAvailable)(
    "leaves nothing behind at the final path when a render fails",
    async () => {
      const broken = path.join(directory, "broken.psd");
      await writeFile(broken, Buffer.from("8BPS not really a psd"));
      const out = path.join(directory, "broken-review.webp");
      await expect(
        renderStillRung(broken, out, review!),
      ).rejects.toBeInstanceOf(Error);
      await expect(stat(out)).rejects.toBeTruthy();
    },
  );
});

describe("profileNameOf", () => {
  it("returns nothing for a buffer that is not a profile", () => {
    expect(profileNameOf(new Uint8Array(8))).toBeUndefined();
    expect(profileNameOf(new Uint8Array(0))).toBeUndefined();
  });

  it.skipIf(!sharpAvailable)("names the profile sharp embeds", async () => {
    const sharp = (await import("sharp")).default;
    const tagged = await sharp(gradient(), {
      raw: { width: WIDTH, height: HEIGHT, channels: 3 },
    })
      .withIccProfile("p3")
      .jpeg()
      .toBuffer();
    const metadata = await sharp(tagged).metadata();
    expect(metadata.icc).toBeTruthy();
    const name = profileNameOf(metadata.icc as Uint8Array);
    expect(typeof name).toBe("string");
    expect((name ?? "").length).toBeGreaterThan(0);
  });
});
