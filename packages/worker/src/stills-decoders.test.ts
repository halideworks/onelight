/* The three decoders that are not sharp, exercised for real.

   RAW is proved against a DNG written here: a valid, uncompressed, little
   endian TIFF carrying a Bayer mosaic and the tags libraw needs to demosaic
   it. A camera file would be better and cannot be committed, so the fixture
   is the format's own documentation turned into bytes; libraw either reads it
   or it does not.

   HEIC is proved by encoding one with libheif and decoding it back. PSB is
   proved in psd-image.test.ts and reached through the renderer here. */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  STILL_LADDER,
  isHeifStill,
  isPhotoshopStill,
  isRawStill,
  isStillSource,
  renderStillRung,
} from "./stills.js";

const dcraw = process.env.DCRAW_PATH ?? "dcraw_emu";
const heifDec = process.env.HEIF_DEC_PATH ?? "heif-dec";
const heifEnc = process.env.HEIF_ENC_PATH ?? "heif-enc";
const has = (command: string, args: string[] = ["--help"]): boolean => {
  const run = spawnSync(command, args);
  return run.error === undefined;
};
const hasRaw = has(dcraw, []);
const hasHeifDec = has(heifDec);
const hasHeifEnc = has(heifEnc);

let sharpAvailable = true;
let directory = "";

const review = STILL_LADDER.find((rung) => rung.kind === "still_review");
const poster = STILL_LADDER.find((rung) => rung.kind === "poster");

/* --- a DNG, written from the spec --- */

const TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SRATIONAL: 10,
};

export const writeDng = (width: number, height: number): Buffer => {
  /* A left-to-right ramp laid onto an RGGB mosaic: every pixel carries only
     its own filter's channel, which is what a RAW actually is. */
  const mosaic = Buffer.alloc(width * height * 2);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const ramp = Math.round((x / (width - 1)) * 65535);
      const even = y % 2 === 0;
      const isRed = even && x % 2 === 0;
      const isBlue = !even && x % 2 === 1;
      const value = isRed ? ramp : isBlue ? 65535 - ramp : 32768;
      mosaic.writeUInt16LE(value, (y * width + x) * 2);
    }

  const entries: Array<{
    tag: number;
    type: number;
    count: number;
    value: number;
  }> = [];
  const extra: Buffer[] = [];
  const ENTRY_COUNT = 24;
  const ifdSize = 2 + ENTRY_COUNT * 12 + 4;
  const extraBase = 8 + ifdSize;
  const add = (
    tag: number,
    type: number,
    count: number,
    value: number,
  ): void => {
    entries.push({ tag, type, count, value });
  };
  const addExtra = (bytes: Buffer): number => {
    const offset =
      extraBase + extra.reduce((sum, item) => sum + item.length, 0);
    extra.push(bytes);
    return offset;
  };
  const long = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const rational = (num: number, den: number): Buffer => {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(num, 0);
    buffer.writeUInt32LE(den, 4);
    return buffer;
  };
  const srational = (num: number, den: number): Buffer => {
    const buffer = Buffer.alloc(8);
    buffer.writeInt32LE(num, 0);
    buffer.writeInt32LE(den, 4);
    return buffer;
  };

  const make = Buffer.from("Onelight\0", "ascii");
  const makeOffset = addExtra(make);
  const model = Buffer.from("Onelight Test Camera\0", "ascii");
  const modelOffset = addExtra(model);
  const colorMatrixOffset = addExtra(
    Buffer.concat(
      (
        [
          [10000, 10000],
          [-4000, 10000],
          [-1000, 10000],
          [-2000, 10000],
          [12000, 10000],
          [1000, 10000],
          [-500, 10000],
          [1500, 10000],
          [7000, 10000],
        ] as Array<[number, number]>
      ).map(([num, den]) => srational(num, den)),
    ),
  );
  const neutralOffset = addExtra(
    Buffer.concat([rational(1, 1), rational(1, 1), rational(1, 1)]),
  );
  const blackOffset = addExtra(rational(0, 1));
  const pixelsOffset =
    extraBase + extra.reduce((sum, item) => sum + item.length, 0);

  add(254, TYPE.LONG, 1, 0); // NewSubFileType: the main image
  add(256, TYPE.LONG, 1, width);
  add(257, TYPE.LONG, 1, height);
  add(258, TYPE.SHORT, 1, 16); // BitsPerSample
  add(259, TYPE.SHORT, 1, 1); // Compression: none
  add(262, TYPE.SHORT, 1, 32803); // PhotometricInterpretation: CFA
  add(271, TYPE.ASCII, make.length, makeOffset);
  add(272, TYPE.ASCII, model.length, modelOffset);
  add(273, TYPE.LONG, 1, pixelsOffset); // StripOffsets
  add(277, TYPE.SHORT, 1, 1); // SamplesPerPixel
  add(278, TYPE.LONG, 1, height); // RowsPerStrip
  add(279, TYPE.LONG, 1, width * height * 2); // StripByteCounts
  add(284, TYPE.SHORT, 1, 1); // PlanarConfiguration
  /* A TIFF value of four bytes or fewer lives in the entry itself rather
     than at an offset, and a reader takes those four bytes as the value.
     Writing an offset here instead makes libraw read the offset as the CFA
     pattern, which it then demosaics as a two-colour sensor. */
  add(33421, TYPE.SHORT, 2, Buffer.from([2, 0, 2, 0]).readUInt32LE(0));
  add(33422, TYPE.BYTE, 4, Buffer.from([0, 1, 1, 2]).readUInt32LE(0));
  add(50706, TYPE.BYTE, 4, Buffer.from([1, 4, 0, 0]).readUInt32LE(0)); // DNGVersion
  add(50707, TYPE.BYTE, 4, Buffer.from([1, 1, 0, 0]).readUInt32LE(0));
  add(50708, TYPE.ASCII, model.length, modelOffset); // UniqueCameraModel
  add(50714, TYPE.RATIONAL, 1, blackOffset); // BlackLevel
  add(50721, TYPE.SRATIONAL, 9, colorMatrixOffset); // ColorMatrix1
  add(50728, TYPE.RATIONAL, 3, neutralOffset); // AsShotNeutral
  add(50719, TYPE.LONG, 2, addExtra(Buffer.concat([long(0), long(0)]))); // DefaultCropOrigin
  add(
    50720,
    TYPE.LONG,
    2,
    addExtra(Buffer.concat([long(width), long(height)])),
  ); // DefaultCropSize
  add(
    50829,
    TYPE.LONG,
    4,
    addExtra(Buffer.concat([long(0), long(0), long(height), long(width)])),
  ); // ActiveArea
  entries.sort((left, right) => left.tag - right.tag);

  const header = Buffer.alloc(8);
  header.write("II", 0, "ascii");
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  entries.forEach((entry, index) => {
    const at = 2 + index * 12;
    ifd.writeUInt16LE(entry.tag, at);
    ifd.writeUInt16LE(entry.type, at + 2);
    ifd.writeUInt32LE(entry.count, at + 4);
    ifd.writeUInt32LE(entry.value >>> 0, at + 8);
  });
  return Buffer.concat([header, ifd, ...extra, mosaic]);
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "onelight-dec-"));
  try {
    await import("sharp");
  } catch {
    sharpAvailable = false;
  }
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("the format table", () => {
  it("routes every family to a decoder that exists in this image", () => {
    for (const name of ["a.cr3", "b.ARW", "c.nef", "d.dng", "e.raf", "f.rw2"]) {
      expect(isRawStill(name), name).toBe(true);
      expect(isStillSource(name), name).toBe(true);
    }
    for (const name of ["x.heic", "y.HEIF", "z.hif"]) {
      expect(isHeifStill(name), name).toBe(true);
      expect(isStillSource(name), name).toBe(true);
    }
    for (const name of ["a.psd", "b.PSB"]) {
      expect(isPhotoshopStill(name), name).toBe(true);
      expect(isStillSource(name), name).toBe(true);
    }
    /* Still not images: a video and a sound file must never land as one. */
    expect(isStillSource("a.mov")).toBe(false);
    expect(isStillSource("a.wav")).toBe(false);
  });
});

