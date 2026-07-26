import { describe, expect, it } from "vitest";
import {
  convertYuvCodeToEncodedRgb,
  encodeForDisplay,
  isSdrGammaTransfer,
  quantizeEncodedRgb,
  referenceMatrixFromMetadata,
  resolveDisplayTransfer,
  type ReferenceRgb,
  type ReferenceYuv,
  type ReferenceYuvMatrix,
} from "./color-math.js";
import type { ReferenceColorContract } from "./protocol.js";

type Vector = {
  name: string;
  yuv: ReferenceYuv;
  rgb: readonly [number, number, number];
};

const VECTOR_TARGETS = [
  ["black", [0, 0, 0]],
  ["white", [255, 255, 255]],
  ["grey40", [102, 102, 102]],
  ["white75", [191, 191, 191]],
  ["red75", [191, 0, 0]],
  ["green75", [0, 191, 0]],
  ["blue75", [0, 0, 191]],
  ["cyan75", [0, 191, 191]],
  ["magenta75", [191, 0, 191]],
  ["yellow75", [191, 191, 0]],
] as const;

const expectVector = (
  vector: Vector,
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
): void => {
  const actual = quantizeEncodedRgb(
    convertYuvCodeToEncodedRgb(vector.yuv, matrix, range),
  );
  for (const channel of [0, 1, 2] as const)
    expect(
      Math.abs(actual[channel] - vector.rgb[channel]),
      `${matrix} ${range} ${vector.name} channel ${channel}: ${actual.join(",")}`,
    ).toBeLessThanOrEqual(1);
};

const YUV_VECTORS: Readonly<
  Record<
    ReferenceYuvMatrix,
    Readonly<Record<ReferenceColorContract["range"], readonly ReferenceYuv[]>>
  >
> = {
  bt601: {
    tv: [
      [16, 128, 128],
      [235, 128, 128],
      [104, 128, 128],
      [180, 128, 128],
      [65, 100, 212],
      [112, 72, 58],
      [35, 212, 114],
      [131, 156, 44],
      [84, 184, 198],
      [162, 44, 142],
    ],
    pc: [
      [0, 128, 128],
      [255, 128, 128],
      [102, 128, 128],
      [191, 128, 128],
      [57, 96, 224],
      [112, 65, 48],
      [22, 224, 112],
      [134, 160, 32],
      [79, 191, 208],
      [169, 32, 144],
    ],
  },
  bt709: {
    tv: [
      [16, 128, 128],
      [235, 128, 128],
      [104, 128, 128],
      [180, 128, 128],
      [51, 109, 212],
      [133, 63, 52],
      [28, 212, 120],
      [145, 147, 44],
      [63, 193, 204],
      [168, 44, 136],
    ],
    pc: [
      [0, 128, 128],
      [255, 128, 128],
      [102, 128, 128],
      [191, 128, 128],
      [41, 106, 224],
      [137, 54, 41],
      [14, 224, 119],
      [151, 150, 32],
      [54, 202, 215],
      [177, 32, 137],
    ],
  },
  "bt2020-ncl": {
    tv: [
      [16, 128, 128],
      [235, 128, 128],
      [104, 128, 128],
      [180, 128, 128],
      [59, 105, 212],
      [127, 67, 51],
      [26, 212, 121],
      [137, 151, 44],
      [69, 189, 205],
      [171, 44, 135],
    ],
    pc: [
      [0, 128, 128],
      [255, 128, 128],
      [102, 128, 128],
      [191, 128, 128],
      [50, 101, 224],
      [130, 59, 40],
      [11, 224, 120],
      [141, 155, 32],
      [62, 197, 216],
      [180, 32, 136],
    ],
  },
};

const vectorsFor = (
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
): Vector[] =>
  VECTOR_TARGETS.map(([name, rgb], index) => {
    const yuv = YUV_VECTORS[matrix][range][index];
    if (!yuv) throw new Error(`${matrix} ${range} ${name} vector is missing.`);
    return { name, yuv, rgb };
  });

describe("reference YUV color math", () => {
  it("maps WebCodecs matrix metadata without guessing", () => {
    expect(referenceMatrixFromMetadata("bt709")).toBe("bt709");
    expect(referenceMatrixFromMetadata("bt470bg")).toBe("bt601");
    expect(referenceMatrixFromMetadata("smpte170m")).toBe("bt601");
    expect(referenceMatrixFromMetadata("bt2020-ncl")).toBe("bt2020-ncl");
    expect(referenceMatrixFromMetadata("rgb")).toBeNull();
    expect(referenceMatrixFromMetadata("unknown")).toBeNull();
  });

  it("matches every matrix, range, neutral, and 75 percent color vector", () => {
    for (const matrix of ["bt601", "bt709", "bt2020-ncl"] as const)
      for (const range of ["tv", "pc"] as const)
        for (const vector of vectorsFor(matrix, range))
          expectVector(vector, matrix, range);
  });

  it("clamps only the final encoded output", () => {
    const rgb: ReferenceRgb = convertYuvCodeToEncodedRgb(
      [16, 16, 240],
      "bt709",
      "tv",
    );
    expect(rgb[0]).toBeGreaterThan(0);
    expect(rgb[0]).toBeLessThan(1);
    expect(rgb[1]).toBe(0);
    expect(rgb[2]).toBe(0);
  });
});

