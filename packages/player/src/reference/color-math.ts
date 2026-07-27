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

const srgbDecodeChannel = (encoded: number): number =>
  encoded <= 0.04045
    ? encoded / 12.92
    : Math.pow((encoded + 0.055) / 1.055, 2.4);

/*
 * Code values in, canvas code values out.
 *
 * With no gamut conversion to do this is what it always was: sRGB passes
 * through untouched, and a power curve decodes with its exponent and
 * re-encodes for the canvas. The passthrough is load-bearing rather than an
 * optimisation -- the measured 0/255 GL-versus-CPU agreement on a 709 frame
 * depends on those values never making a round trip through linear.
 *
 * With a gamut to convert there is no way around linear light, so sRGB code
 * values get decoded first and everything takes the long path. The output
 * encoding is sRGB's curve either way: a display-p3 canvas is P3 primaries
 * with the sRGB transfer function, so only the matrix changes.
 */
export const encodeForDisplay = (
  rgb: ReferenceRgb,
  transfer: ReferenceDisplayTransfer,
  gamut: Matrix3 = IDENTITY3,
): ReferenceRgb => {
  const gamma = DISPLAY_GAMMA[transfer];
  const identity = isIdentityGamut(gamut);
  if (gamma === null && identity) return rgb;
  const linear: ReferenceRgb =
    gamma === null
      ? [
          srgbDecodeChannel(clampUnit(rgb[0])),
          srgbDecodeChannel(clampUnit(rgb[1])),
          srgbDecodeChannel(clampUnit(rgb[2])),
        ]
      : [
          Math.pow(clampUnit(rgb[0]), gamma),
          Math.pow(clampUnit(rgb[1]), gamma),
          Math.pow(clampUnit(rgb[2]), gamma),
        ];
  const converted = identity ? linear : applyGamut(linear, gamut);
  return [
    clampUnit(srgbEncodeChannel(clampUnit(converted[0]))),
    clampUnit(srgbEncodeChannel(clampUnit(converted[1]))),
    clampUnit(srgbEncodeChannel(clampUnit(converted[2]))),
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
  projectDefault?: string | null,
): ReferenceDisplayTransfer => {
  if (isDisplayTransfer(override)) return override;
  if (isDisplayTransfer(projectDefault)) return projectDefault;
  return inferDisplayTransfer(sourceTransfer);
};

/*
 * Is this an SDR gamma transfer?
 *
 * Tolerant by default, strict only where the maths genuinely differs. This
 * began as an allow-list of spellings and the list was always going to be
 * wrong: it refused a Rec.709 file tagged with a true 2.2 transfer -- an
 * entirely ordinary thing to be handed -- purely because "bt470m" was not
 * written in it. A tag is evidence about a gamma curve whose exact shape the
 * display-transfer control already owns; it is not grounds to refuse a file.
 * So anything unrecognised, unspecified, or from the gamma family is SDR.
 *
 * Four transfers are not that, and they are excluded by name rather than by
 * omission. PQ and HLG describe absolute light. Linear and the log encodings
 * describe scene-referred values. Rendering any of them as though they were a
 * gamma curve would be visibly wrong, not marginally wrong, so they take
 * their own path or none.
 */
export const isSdrGammaTransfer = (
  value: string | null | undefined,
): boolean => {
  if (referenceSourceTransfer(value) !== "sdr") return false;
  const tag = normalizedTransferTag(value);
  return !(tag === "linear" || tag.startsWith("log"));
};

/*
 * Colour primaries, in the spellings WebCodecs uses, because the decoded
 * frame is where they arrive. "smpte432" is Display P3 and "bt470bg" is EBU
 * 3213 / PAL; every one of these is a D65 white, so converting between them
 * is a single 3x3 in linear light with no chromatic adaptation.
 *
 * The matrix a stream carries is not its gamut: BT.709 matrix coefficients
 * are routinely used with P3 primaries. They are decoded separately and must
 * be handled separately, which is the whole reason this type exists apart
 * from ReferenceYuvMatrix.
 */
export type ReferencePrimaries =
  "bt709" | "smpte170m" | "bt470bg" | "bt2020" | "smpte432";

export type Matrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/* xy chromaticities of each gamut's primaries, and the D65 white they all
   share. Straight from the specs; the matrices are derived, never typed in,
   so a transcription error cannot hide in a pre-multiplied constant. */
const PRIMARY_CHROMATICITIES: Readonly<
  Record<
    ReferencePrimaries,
    readonly [number, number, number, number, number, number]
  >
> = {
  bt709: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06],
  smpte170m: [0.63, 0.34, 0.31, 0.595, 0.155, 0.07],
  bt470bg: [0.64, 0.33, 0.29, 0.6, 0.15, 0.06],
  bt2020: [0.708, 0.292, 0.17, 0.797, 0.131, 0.046],
  smpte432: [0.68, 0.32, 0.265, 0.69, 0.15, 0.06],
};