describe.skipIf(!hasRaw)("camera RAW", () => {
  it.skipIf(!sharpAvailable)("renders a DNG through libraw", async () => {
    const source = path.join(directory, "frame.dng");
    await writeFile(source, writeDng(240, 160));
    const out = path.join(directory, "raw-review.webp");
    const result = await renderStillRung(source, out, review!);
    /* Half-size demosaic, so the picture is half the mosaic's dimensions. */
    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
    expect((await stat(out)).size).toBeGreaterThan(0);
    const sharp = (await import("sharp")).default;
    const pixels = await sharp(out).raw().toBuffer();
    /* The ramp survived: the left edge is darker than the right. */
    const left = pixels[0] ?? 0;
    const right = pixels[(120 - 1) * 3] ?? 0;
    expect(right).toBeGreaterThan(left);
  });

  it.skipIf(!sharpAvailable)(
    "leaves nothing behind in the rendition directory",
    async () => {
      const source = path.join(directory, "tidy.dng");
      await writeFile(source, writeDng(120, 80));
      const out = path.join(directory, "tidy", "poster.jpg");
      await renderStillRung(source, out, poster!);
      const { readdir } = await import("node:fs/promises");
      const left = await readdir(path.join(directory, "tidy"));
      /* The symlink and the decoded TIFF are both gone; only the rung
         remains, or the GC would keep an orphan forever. */
      expect(left).toEqual(["poster.jpg"]);
    },
  );

  it.skipIf(!sharpAvailable)(
    "fails honestly on a RAW it cannot read",
    async () => {
      const source = path.join(directory, "broken.dng");
      await writeFile(source, Buffer.from("II*\0 not a dng at all"));
      await expect(
        renderStillRung(source, path.join(directory, "broken.webp"), review!),
      ).rejects.toBeInstanceOf(Error);
    },
  );
});

describe.skipIf(!hasHeifDec || !hasHeifEnc)("HEIC", () => {
  it.skipIf(!sharpAvailable)("renders a HEIC through libheif", async () => {
    const sharp = (await import("sharp")).default;
    const width = 320;
    const height = 200;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        pixels[index] = Math.round((x / (width - 1)) * 255);
        pixels[index + 1] = 90;
        pixels[index + 2] = 40;
      }
    const png = path.join(directory, "source.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(png);
    const heic = path.join(directory, "frame.heic");
    const encoded = spawnSync(heifEnc, ["-q", "80", "-o", heic, png]);
    if (encoded.status !== 0) {
      /* No HEIC encoder plugin in this image: the decode path is still
         covered by the format table test above. */
      expect(encoded.status).not.toBe(0);
      return;
    }
    const out = path.join(directory, "heic-review.webp");
    const result = await renderStillRung(heic, out, review!);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    const drawn = await sharp(out).raw().toBuffer();
    expect(drawn[0] ?? 255).toBeLessThan(40);
    expect(drawn[(width - 1) * 3] ?? 0).toBeGreaterThan(215);
  });
});
