import type { ReferenceColorContract } from "./protocol.js";

/*
 * The display transfer decides how the decoded, range-expanded, matrixed
 * BT.709 code values are re-encoded for the sRGB output canvas.
 *
 * - "srgb": treat the code values as already sRGB-encoded and pass them
 *   through. This is the web/consumer convention and what a browser's own
 *   <video> element does on a plain sRGB display.
 * - "bt1886": treat the code values as BT.1886 display-referred (pure 2.4
 *   gamma, the ITU reference EOTF for BT.709 SDR finishing). Decode to linear
 *   light and re-encode to sRGB so a reference monitor's shadow contrast
 *   survives onto the sRGB canvas. Shadows land ~11-13/255 darker than "srgb".
 * - "gamma22": treat the code values as a pure 2.2 power curve. The house
 *   standard in a lot of finishing rooms and the thing people mean when they
 *   say "709 2.2". It is NOT sRGB: sRGB's linear toe near black makes it
 *   lighter in the shadows than a true 2.2, and the difference shows exactly
 *   where a grade is argued about.
 */
export type ReferenceDisplayTransfer = "srgb" | "bt1886" | "gamma22";

const BT1886_GAMMA = 2.4;
const PURE_GAMMA_22 = 2.2;

/* The pure-power transfers differ only in their exponent; sRGB is the odd one
   out because it is piecewise and is already the canvas's own encoding. */
const DISPLAY_GAMMA: Readonly<Record<ReferenceDisplayTransfer, number | null>> =
  {
    srgb: null,
    bt1886: BT1886_GAMMA,
    gamma22: PURE_GAMMA_22,
  };

const srgbEncodeChannel = (linear: number): number =>
  linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;

export const encodeForDisplay = (
  rgb: ReferenceRgb,
  transfer: ReferenceDisplayTransfer,
): ReferenceRgb => {
  const gamma = DISPLAY_GAMMA[transfer];
  if (gamma === null) return rgb;
  return [
    clampUnit(srgbEncodeChannel(Math.pow(clampUnit(rgb[0]), gamma))),
    clampUnit(srgbEncodeChannel(Math.pow(clampUnit(rgb[1]), gamma))),
    clampUnit(srgbEncodeChannel(Math.pow(clampUnit(rgb[2]), gamma))),
  ];
};

const normalizedTransferTag = (value: string | null | undefined): string =>
  (value ?? "").toLowerCase().replace(/[._\s-]/g, "");

export const isDisplayTransfer = (
  value: string | null | undefined,
): value is ReferenceDisplayTransfer =>
  value === "srgb" || value === "bt1886" || value === "gamma22";

/*
 * What the file says it is. A tag is evidence, not an instruction, and only
 * two answers are ever safe to read off one:
 *
 * - sRGB / IEC 61966-2-1: authored for a screen, piecewise curve, leave it.
 * - BT.470M and the explicit gamma-2.2 tags: a real 2.2 power curve. These
 *   used to resolve to sRGB because sRGB was the closest thing on offer;
 *   with a true 2.2 in the set they resolve to what they actually say, which
 *   moves their shadows where a colourist would expect them.
 *
 * Everything else -- BT.709, SMPTE 170M, unknown, or a tag the pipeline had
 * to assume -- is post-production material, and the reference standard for
 * that is BT.1886.
 */
export const inferDisplayTransfer = (
  sourceTransfer: string | null | undefined,
): ReferenceDisplayTransfer => {
  const tag = normalizedTransferTag(sourceTransfer);
  if (tag === "iec6196621" || tag === "srgb") return "srgb";
  if (tag === "bt470m" || tag === "gamma22" || tag === "22") return "gamma22";
  return "bt1886";
};

/*
 * Who decides, in order: this asset, then the project's house standard, then
 * the file's own tag, then the reference default. Each step is a deliberate
 * human choice until the last two, so a delivery that differs from the house
 * can be corrected on the asset without disturbing everything around it, and
 * a project that finishes to 2.2 stops re-deciding that per upload.
 *
 * Callers may pass anything; only values that name a transfer we implement
 * take effect, so a stale row or a hand-edited setting degrades to inference
 * rather than to a broken render.
 */
export const resolveDisplayTransfer = (
  override: string | null | undefined,
  sourceTransfer: string | null | undefined,
  projectDefault?: string | null | undefined,
): ReferenceDisplayTransfer => {
  if (isDisplayTransfer(override)) return override;
  if (isDisplayTransfer(projectDefault)) return projectDefault;
  return inferDisplayTransfer(sourceTransfer);
};

/*
 * Transfer tags an SDR BT.709 surface may legitimately arrive with. A decoded
 * frame's transfer tag is descriptive, not an instruction: nothing in the
 * decode path applies it, and the output encoding comes from
 * resolveDisplayTransfer. Apple's decoders tag BT.709 surfaces
 * "iec61966-2-1", because macOS treats BT.709 as sRGB, so demanding an exact
 * "bt709" match refuses every frame Safari produces. "linear", "pq" and "hlg"
 * describe genuinely different code values and stay rejected.
 */
export const isSdrGammaTransfer = (
  value: string | null | undefined,
): boolean => {
  const tag = normalizedTransferTag(value);
  return (
    tag === "bt709" ||
    tag === "rec709" ||
    tag === "smpte170m" ||
    tag === "iec6196621" ||
    tag === "srgb"
  );
};

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