const D65: readonly [number, number] = [0.3127, 0.329];

const invert3 = (m: Matrix3): Matrix3 => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12)
    throw new RangeError("Primaries matrix is not invertible.");
  return [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
};

const multiply3 = (left: Matrix3, right: Matrix3): Matrix3 => {
  const out = new Array<number>(9);
  for (let row = 0; row < 3; row += 1)
    for (let column = 0; column < 3; column += 1)
      out[row * 3 + column] =
        (left[row * 3] ?? 0) * (right[column] ?? 0) +
        (left[row * 3 + 1] ?? 0) * (right[3 + column] ?? 0) +
        (left[row * 3 + 2] ?? 0) * (right[6 + column] ?? 0);
  return out as unknown as Matrix3;
};

/* The standard construction: scale each primary's XYZ so the three together
   sum to the white point, giving the RGB-to-XYZ matrix for that gamut. */
export const primariesToXyz = (primaries: ReferencePrimaries): Matrix3 => {
  const [xr, yr, xg, yg, xb, yb] = PRIMARY_CHROMATICITIES[primaries];
  const column = (x: number, y: number): readonly [number, number, number] => [
    x / y,
    1,
    (1 - x - y) / y,
  ];
  const r = column(xr, yr);
  const g = column(xg, yg);
  const b = column(xb, yb);
  const white = column(D65[0], D65[1]);
  const scale = multiply3(
    invert3([r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]),
    [white[0], 0, 0, white[1], 0, 0, white[2], 0, 0],
  );
  const [sr, sg, sb] = [scale[0], scale[3], scale[6]];
  return [
    r[0] * sr,
    g[0] * sg,
    b[0] * sb,
    r[1] * sr,
    g[1] * sg,
    b[1] * sb,
    r[2] * sr,
    g[2] * sg,
    b[2] * sb,
  ];
};

const IDENTITY3: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/*
 * Source gamut to output gamut, in linear light. Identity when they match,
 * which is both the common case and the one that must stay bit-exact: the
 * measured GL-versus-CPU parity depends on a 709 frame on an sRGB canvas
 * touching no colour matrix at all.
 */
export const gamutConversionMatrix = (
  source: ReferencePrimaries,
  output: ReferencePrimaries,
): Matrix3 =>
  source === output
    ? IDENTITY3
    : multiply3(invert3(primariesToXyz(output)), primariesToXyz(source));

export const isIdentityGamut = (matrix: Matrix3): boolean =>
  matrix.every(
    (value, index) => Math.abs(value - (IDENTITY3[index] ?? 0)) < 1e-9,
  );

export const applyGamut = (
  rgb: ReferenceRgb,
  matrix: Matrix3,
): ReferenceRgb => [
  matrix[0] * rgb[0] + matrix[1] * rgb[1] + matrix[2] * rgb[2],
  matrix[3] * rgb[0] + matrix[4] * rgb[1] + matrix[5] * rgb[2],
  matrix[6] * rgb[0] + matrix[7] * rgb[1] + matrix[8] * rgb[2],
];

/* WebCodecs may hand back a primaries string we do not implement, or none at
   all. Unknown is not guessed at: the caller treats null as "cannot vouch for
   the gamut" and the contract stays fail-closed. */
export const referencePrimariesFromMetadata = (
  primaries: string | null | undefined,
): ReferencePrimaries | null => {
  if (
    primaries === "bt709" ||
    primaries === "smpte170m" ||
    primaries === "bt470bg" ||
    primaries === "bt2020" ||
    primaries === "smpte432"
  )
    return primaries;
  return null;
};

