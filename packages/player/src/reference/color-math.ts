import type { ReferenceColorContract } from "./protocol.js";

export type ReferenceYuvMatrix = "bt601" | "bt709" | "bt2020-ncl";
export type ReferenceRgb = readonly [number, number, number];
export type ReferenceYuv = readonly [number, number, number];

export type YuvConversionParameters = {
  kr: number;
  kb: number;
  yOffset: number;
  yRange: number;
  chromaOffset: number;
  chromaRange: number;
};

const MATRIX_COEFFICIENTS: Readonly<
  Record<ReferenceYuvMatrix, { kr: number; kb: number }>
> = {
  bt601: { kr: 0.299, kb: 0.114 },
  bt709: { kr: 0.2126, kb: 0.0722 },
  "bt2020-ncl": { kr: 0.2627, kb: 0.0593 },
};

export const referenceMatrixFromMetadata = (
  matrix: string,
): ReferenceYuvMatrix | null => {
  if (matrix === "bt709") return "bt709";
  if (matrix === "bt470bg" || matrix === "smpte170m") return "bt601";
  if (matrix === "bt2020-ncl") return "bt2020-ncl";
  return null;
};

export const yuvConversionParameters = (
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
): YuvConversionParameters => {
  const coefficients = MATRIX_COEFFICIENTS[matrix];
  return {
    ...coefficients,
    yOffset: range === "tv" ? 16 : 0,
    yRange: range === "tv" ? 219 : 255,
    chromaOffset: 128,
    chromaRange: range === "tv" ? 224 : 255,
  };
};

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/*
 * This produces R'G'B' in the matrix's encoded color space. The production SDR
 * rail is display-referred BT.709, whose code values map directly to the sRGB
 * canvas code domain used by the product oracle. Applying the BT.709 camera
 * OETF in reverse would brighten midtones and confuse a scene-referred
 * transform with a display encoding transform. BT.601 and BT.2020 vectors
 * qualify matrix and range math only; their production paths still need an
 * explicit primaries transform.
 */
export const convertYuvCodeToEncodedRgb = (
  yuv: ReferenceYuv,
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
): ReferenceRgb => {
  const parameters = yuvConversionParameters(matrix, range);
  const y = (yuv[0] - parameters.yOffset) / parameters.yRange;
  const cb = (yuv[1] - parameters.chromaOffset) / parameters.chromaRange;
  const cr = (yuv[2] - parameters.chromaOffset) / parameters.chromaRange;
  const kg = 1 - parameters.kr - parameters.kb;
  const red = y + 2 * (1 - parameters.kr) * cr;
  const green =
    y -
    (2 * parameters.kb * (1 - parameters.kb) * cb +
      2 * parameters.kr * (1 - parameters.kr) * cr) /
      kg;
  const blue = y + 2 * (1 - parameters.kb) * cb;
  return [clampUnit(red), clampUnit(green), clampUnit(blue)];
};

export const quantizeEncodedRgb = (
  rgb: ReferenceRgb,
): [number, number, number] => [
  Math.round(rgb[0] * 255),
  Math.round(rgb[1] * 255),
  Math.round(rgb[2] * 255),
];
