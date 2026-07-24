import { describe, expect, it } from "vitest";
import {
  convertYuvCodeToEncodedRgb,
  quantizeEncodedRgb,
  referenceMatrixFromMetadata,
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
