/*
 * Whether this engine can put real HDR on the screen from a canvas, and how a
 * value above SDR white should be written when it can.
 *
 * Measured 2026-07-27 on Chrome 150 (Windows, RTX 3090) and Safari 26.5.2
 * (macOS), both on the shipped default configuration:
 *
 *   WebGL2 drawingBufferColorSpace rec2100-pq / rec2100-hlg   TypeError
 *   WebGL2 drawingBufferStorageFormat (a float buffer)        absent
 *   WebGL2 drawing buffer                                     8 bits
 *   WebGPU rec2100-pq + rgba16float                           TypeError
 *   WebGPU display-p3 + rgba16float + toneMapping extended    ACCEPTED
 *
 * So WebGL cannot carry HDR by any route -- there is no float buffer, which
 * means every value must fit 0..1, which is why the GL renderer tone-maps.
 * That is a platform wall and not something the shader can work around. The
 * one route both engines ship is an extended-range float16 WebGPU canvas,
 * where values above 1.0 are not clipped but composited into whatever
 * headroom the display has.
 */

export type HdrOutputSupport = {
  supported: boolean;
  reason: string;
};

export type HdrCanvasEnvironment = {
  hasWebGpu: boolean;
  /* Set by actually configuring a context: an engine that lists the enum but
     refuses the configuration must count as unsupported. */
  extendedRangeAccepted: boolean;
  displayIsHdr: boolean;
};

/*
 * Fail closed, and on capability rather than on names. Every term is required
 * and each says something different: without WebGPU there is no float canvas,
 * without the extended configuration the float canvas still clips at SDR
 * white, and without an HDR display there is no headroom to composite into --
 * on an SDR panel extended range is at best a no-op and at worst a second
 * tone map applied by the compositor rather than by our shader, which is
 * precisely the loss of control this renderer exists to prevent.
 */
export const hdrOutputSupport = (
  environment: HdrCanvasEnvironment,
): HdrOutputSupport => {
  if (!environment.hasWebGpu)
    return {
      supported: false,
      reason: "This browser has no WebGPU, and WebGL cannot output HDR.",
    };
  if (!environment.extendedRangeAccepted)
    return {
      supported: false,
      reason:
        "This browser refuses an extended-range float canvas, so values above SDR white would clip.",
    };
  if (!environment.displayIsHdr)
    return {
      supported: false,
      reason: "This display does not report high dynamic range.",
    };
  return {
    supported: true,
    reason:
      "An extended-range float canvas can carry the grade to an HDR display.",
  };
};

/*
 * How a linear value is written into the extended-range canvas.
 *
 * The canvas is display-p3, whose transfer function is sRGB's, and the
 * question that cannot be answered from a specification alone is what the
 * compositor does with values past 1.0. Both readings are plausible and they
 * differ by a lot of light, so this is a named choice to be settled against
 * a known reference -- the 240-1000 nit ramp beside the native path -- rather
 * than an arithmetic detail buried in a shader:
 *
 *   "srgb-extended"  the sRGB curve continues past 1.0. 1.0 is SDR white and
 *                    the encoded value keeps rising with the same curve.
 *   "linear-scrgb"   values are linear multiples of SDR white with no curve
 *                    at all, the scRGB convention.
 *
 * Whichever is right, the grade's absolute luminance still has to be anchored
 * somewhere, and that anchor is BT.2408's 203 nit diffuse white: a PQ sample
 * at 203 nits must land on 1.0, or the whole picture floats.
 */
export type HdrOutputEncoding = "srgb-extended" | "linear-scrgb";

export const DEFAULT_HDR_OUTPUT_ENCODING: HdrOutputEncoding = "srgb-extended";

/* The WGSL that writes a linear, reference-white-relative colour into the
   canvas. Kept beside the choice it implements so the two cannot drift. */
export const hdrOutputEncodingWgsl = (encoding: HdrOutputEncoding): string =>
  encoding === "linear-scrgb"
    ? `
/* scRGB: no curve, 1.0 is SDR white, highlights are simple multiples. */
fn encode_hdr_output(linear: vec3f) -> vec3f {
  return max(linear, vec3f(0.0));
}`
    : `
/* The sRGB curve continued past 1.0 rather than clamped at it. Below 1.0 this
   is exactly the SDR path's encoding, so a diffuse-white patch matches the
   tone-mapped renderer sample for sample; above it the curve simply keeps
   going, which is what carries the highlights. */
fn encode_hdr_output(linear: vec3f) -> vec3f {
  let v = max(linear, vec3f(0.0));
  let low = v * 12.92;
  let high = 1.055 * pow(v, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, v <= vec3f(0.0031308));
}`;
