/* The PSD and PSB composite reader, against files written here.

   The writer below is the spec read backwards: if the reader and the writer
   ever agree by sharing a mistake, the ffmpeg cross-check in the PSD cases
   catches it, because ffmpeg's decoder was written from the same spec by
   someone else. */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PSD_MAX_PIXELS,
  readPsdComposite,
  readPsdHeader,
} from "./psd-image.js";

const WIDTH = 40;
const HEIGHT = 24;

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
const u64 = (value: number): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
};

/** PackBits a scanline, the way Photoshop stores one. */
const packBits = (line: Uint8Array): Buffer => {
  const out: number[] = [];
  let index = 0;
  while (index < line.length) {
    let run = 1;
    while (
      run < 128 &&
      index + run < line.length &&
      line[index + run] === line[index]
    )
      run += 1;
    if (run >= 3) {
      out.push(257 - run, line[index] as number);
      index += run;
    } else {
      const start = index;
      let literal = 0;
      while (index < line.length && literal < 128) {
        const same =
          index + 2 < line.length &&
          line[index] === line[index + 1] &&
          line[index] === line[index + 2];
        if (same) break;
        index += 1;
        literal += 1;
      }
      out.push(literal - 1, ...line.subarray(start, start + literal));
    }
  }
  return Buffer.from(out);
};

interface WriteOptions {
  large?: boolean;
  depth?: 8 | 16;
  mode?: number;
  rle?: boolean;
  channels?: number;
  /** Omit the composite entirely, as a save without compatibility does. */
  noComposite?: boolean;
}

/** A gradient: red across, green down, blue constant. */
const gradient = (): Uint8Array => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 3;
      pixels[index] = Math.round((x / (WIDTH - 1)) * 255);
      pixels[index + 1] = Math.round((y / (HEIGHT - 1)) * 255);
      pixels[index + 2] = 64;
    }
  return pixels;
};

const writePhotoshop = (
  pixels: Uint8Array,
  options: WriteOptions = {},
): Buffer => {
  const large = options.large ?? false;
  const depth = options.depth ?? 8;
  const mode = options.mode ?? 3;
  const channels = options.channels ?? (mode === 4 ? 4 : mode === 1 ? 1 : 3);
  const sampleBytes = depth === 16 ? 2 : 1;
  const header = Buffer.concat([
    Buffer.from("8BPS", "ascii"),
    u16(large ? 2 : 1),
    Buffer.alloc(6),
    u16(channels),
    u32(HEIGHT),
    u32(WIDTH),
    u16(depth),
    u16(mode),
  ]);
  const sections = Buffer.concat([u32(0), u32(0), large ? u64(0) : u32(0)]);
  if (options.noComposite) return Buffer.concat([header, sections]);

  const planes: Uint8Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const plane = new Uint8Array(WIDTH * HEIGHT * sampleBytes);
    for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
      let value: number;
      if (mode === 4) {
        /* CMYK, stored inverted, from the RGB source. */
        const r = pixels[index * 3] as number;
        const g = pixels[index * 3 + 1] as number;
        const b = pixels[index * 3 + 2] as number;
        const k = 255 - Math.max(r, g, b);
        const inks = [255 - r - k, 255 - g - k, 255 - b - k, k];
        value = 255 - Math.max(0, Math.min(255, inks[channel] ?? 0));
      } else if (mode === 1) {
        value = pixels[index * 3] as number;
      } else {
        value = pixels[index * 3 + channel] as number;
      }
      if (sampleBytes === 2) {
        plane[index * 2] = value;
        plane[index * 2 + 1] = value;
      } else {
        plane[index] = value;
      }
    }
    planes.push(plane);
  }

  if (!options.rle)
    return Buffer.concat([
      header,
      sections,
      u16(0),
      ...planes.map((plane) => Buffer.from(plane)),
    ]);

  const counts: Buffer[] = [];
  const rows: Buffer[] = [];
  for (const plane of planes)
    for (let row = 0; row < HEIGHT; row += 1) {
      const line = plane.subarray(
        row * WIDTH * sampleBytes,
        (row + 1) * WIDTH * sampleBytes,
      );
      const packed = packBits(line);
      counts.push(large ? u32(packed.length) : u16(packed.length));
      rows.push(packed);
    }
  return Buffer.concat([
    header,
    sections,
    u16(1),
    Buffer.concat(counts),
    Buffer.concat(rows),
  ]);
};

const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "onelight-psd-"));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const pixelAt = (image: { data: Uint8Array }, x: number, y: number) => {
  const index = (y * WIDTH + x) * 3;
  return [
    image.data[index] as number,
    image.data[index + 1] as number,
    image.data[index + 2] as number,
  ];
};