describe("display transfer", () => {
  it("passes sRGB code values through unchanged", () => {
    for (const v of [0, 0.1, 0.4, 0.749, 1] as const)
      expect(encodeForDisplay([v, v, v], "srgb")).toEqual([v, v, v]);
  });

  it("darkens shadows under BT.1886 while pinning the endpoints", () => {
    // Endpoints are invariant; a mid grey lands ~8/255 darker than sRGB.
    expect(quantizeEncodedRgb(encodeForDisplay([0, 0, 0], "bt1886"))).toEqual([
      0, 0, 0,
    ]);
    expect(quantizeEncodedRgb(encodeForDisplay([1, 1, 1], "bt1886"))).toEqual([
      255, 255, 255,
    ]);
    const grey40 = quantizeEncodedRgb(
      encodeForDisplay([0.4, 0.4, 0.4], "bt1886"),
    );
    expect(grey40[0]).toBe(94);
    // Every non-endpoint code is darker than the straight sRGB code.
    for (const v of [0.1, 0.2, 0.4, 0.6, 0.8] as const)
      expect(encodeForDisplay([v, v, v], "bt1886")[0]).toBeLessThan(v);
  });

  it("holds a pure 2.2 apart from sRGB where a grade is argued about", () => {
    // Endpoints pin, as they must for any of these curves.
    expect(quantizeEncodedRgb(encodeForDisplay([0, 0, 0], "gamma22"))).toEqual([
      0, 0, 0,
    ]);
    expect(quantizeEncodedRgb(encodeForDisplay([1, 1, 1], "gamma22"))).toEqual([
      255, 255, 255,
    ]);
    /* 2.2 is always lighter than the 2.4 reference: that is the rung. */
    for (const v of [0.1, 0.2, 0.4, 0.6, 0.8] as const)
      expect(encodeForDisplay([v, v, v], "gamma22")[0]).toBeGreaterThan(
        encodeForDisplay([v, v, v], "bt1886")[0],
      );

    /* Against sRGB the difference is a shadow difference and nothing else.
       sRGB's linear toe lifts the bottom of the scale, so a true 2.2 sits
       clearly under it there -- 0.1 encodes to 19/255 rather than 26 -- while
       the two converge to within half a code by the upper midtones. Anyone
       arguing about a grade is arguing about the first number. */
    const shadow = quantizeEncodedRgb(
      encodeForDisplay([0.1, 0.1, 0.1], "gamma22"),
    );
    expect(shadow[0]).toBe(19);
    expect(
      quantizeEncodedRgb(encodeForDisplay([0.1, 0.1, 0.1], "srgb"))[0],
    ).toBe(26);
    for (const v of [0.6, 0.8] as const)
      expect(
        Math.abs(
          encodeForDisplay([v, v, v], "gamma22")[0] -
            encodeForDisplay([v, v, v], "srgb")[0],
        ),
      ).toBeLessThan(0.006);
  });

  it("resolves the transfer from the asset, then the project, then the tag", () => {
    // An explicit choice on the asset always wins.
    expect(resolveDisplayTransfer("srgb", "bt709")).toBe("srgb");
    expect(resolveDisplayTransfer("bt1886", "iec61966-2-1")).toBe("bt1886");
    expect(resolveDisplayTransfer("gamma22", "bt709")).toBe("gamma22");
    // Then the project's house standard, for anything the asset left alone.
    expect(resolveDisplayTransfer(null, "bt709", "gamma22")).toBe("gamma22");
    expect(resolveDisplayTransfer(undefined, "iec61966-2-1", "bt1886")).toBe(
      "bt1886",
    );
    // An asset choice still beats the project.
    expect(resolveDisplayTransfer("srgb", "bt709", "gamma22")).toBe("srgb");
    // A junk setting at either level falls through rather than rendering wrong.
    expect(resolveDisplayTransfer("garbage", "bt709")).toBe("bt1886");
    expect(resolveDisplayTransfer(null, "bt709", "garbage")).toBe("bt1886");
    // Then the file's own tag. sRGB-authored material stays sRGB.
    expect(resolveDisplayTransfer(null, "iec61966-2-1")).toBe("srgb");
    expect(resolveDisplayTransfer(undefined, "sRGB")).toBe("srgb");
    // A tag that says 2.2 now gets a real 2.2 instead of sRGB's approximation.
    expect(resolveDisplayTransfer(null, "bt470m")).toBe("gamma22");
    expect(resolveDisplayTransfer(null, "gamma22")).toBe("gamma22");
    // BT.709 / SMPTE 170M / unknown / missing all resolve to the reference default.
    expect(resolveDisplayTransfer(null, "bt709")).toBe("bt1886");
    expect(resolveDisplayTransfer(null, "smpte170m")).toBe("bt1886");
    expect(resolveDisplayTransfer(null, null)).toBe("bt1886");
  });

  it("treats the SDR gamma tags as one family and nothing else", () => {
    // The tags real decoders put on a BT.709 SDR surface. Safari reports
    // "iec61966-2-1" for every H.264 BT.709 proxy it decodes.
    for (const tag of [
      "bt709",
      "BT.709",
      "rec709",
      "smpte170m",
      "iec61966-2-1",
      "iec61966_2_1",
      "srgb",
    ])
      expect(isSdrGammaTransfer(tag)).toBe(true);
    // Different code values, not a different name for the same ones.
    for (const tag of ["pq", "hlg", "linear", "smpte2084", "", null, undefined])
      expect(isSdrGammaTransfer(tag)).toBe(false);
  });
});