export type ReferenceYuvMatrix = "bt601" | "bt709" | "bt2020-ncl";
export type ReferenceRgb = readonly [number, number, number];
export type ReferenceYuv = readonly [number, number, number];

export type YuvConversionParameters = {
  kr: number;
  kb: number;
  /* Full-scale code for the sample depth these levels belong to; every offset
     and range below is in those units and must be normalised against it. */
  maxCode: number;
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
  /* Both the WebCodecs spelling and ffprobe's, because renditions carry the
     latter and decoded frames the former. */
  if (matrix === "bt2020-ncl" || matrix === "bt2020nc") return "bt2020-ncl";
  return null;
};

/*
 * Studio-range levels do NOT scale between bit depths by simply reusing the
 * 8-bit fractions: 16/255 is 0.062745 where 64/1023 is 0.062561, and nominal
 * 10-bit white under 8-bit constants lands on 0.9969 instead of 1, which is
 * 0.8 of a code at 8-bit output and considerably more in PQ, where the curve
 * is steep near white. The levels are therefore taken from the depth.
 */
export const yuvConversionParameters = (
  matrix: ReferenceYuvMatrix,
  range: ReferenceColorContract["range"],
  depth: 8 | 10 = 8,
): YuvConversionParameters => {
  const coefficients = MATRIX_COEFFICIENTS[matrix];
  const maxCode = depth === 10 ? 1023 : 255;
  const scale = depth === 10 ? 4 : 1;
  return {
    ...coefficients,
    maxCode,
    yOffset: range === "tv" ? 16 * scale : 0,
    yRange: range === "tv" ? 219 * scale : maxCode,
    chromaOffset: 128 * scale,
    chromaRange: range === "tv" ? 224 * scale : maxCode,
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

/*
 * Whether to ask for a wide-gamut drawing buffer for this content on this
 * display.
 *
 * Only when it buys something. Content already inside BT.709 gains nothing
 * from a P3 canvas and loses the passthrough: 709 into a P3 buffer is a real
 * matrix, so every frame would take the long path through linear light for no
 * visible difference and the measured bit-exactness would go with it. Content
 * wider than 709 on a display that can show it is the case worth the cost --
 * anything else converts down, which is accurate but gamut-limited.
 */
export const wantsWideGamutOutput = (
  sourcePrimaries: string | null | undefined,
  displaySupportsP3: boolean,
): boolean => {
  if (!displaySupportsP3) return false;
  const primaries = referencePrimariesFromMetadata(sourcePrimaries);
  return primaries === "smpte432" || primaries === "bt2020";
};

/*
 * HDR electro-optical transfer functions.
 *
 * These differ from the SDR curves in kind, not degree: an SDR code value is
 * display-referred and relative, where a PQ code value names an absolute
 * luminance in nits. Linearising one gives light, not a 0-1 signal, so the
 * result has to be tone-mapped before it can go anywhere near an SDR canvas.
 */
export type ReferenceSourceTransfer = "sdr" | "pq" | "hlg";

/* ST.2084 constants, as published. */
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
const PQ_PEAK_NITS = 10000;

/* PQ code value to absolute luminance in nits. */
export const pqEotfNits = (code: number): number => {
  const value = Math.pow(clampUnit(code), 1 / PQ_M2);
  const numerator = Math.max(value - PQ_C1, 0);
  const denominator = PQ_C2 - PQ_C3 * value;
  if (denominator <= 0) return 0;
  return PQ_PEAK_NITS * Math.pow(numerator / denominator, 1 / PQ_M1);
};

/*
 * HLG, ARIB STD-B67. The inverse OETF gives a scene-referred signal; the OOTF
 * that follows is what makes it display light, and its system gamma depends on
 * the peak luminance the display is being driven to.
 */
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

export const hlgInverseOetf = (code: number): number => {
  const value = clampUnit(code);
  return value <= 0.5
    ? (value * value) / 3
    : (Math.exp((value - HLG_C) / HLG_A) + HLG_B) / 12;
};

/*
 * HDR linear light to a display-linear 0-1 signal.
 *
 * Extended Reinhard, in units where the grade's diffuse white is 1. It is
 * within a hair of the identity near black, so anything at or below diffuse
 * white is reproduced as authored, and it reaches exactly 1 at the peak the
 * grade was mastered to, so specular highlights roll off into the headroom
 * instead of clipping to a flat white.
 *
 * Applied to luminance rather than per channel on purpose: one scale factor
 * across the three cannot pull them apart, so a tone-mapped highlight keeps
 * its hue where a per-channel curve would desaturate it towards white.
 */
export const toneMapNits = (
  nits: number,
  referenceWhiteNits = 203,
  peakNits = 1000,
): number => {
  if (nits <= 0) return 0;
  const white = Math.max(peakNits / referenceWhiteNits, 1);
  const scene = nits / referenceWhiteNits;
  const mapped = (scene * (1 + scene / (white * white))) / (1 + scene);
  return clampUnit(mapped);
};

/* Rec.709 luminance weights, for tone-mapping a colour by its brightness. */
export const relativeLuminance = (rgb: ReferenceRgb): number =>
  0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/* Which linearisation a decoded frame needs. PQ and HLG name genuinely
   different code values; everything else in the SDR family is a label the
   renderer does not apply. */
export const referenceSourceTransfer = (
  value: string | null | undefined,
): ReferenceSourceTransfer => {
  const tag = normalizedTransferTag(value);
  if (tag === "pq" || tag === "smpte2084" || tag === "smptest2084") return "pq";
  if (tag === "hlg" || tag === "aribstdb67") return "hlg";
  return "sdr";
};

export const isHdrTransfer = (value: string | null | undefined): boolean =>
  referenceSourceTransfer(value) !== "sdr";

/* ---- BT.2390 tone mapping in ICtCp ------------------------------------- */

/*
 * Why this replaces a Reinhard curve on RGB luminance.
 *
 * Two problems with tone-mapping in linear light. Perceptual spacing: linear
 * light gives most of its numeric range to highlights nobody is looking at,
 * so a curve that behaves in the mid-tones misbehaves in the shadows. And
 * hue: any curve applied per channel, or applied to a luminance derived from
 * RGB and then multiplied back, drags colour towards the achromatic axis as
 * it compresses -- the tell of a bad HDR conversion, oranges going yellow and
 * skies going pale.
 *
 * ICtCp answers both. It is Dolby's perceptually uniform opponent space: I is
 * intensity on the PQ curve, and hue is the angle of (Ct, Cp). Compressing I
 * and scaling Ct and Cp by the same factor cannot rotate that angle, so hue
 * is preserved by construction rather than by correction. BT.2390's EETF is
 * then applied to I in the PQ domain, where equal steps are equally visible:
 * a 1:1 segment through the range the display can already show, and a Hermite
 * shoulder that rolls the rest off with matched slope so there is no seam.
 */

/* Inverse PQ: absolute luminance in nits to a PQ code value. */
export const pqInverseEotf = (nits: number): number => {
  const y = Math.max(nits, 0) / PQ_PEAK_NITS;
  const ym = Math.pow(y, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym), PQ_M2);
};

/*
 * The BT.2390 EETF, operating on PQ code values.
 *
 * Everything below the knee is passed through untouched, so material the
 * display can already show is not altered at all -- the property a colourist
 * is actually asking about. Above it, a cubic Hermite spline leaves the knee
 * with slope 1 and arrives at the display peak with slope 0.
 */
export const bt2390Eetf = (
  pqCode: number,
  sourcePeakNits: number,
  displayPeakNits: number,
  displayBlackNits = 0,
): number => {
  const iw = pqInverseEotf(sourcePeakNits);
  const ib = 0;
  const ow = pqInverseEotf(displayPeakNits);
  const ob = pqInverseEotf(displayBlackNits);
  if (iw <= ib) return pqCode;
  /* A display that can already show the whole source has nothing to roll
     off, and forcing it through the spline would compress for no reason. */
  if (ow >= iw) return pqCode;
  const e1 = (pqCode - ib) / (iw - ib);
  const maxLum = (ow - ib) / (iw - ib);
  const minLum = (ob - ib) / (iw - ib);
  const ks = 1.5 * maxLum - 0.5;
  let e2 = e1;
  if (e1 > ks && ks < 1) {
    const t = (e1 - ks) / (1 - ks);
    const t2 = t * t;
    const t3 = t2 * t;
    e2 =
      (2 * t3 - 3 * t2 + 1) * ks +
      (t3 - 2 * t2 + t) * (1 - ks) +
      (-2 * t3 + 3 * t2) * maxLum;
  }
  /* Black lift, quartic so it dies away before it can touch the mid-tones. */
  const e3 = e2 + minLum * Math.pow(1 - e2, 4);
  return clampUnit(e3 * (iw - ib) + ib);
};

/* Dolby's ICtCp matrices, exact rationals over 4096. */
const RGB2020_TO_LMS: Matrix3 = [
  1688 / 4096,
  2146 / 4096,
  262 / 4096,
  683 / 4096,
  2951 / 4096,
  462 / 4096,
  99 / 4096,
  309 / 4096,
  3688 / 4096,
];
const LMS_TO_ICTCP: Matrix3 = [
  2048 / 4096,
  2048 / 4096,
  0,
  6610 / 4096,
  -13613 / 4096,
  7003 / 4096,
  17933 / 4096,
  -17390 / 4096,
  -543 / 4096,
];
const LMS_FROM_RGB2020 = invert3(RGB2020_TO_LMS);
const ICTCP_TO_LMS = invert3(LMS_TO_ICTCP);

/*
 * BT.2020 linear light in nits, tone-mapped for a display of the given peak,
 * returned as BT.2020 linear light scaled so the display peak is 1.
 */
export const toneMapIctcp = (
  rgbNits: ReferenceRgb,
  sourcePeakNits = 1000,
  displayPeakNits = 203,
): ReferenceRgb => {
  const lms = applyGamut(rgbNits, RGB2020_TO_LMS);
  const lmsPq: ReferenceRgb = [
    pqInverseEotf(lms[0]),
    pqInverseEotf(lms[1]),
    pqInverseEotf(lms[2]),
  ];
  const ictcp = applyGamut(lmsPq, LMS_TO_ICTCP);
  const intensity = ictcp[0];
  if (intensity <= 0) return [0, 0, 0];
  const mapped = bt2390Eetf(intensity, sourcePeakNits, displayPeakNits);
  /* One factor on both chroma axes: the hue angle atan2(Cp, Ct) is invariant
     under it, so compression changes how bright and how saturated a colour
     is and never which colour it is. */
  const scale = mapped / intensity;
  /*
   * Compressing intensity does not land the colour inside the display cube: a
   * saturated one has channels above its own luminance by definition, and on
   * a real 1000-nit grade that was 40% of the pixels.
   *
   * The obvious repair -- hold intensity and walk chroma down until it fits --
   * is wrong, and measurably so. A saturated orange came back at
   * [1.00, 0.92, 0.86], which is white. Holding a bright intensity forces
   * almost total desaturation, producing exactly the washed-out conversion
   * ICtCp was chosen to prevent.
   *
   * So the triple is scaled instead. Dividing all three channels by the
   * largest keeps their ratios exactly, which keeps hue and saturation
   * exactly, and spends brightness instead -- an out-of-gamut highlight comes
   * back a little dimmer rather than a lot paler. For judging a grade that is
   * the right thing to give up: a colourist will forgive a highlight half a
   * stop down, not one that changed colour.
   */
  const toned: ReferenceRgb = [mapped, ictcp[1] * scale, ictcp[2] * scale];
  const backPq = applyGamut(toned, ICTCP_TO_LMS);
  const backLms: ReferenceRgb = [
    pqEotfNits(clampUnit(backPq[0])),
    pqEotfNits(clampUnit(backPq[1])),
    pqEotfNits(clampUnit(backPq[2])),
  ];
  const linear = applyGamut(backLms, LMS_FROM_RGB2020);
  const rgb: ReferenceRgb = [
    Math.max(linear[0], 0) / displayPeakNits,
    Math.max(linear[1], 0) / displayPeakNits,
    Math.max(linear[2], 0) / displayPeakNits,
  ];
  const peak = Math.max(rgb[0], rgb[1], rgb[2]);
  if (peak <= 1) return rgb;
  return [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak];
};