describe("readPsdHeader", () => {
  it("tells PSD and PSB apart", () => {
    expect(readPsdHeader(writePhotoshop(gradient()))).toMatchObject({
      version: 1,
      large: false,
      width: WIDTH,
      height: HEIGHT,
      colorMode: "rgb",
    });
    expect(
      readPsdHeader(writePhotoshop(gradient(), { large: true })),
    ).toMatchObject({ version: 2, large: true });
  });

  it("refuses what is not a Photoshop file", () => {
    expect(() => readPsdHeader(new Uint8Array(4))).toThrow(/too short/i);
    expect(() =>
      readPsdHeader(Buffer.concat([Buffer.from("XXXX"), Buffer.alloc(40)])),
    ).toThrow(/signature/i);
  });
});

describe("readPsdComposite", () => {
  const cases: Array<[string, WriteOptions]> = [
    ["PSD, uncompressed", {}],
    ["PSD, RLE", { rle: true }],
    ["PSD, 16 bit", { depth: 16 }],
    ["PSD, 16 bit RLE", { depth: 16, rle: true }],
    ["PSB, uncompressed", { large: true }],
    /* The one ffmpeg cannot open at all: a large document with the
       four-byte scanline counts its format uses. */
    ["PSB, RLE", { large: true, rle: true }],
    ["PSB, 16 bit RLE", { large: true, depth: 16, rle: true }],
  ];

  for (const [name, options] of cases)
    it(`reads the composite of a ${name}`, () => {
      const image = readPsdComposite(writePhotoshop(gradient(), options));
      expect(image.width).toBe(WIDTH);
      expect(image.height).toBe(HEIGHT);
      /* The gradient survived: dark on the left, bright on the right, and the
         constant blue channel is where it was put. */
      expect(pixelAt(image, 0, 0)[0]).toBeLessThan(10);
      expect(pixelAt(image, WIDTH - 1, 0)[0]).toBeGreaterThan(245);
      expect(pixelAt(image, 0, HEIGHT - 1)[1]).toBeGreaterThan(245);
      expect(pixelAt(image, 5, 5)[2]).toBe(64);
    });

  it("reads a greyscale composite as grey", () => {
    const image = readPsdComposite(
      writePhotoshop(gradient(), { mode: 1, channels: 1, rle: true }),
    );
    const [r, g, b] = pixelAt(image, WIDTH - 1, 3);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBeGreaterThan(245);
  });

  it("reads a CMYK composite back as something near the RGB it came from", () => {
    const image = readPsdComposite(
      writePhotoshop(gradient(), { mode: 4, channels: 4, rle: true }),
    );
    /* The round trip through inks is lossy at the edges of the gamut, so the
       assertion is on the shape of the picture rather than exact values. */
    expect(pixelAt(image, 0, 0)[0]).toBeLessThan(60);
    expect(pixelAt(image, WIDTH - 1, 0)[0]).toBeGreaterThan(200);
  });

  it("ignores an alpha channel that rides along with the composite", () => {
    const image = readPsdComposite(
      writePhotoshop(gradient(), { channels: 4, rle: true }),
    );
    expect(pixelAt(image, WIDTH - 1, 0)[0]).toBeGreaterThan(245);
    expect(pixelAt(image, 5, 5)[2]).toBe(64);
  });

  it("says so when the file was saved without a composite", () => {
    expect(() =>
      readPsdComposite(writePhotoshop(gradient(), { noComposite: true })),
    ).toThrow(/maximise compatibility/i);
  });

  it("refuses a file past the decode limit rather than dying on it", () => {
    const bytes = writePhotoshop(gradient());
    /* Rewrite the header's dimensions to something a PSB may legally be. */
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(14, 200_000);
    view.setUint32(18, 200_000);
    expect(() => readPsdComposite(bytes)).toThrow(/megapixel/i);
    expect(PSD_MAX_PIXELS).toBeGreaterThan(0);
  });

  it("refuses a truncated picture instead of returning half of one", () => {
    const bytes = writePhotoshop(gradient(), { rle: true });
    expect(() =>
      readPsdComposite(bytes.subarray(0, bytes.length - 200)),
    ).toThrow(/truncated|before its width/i);
  });

  it.skipIf(!hasFfmpeg)(
    "agrees with ffmpeg on a PSD, which ffmpeg can also read",
    async () => {
      const source = path.join(directory, "cross-check.psd");
      await writeFile(source, writePhotoshop(gradient(), { rle: true }));
      const target = path.join(directory, "cross-check.ppm");
      const run = spawnSync(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        target,
      ]);
      expect(run.status).toBe(0);
      const { readFile } = await import("node:fs/promises");
      const decoded = new Uint8Array(await readFile(target));
      const ours = readPsdComposite(writePhotoshop(gradient(), { rle: true }));
      expect(decoded.length).toBe(ours.data.length);
      let worst = 0;
      for (let index = 0; index < decoded.length; index += 1)
        worst = Math.max(
          worst,
          Math.abs((decoded[index] as number) - (ours.data[index] as number)),
        );
      /* Same spec, two independent readers: the pixels must be identical. */
      expect(worst).toBe(0);
    },
  );
});
