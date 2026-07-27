import {
  gamutConversionMatrix,
  isIdentityGamut,
  isSdrGammaTransfer,
  referenceMatrixFromMetadata,
  referencePrimariesFromMetadata,
  referenceSourceTransfer,
  yuvConversionParameters,
  type ReferenceDisplayTransfer,
  type ReferencePrimaries,
} from "./color-math.js";
import type { PlaneLayoutTransfer, PlaneTransfer } from "./protocol.js";

export class UnsupportedReferenceRendererError extends Error {}

/*
 * A lost GPU context is transient, not a property of the media: the driver
 * reset, the tab was backgrounded, or another context evicted this one. It is
 * thrown as its own type so the transport retries the render instead of
 * permanently condemning the rendition to native fallback.
 */
export class ReferenceContextLostError extends Error {}

export type ReferenceRendererOptions = {
  requireAcceleration?: boolean;
  /* How the HDR tone map is anchored. The defaults are BT.2408's 203 nit
     diffuse white and a 1000 nit mastering peak, which is what most HDR
     deliverables are graded to; a grade that says otherwise should say so. */
  referenceWhiteNits?: number;
  peakNits?: number;
  /* Ask for a wide-gamut drawing buffer. Only honoured where the engine
     supports it; the renderer reports what it actually got as
     outputPrimaries, and converts every frame into that. */
  outputColorSpace?: "srgb" | "display-p3";
};

const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 source_position;

void main() {
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  vec2 position = positions[gl_VertexID];
  gl_Position = vec4(position, 0.0, 1.0);
  source_position = vec2(
    (position.x + 1.0) * 0.5,
    (1.0 - position.y) * 0.5
  );
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D luma_plane;
uniform sampler2D chroma_plane;
uniform sampler2D v_plane;
uniform bool is_nv12;
uniform vec2 source_offset;
uniform vec2 source_scale;
uniform vec2 chroma_offset;
uniform float y_offset;
uniform float y_multiplier;
uniform float chroma_center;
uniform float chroma_multiplier;
uniform float kr;
uniform float kb;
uniform int transfer_mode;
uniform float transfer_gamma;
uniform mat3 gamut_matrix;
uniform bool passthrough;
/* 10-bit samples arrive in the low end of 16-bit words, so the hardware
   normalises them against 65535 while the YUV maths expects a full-scale
   0-1. One factor puts them back: 65535/1023 for 10-bit, 1 for 8-bit. */
uniform float sample_scale;
/* Absolute-luminance modes. 0 = none, the code values are display-referred.
   1 = PQ, 2 = HLG: the values name light, and light has to be tone-mapped
   before it can go on a display that cannot produce it. */
uniform int hdr_mode;
uniform float reference_white_nits;
uniform float peak_nits;
in vec2 source_position;
out vec4 output_color;

vec3 srgb_encode(vec3 linear) {
  vec3 lo = linear * 12.92;
  vec3 hi = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), linear));
}

vec3 srgb_decode(vec3 encoded) {
  vec3 lo = encoded / 12.92;
  vec3 hi = pow((encoded + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), encoded));
}

/* ST.2084, giving absolute luminance in nits. */
vec3 pq_eotf_nits(vec3 code) {
  const float m1 = 2610.0 / 16384.0;
  const float m2 = (2523.0 / 4096.0) * 128.0;
  const float c1 = 3424.0 / 4096.0;
  const float c2 = (2413.0 / 4096.0) * 32.0;
  const float c3 = (2392.0 / 4096.0) * 32.0;
  vec3 value = pow(clamp(code, 0.0, 1.0), vec3(1.0 / m2));
  vec3 numerator = max(value - c1, 0.0);
  vec3 denominator = max(c2 - c3 * value, 1e-6);
  return 10000.0 * pow(numerator / denominator, vec3(1.0 / m1));
}

/* ARIB STD-B67 inverse OETF, scene-referred 0-1. */
vec3 hlg_inverse_oetf(vec3 code) {
  const float a = 0.17883277;
  const float b = 1.0 - 4.0 * a;
  const float c = 0.5 - a * log(4.0 * a);
  vec3 value = clamp(code, 0.0, 1.0);
  vec3 lo = value * value / 3.0;
  vec3 hi = (exp((value - c) / a) + b) / 12.0;
  return mix(lo, hi, step(vec3(0.5), value));
}

/* Inverse PQ: nits to code. */
vec3 pq_inverse(vec3 nits) {
  const float m1 = 2610.0 / 16384.0;
  const float m2 = (2523.0 / 4096.0) * 128.0;
  const float c1 = 3424.0 / 4096.0;
  const float c2 = (2413.0 / 4096.0) * 32.0;
  const float c3 = (2392.0 / 4096.0) * 32.0;
  vec3 y = pow(max(nits, 0.0) / 10000.0, vec3(m1));
  return pow((c1 + c2 * y) / (1.0 + c3 * y), vec3(m2));
}

float pq_inverse1(float nits) { return pq_inverse(vec3(nits)).x; }

/*
 * BT.2390's EETF on a PQ code. 1:1 below the knee -- material the display can
 * already show is not touched -- then a cubic Hermite shoulder leaving the
 * knee at slope 1 and arriving at display peak with slope 0.
 */
float bt2390_eetf(float code, float iw, float ow, float ob) {
  if (ow >= iw) return code;
  float e1 = code / iw;
  float maxLum = ow / iw;
  float minLum = ob / iw;
  float ks = 1.5 * maxLum - 0.5;
  float e2 = e1;
  if (e1 > ks && ks < 1.0) {
    float t = (e1 - ks) / (1.0 - ks);
    float t2 = t * t;
    float t3 = t2 * t;
    e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks
       + (t3 - 2.0 * t2 + t) * (1.0 - ks)
       + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }
  float e3 = e2 + minLum * pow(1.0 - e2, 4.0);
  return clamp(e3 * iw, 0.0, 1.0);
}

/*
 * Tone map in ICtCp, Dolby's perceptually uniform opponent space. Hue is the
 * angle of (Ct, Cp), so scaling both by one factor compresses brightness and
 * saturation without rotating hue -- a curve applied per channel drags colour
 * towards white as it compresses, which is the tell of a bad conversion.
 */
vec3 tone_map(vec3 nits) {
  const mat3 rgb_to_lms = mat3(
    1688.0 / 4096.0, 683.0 / 4096.0, 99.0 / 4096.0,
    2146.0 / 4096.0, 2951.0 / 4096.0, 309.0 / 4096.0,
    262.0 / 4096.0, 462.0 / 4096.0, 3688.0 / 4096.0);
  const mat3 lms_to_ictcp = mat3(
    2048.0 / 4096.0, 6610.0 / 4096.0, 17933.0 / 4096.0,
    2048.0 / 4096.0, -13613.0 / 4096.0, -17390.0 / 4096.0,
    0.0, 7003.0 / 4096.0, -543.0 / 4096.0);
  vec3 ictcp = lms_to_ictcp * pq_inverse(rgb_to_lms * nits);
  float intensity = ictcp.x;
  if (intensity <= 0.0) return vec3(0.0);
  float mapped = bt2390_eetf(
    intensity,
    pq_inverse1(peak_nits),
    pq_inverse1(reference_white_nits),
    pq_inverse1(0.0));
  float scale = mapped / intensity;
  vec3 toned = vec3(mapped, ictcp.yz * scale);
  vec3 lms = pq_eotf_nits(clamp(inverse(lms_to_ictcp) * toned, 0.0, 1.0));
  vec3 rgb = max(inverse(rgb_to_lms) * lms, 0.0) / reference_white_nits;
  /* Compressing intensity does not land the colour inside the display cube:
     a saturated one has channels above its own luminance by definition, and
     on a real 1000-nit grade that was 40% of the pixels. Holding intensity
     and killing chroma until it fits turns a saturated orange white, which is
     the artefact ICtCp was chosen to prevent. Scaling the triple by its
     largest channel keeps the ratios, so hue and saturation survive exactly
     and brightness pays instead: an out-of-gamut highlight comes back a
     little dimmer rather than a lot paler. */
  float peak = max(rgb.r, max(rgb.g, rgb.b));
  if (peak > 1.0) rgb /= peak;
  return clamp(rgb, 0.0, 1.0);
}

void main() {
  vec2 coordinates = source_offset + source_position * source_scale;
  vec2 chroma_coordinates = coordinates + chroma_offset;
  float y =
    (texture(luma_plane, coordinates).r * sample_scale - y_offset) *
    y_multiplier;
  vec2 chroma = is_nv12
    ? texture(chroma_plane, chroma_coordinates).rg
    : vec2(
        texture(chroma_plane, chroma_coordinates).r * sample_scale,
        texture(v_plane, chroma_coordinates).r * sample_scale
      );
  float cb = (chroma.r - chroma_center) * chroma_multiplier;
  float cr = (chroma.g - chroma_center) * chroma_multiplier;
  float kg = 1.0 - kr - kb;
  vec3 rgb = vec3(
    y + 2.0 * (1.0 - kr) * cr,
    y - (
      2.0 * kb * (1.0 - kb) * cb +
      2.0 * kr * (1.0 - kr) * cr
    ) / kg,
    y + 2.0 * (1.0 - kb) * cb
  );
  vec3 code = clamp(rgb, 0.0, 1.0);
  /* Nothing to convert and nothing to re-encode: the code values already ARE
     the canvas's encoding. This branch is load-bearing rather than an
     optimisation -- the measured 0/255 agreement between this shader and the
     CPU oracle on a 709 frame depends on those values never round-tripping
     through linear light. */
  if (passthrough) {
    output_color = vec4(code, 1.0);
    return;
  }
  /* Otherwise: to linear by the source's own transfer, across gamuts by the
     3x3 (identity when they already match), and back out with the canvas's
     curve. A display-p3 canvas is P3 primaries with the sRGB transfer
     function, so only the matrix differs between output spaces.
       transfer_mode 0 = sRGB piecewise
       1 = BT.1886, gamma 2.4, the reference for 709 finishing
       2 = pure gamma 2.2, NOT sRGB: no linear toe, lower shadows
     The exponent is a uniform rather than a branch per curve, so another rung
     costs a constant instead of another shader path. */
  vec3 linear;
  if (hdr_mode == 1) {
    linear = tone_map(pq_eotf_nits(code));
  } else if (hdr_mode == 2) {
    /* HLG's inverse OETF is scene-referred; the OOTF that makes it display
       light is folded into the tone map by scaling to the mastering peak. */
    linear = tone_map(hlg_inverse_oetf(code) * peak_nits);
  } else {
    linear = transfer_mode == 0
      ? srgb_decode(code)
      : pow(code, vec3(transfer_gamma));
  }
  vec3 encoded = srgb_encode(clamp(gamut_matrix * linear, 0.0, 1.0));
  output_color = vec4(clamp(encoded, 0.0, 1.0), 1.0);
}`;

const shader = (
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader => {
  const result = gl.createShader(type);
  if (!result)
    throw new UnsupportedReferenceRendererError(
      "WebGL2 could not allocate a shader.",
    );
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(result) ?? "unknown shader error";
    gl.deleteShader(result);
    throw new UnsupportedReferenceRendererError(
      `Reference renderer shader compilation failed: ${reason.slice(0, 300)}`,
    );
  }
  return result;
};

const program = (gl: WebGL2RenderingContext): WebGLProgram => {
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const result = gl.createProgram();
  if (!result) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new UnsupportedReferenceRendererError(
      "WebGL2 could not allocate a shader program.",
    );
  }
  gl.attachShader(result, vertex);
  gl.attachShader(result, fragment);
  gl.linkProgram(result);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
    const reason = gl.getProgramInfoLog(result) ?? "unknown link error";
    gl.deleteProgram(result);
    throw new UnsupportedReferenceRendererError(
      `Reference renderer shader linking failed: ${reason.slice(0, 300)}`,
    );
  }
  return result;
};

const texture = (gl: WebGL2RenderingContext): WebGLTexture => {
  const result = gl.createTexture();
  if (!result)
    throw new UnsupportedReferenceRendererError(
      "WebGL2 could not allocate a plane texture.",
    );
  gl.bindTexture(gl.TEXTURE_2D, result);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return result;
};

const uniform = (
  gl: WebGL2RenderingContext,
  glProgram: WebGLProgram,
  name: string,
): WebGLUniformLocation => {
  const result = gl.getUniformLocation(glProgram, name);
  if (!result)
    throw new UnsupportedReferenceRendererError(
      `Reference renderer uniform ${name} is unavailable.`,
    );
  return result;
};

const planeSpan = (
  layout: PlaneLayoutTransfer,
  width: number,
  height: number,
  bytesPerPixel: number,
  byteLength: number,
): { rowLength: number; length: number } => {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(layout.offset) ||
    layout.offset < 0 ||
    !Number.isSafeInteger(layout.stride) ||
    layout.stride < width * bytesPerPixel ||
    layout.stride % bytesPerPixel !== 0
  )
    throw new UnsupportedReferenceRendererError(
      "Reference plane layout is invalid.",
    );
  const length = layout.stride * (height - 1) + width * bytesPerPixel;
  if (!Number.isSafeInteger(length) || layout.offset + length > byteLength)
    throw new UnsupportedReferenceRendererError(
      "Reference plane exceeds its transfer buffer.",
    );
  return {
    rowLength: layout.stride / bytesPerPixel,
    length,
  };
};

/* The shader's two knobs per curve, kept beside each other so a new rung is
   one row here and nothing else. Mode 0 passes code values through; any other
   mode decodes with its exponent and re-encodes for the sRGB canvas, so the
   gamma for sRGB is never read. */
const DISPLAY_TRANSFER_MODE: Readonly<
  Record<ReferenceDisplayTransfer, number>
> = { srgb: 0, bt1886: 1, gamma22: 2 };
const DISPLAY_TRANSFER_GAMMA: Readonly<
  Record<ReferenceDisplayTransfer, number>
> = { srgb: 1, bt1886: 2.4, gamma22: 2.2 };

type RendererUniforms = {
  isNv12: WebGLUniformLocation;
  sourceOffset: WebGLUniformLocation;
  sourceScale: WebGLUniformLocation;
  chromaOffset: WebGLUniformLocation;
  yOffset: WebGLUniformLocation;
  yMultiplier: WebGLUniformLocation;
  chromaCenter: WebGLUniformLocation;
  chromaMultiplier: WebGLUniformLocation;
  kr: WebGLUniformLocation;
  kb: WebGLUniformLocation;
  transferMode: WebGLUniformLocation;
  transferGamma: WebGLUniformLocation;
  gamutMatrix: WebGLUniformLocation;
  passthrough: WebGLUniformLocation;
  sampleScale: WebGLUniformLocation;
  hdrMode: WebGLUniformLocation;
  referenceWhiteNits: WebGLUniformLocation;
  peakNits: WebGLUniformLocation;
};

type SrgbWebGlContext = WebGL2RenderingContext & {
  drawingBufferColorSpace?: PredefinedColorSpace;
};

type TextureBank = readonly [WebGLTexture, WebGLTexture, WebGLTexture];
type TextureAllocation = {
  width: number;
  height: number;
  bytesPerPixel: 1 | 2;
  sixteenBit: boolean;
};

export class ReferenceGlRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /* True when the engine lets the canvas declare its buffer as sRGB
     (drawingBufferColorSpace). Where it cannot, a wide-gamut display may
     composite the buffer as device RGB and oversaturate the picture; the
     transport surfaces that as a caution instead of claiming reference. */
  readonly colorManagedOutput: boolean;
  /* The gamut the canvas is composited in, and therefore what every frame is
     converted into. sRGB unless the caller asked for and got display-p3. */
  readonly outputPrimaries: ReferencePrimaries;
  private readonly norm16: { R16_EXT: number } | null = null;
  private readonly referenceWhiteNits: number;
  private readonly peakNits: number;
  private glProgram: WebGLProgram;
  private vertexArray: WebGLVertexArrayObject;
  private textureBanks: readonly [TextureBank, TextureBank];
  private uniforms: RendererUniforms;
  private readonly textureAllocations: [
    Array<TextureAllocation | null>,
    Array<TextureAllocation | null>,
  ] = [
    [null, null, null],
    [null, null, null],
  ];
  private activeTextureBank = 0;
  private closed = false;
  private contextLost = false;

  constructor(
    canvas: HTMLCanvasElement,
    options: ReferenceRendererOptions = {},
  ) {
    this.canvas = canvas;
    const requireAcceleration = options.requireAcceleration ?? true;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: requireAcceleration,
      powerPreference: "high-performance",
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl)
      throw new UnsupportedReferenceRendererError(
        requireAcceleration
          ? "Hardware-capable WebGL2 is unavailable."
          : "WebGL2 is unavailable.",
      );
    this.gl = gl;
    const colorContext = gl as SrgbWebGlContext;
    this.colorManagedOutput = "drawingBufferColorSpace" in colorContext;
    /* A wide-gamut canvas is only worth asking for when the caller wants one
       and the engine actually takes it: reading the property back is the only
       honest confirmation, since assigning an unsupported value is silently
       ignored. Whatever it settles on is what frames get converted into, so a
       refusal degrades to sRGB rather than to a mismatched picture. */
    let output: ReferencePrimaries = "bt709";
    if (this.colorManagedOutput) {
      const wanted =
        options.outputColorSpace === "display-p3" ? "display-p3" : "srgb";
      colorContext.drawingBufferColorSpace = wanted;
      if (
        wanted === "display-p3" &&
        colorContext.drawingBufferColorSpace === "display-p3"
      )
        output = "smpte432";
    }
    this.outputPrimaries = output;
    /* 10-bit planes need a normalised 16-bit texture. WebGL2 core has no such
       format -- R16UI exists but integer textures cannot be linearly filtered,
       and chroma upsampling depends on that filtering -- so EXT_texture_norm16
       is required rather than worked around. Without it a 10-bit frame is
       refused and the transport falls back to native, which is the same
       fail-closed behaviour every other unmet requirement gets. */
    this.norm16 = gl.getExtension("EXT_texture_norm16") as {
      R16_EXT: number;
    } | null;
    this.referenceWhiteNits = options.referenceWhiteNits ?? 203;
    this.peakNits = Math.max(options.peakNits ?? 1000, 1);

    const built = this.buildResources();
    this.glProgram = built.glProgram;
    this.vertexArray = built.vertexArray;
    this.textureBanks = built.textureBanks;
    this.uniforms = built.uniforms;

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  /*
   * Allocate every GPU object the draw depends on and prime the context state
   * the draw assumes. Runs once at construction and again after the browser
   * restores a lost context, when all prior GL objects are dead.
   */
  private buildResources(): {
    glProgram: WebGLProgram;
    vertexArray: WebGLVertexArrayObject;
    textureBanks: readonly [TextureBank, TextureBank];
    uniforms: RendererUniforms;
  } {
    const gl = this.gl;
    const glProgram = program(gl);
    const vertexArray = gl.createVertexArray();
    if (!vertexArray) {
      gl.deleteProgram(glProgram);
      throw new UnsupportedReferenceRendererError(
        "WebGL2 could not allocate a vertex array.",
      );
    }
    const textureBanks: readonly [TextureBank, TextureBank] = [
      [texture(gl), texture(gl), texture(gl)],
      [texture(gl), texture(gl), texture(gl)],
    ];
    const uniforms: RendererUniforms = {
      isNv12: uniform(gl, glProgram, "is_nv12"),
      sourceOffset: uniform(gl, glProgram, "source_offset"),
      sourceScale: uniform(gl, glProgram, "source_scale"),
      chromaOffset: uniform(gl, glProgram, "chroma_offset"),
      yOffset: uniform(gl, glProgram, "y_offset"),
      yMultiplier: uniform(gl, glProgram, "y_multiplier"),
      chromaCenter: uniform(gl, glProgram, "chroma_center"),
      chromaMultiplier: uniform(gl, glProgram, "chroma_multiplier"),
      kr: uniform(gl, glProgram, "kr"),
      kb: uniform(gl, glProgram, "kb"),
      transferMode: uniform(gl, glProgram, "transfer_mode"),
      transferGamma: uniform(gl, glProgram, "transfer_gamma"),
      gamutMatrix: uniform(gl, glProgram, "gamut_matrix"),
      passthrough: uniform(gl, glProgram, "passthrough"),
      sampleScale: uniform(gl, glProgram, "sample_scale"),
      hdrMode: uniform(gl, glProgram, "hdr_mode"),
      referenceWhiteNits: uniform(gl, glProgram, "reference_white_nits"),
      peakNits: uniform(gl, glProgram, "peak_nits"),
    };

    gl.useProgram(glProgram);
    gl.uniform1i(uniform(gl, glProgram, "luma_plane"), 0);
    gl.uniform1i(uniform(gl, glProgram, "chroma_plane"), 1);
    gl.uniform1i(uniform(gl, glProgram, "v_plane"), 2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    return { glProgram, vertexArray, textureBanks, uniforms };
  }

  private readonly onContextLost = (event: Event): void => {
    /* Without preventDefault the browser never fires webglcontextrestored and
       the context is dead for good. With it, we get a fresh context to rebuild
       into. */
    event.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    if (this.closed) return;
    /* Prior program, VAO and textures were destroyed with the old context;
       reset the CPU-side allocation cache so the next upload reallocates. */
    for (const bank of this.textureAllocations)
      for (let unit = 0; unit < bank.length; unit += 1) bank[unit] = null;
    this.activeTextureBank = 0;
    try {
      const built = this.buildResources();
      this.glProgram = built.glProgram;
      this.vertexArray = built.vertexArray;
      this.textureBanks = built.textureBanks;
      this.uniforms = built.uniforms;
      this.contextLost = false;
    } catch {
      /* Rebuild failed; leave contextLost set so render() keeps signalling a
         recoverable loss until a later restore succeeds. */
      this.contextLost = true;
    }
  };

  private uploadPlane(
    bank: number,
    unit: number,
    source: PlaneTransfer,
    layout: PlaneLayoutTransfer,
    width: number,
    height: number,
    bytesPerPixel: 1 | 2,
    sixteenBit = false,
  ): void {
    const gl = this.gl;
    const span = planeSpan(
      layout,
      width,
      height,
      sixteenBit ? 2 : bytesPerPixel,
      source.buffer.byteLength,
    );
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textureBanks[bank]?.[unit] ?? null);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, span.rowLength);
    const pixels = sixteenBit
      ? new Uint16Array(source.buffer, layout.offset, span.length / 2)
      : new Uint8Array(source.buffer, layout.offset, span.length);
    const format = bytesPerPixel === 1 ? gl.RED : gl.RG;
    const type = sixteenBit ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
    const allocations = this.textureAllocations[bank];
    const allocation = allocations?.[unit];
    if (
      !allocation ||
      allocation.width !== width ||
      allocation.height !== height ||
      allocation.bytesPerPixel !== bytesPerPixel ||
      allocation.sixteenBit !== sixteenBit
    ) {
      const internalFormat = sixteenBit
        ? (this.norm16?.R16_EXT ?? gl.R8)
        : bytesPerPixel === 1
          ? gl.R8
          : gl.RG8;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internalFormat,
        width,
        height,
        0,
        format,
        type,
        null,
      );
      if (allocations)
        allocations[unit] = { width, height, bytesPerPixel, sixteenBit };
    }
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      format,
      type,
      pixels,
    );
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  render(
    source: PlaneTransfer,
    transfer: ReferenceDisplayTransfer = "srgb",
  ): void {
    if (this.closed)
      throw new Error("Reference renderer has already been closed.");
    if (this.contextLost || this.gl.isContextLost())
      throw new ReferenceContextLostError(
        "Reference renderer context was lost.",
      );
    /* What this renderer can actually draw, asked as three separate
       questions because they are three separate properties of the frame.

       An SDR transfer tag names a display convention, not a decode step --
       the output encoding comes from the transfer argument below -- so any of
       the family renders identically, which is what lets Safari's
       "iec61966-2-1" surfaces through. PQ and HLG are decode steps and get
       their own path. Primaries feed the gamut matrix, and the matrix feeds
       the YUV stage; both are refused by name when unimplemented rather than
       approximated. */
    const sourcePrimaries = referencePrimariesFromMetadata(
      source.color.primaries,
    );
    if (!sourcePrimaries)
      throw new UnsupportedReferenceRendererError(
        `The reference renderer cannot draw ${source.color.primaries} primaries.`,
      );
    const sourceTransfer = referenceSourceTransfer(source.color.transfer);
    if (sourceTransfer === "sdr" && !isSdrGammaTransfer(source.color.transfer))
      throw new UnsupportedReferenceRendererError(
        `The reference renderer cannot draw the ${source.color.transfer} transfer.`,
      );
    const matrix = referenceMatrixFromMetadata(source.color.matrix);
    if (!matrix)
      throw new UnsupportedReferenceRendererError(
        `The reference renderer cannot draw the ${source.color.matrix} matrix.`,
      );
    const tenBit = source.format === "I420P10";
    if (tenBit && !this.norm16)
      throw new UnsupportedReferenceRendererError(
        "This engine has no EXT_texture_norm16, so 10-bit planes cannot be uploaded without losing chroma filtering.",
      );
    const width = source.codedRect.width;
    const height = source.codedRect.height;
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);
    const expectedPlanes = source.format === "NV12" ? 2 : 3;
    if (source.layout.length !== expectedPlanes)
      throw new UnsupportedReferenceRendererError(
        `Reference ${source.format} frame has an invalid plane count.`,
      );
    const yLayout = source.layout[0];
    const chromaLayout = source.layout[1];
    if (!yLayout || !chromaLayout)
      throw new UnsupportedReferenceRendererError(
        "Reference frame plane layouts are incomplete.",
      );

    /*
     * Upload into the texture bank the previous draw is not sampling. Updating
     * the same 4K textures in place can make the browser wait for the prior
     * draw to retire before accepting 12 MB of new YUV data. Alternating two
     * persistent banks removes that read-after-write synchronization point
     * while keeping allocation bounded.
     */
    const textureBank = this.activeTextureBank === 0 ? 1 : 0;
    this.uploadPlane(textureBank, 0, source, yLayout, width, height, 1, tenBit);
    if (source.format !== "NV12") {
      const vLayout = source.layout[2];
      if (!vLayout)
        throw new UnsupportedReferenceRendererError(
          "Reference I420 V plane layout is missing.",
        );
      this.uploadPlane(
        textureBank,
        1,
        source,
        chromaLayout,
        chromaWidth,
        chromaHeight,
        1,
        tenBit,
      );
      this.uploadPlane(
        textureBank,
        2,
        source,
        vLayout,
        chromaWidth,
        chromaHeight,
        1,
        tenBit,
      );
    } else
      this.uploadPlane(
        textureBank,
        1,
        source,
        chromaLayout,
        chromaWidth,
        chromaHeight,
        2,
      );

    const gl = this.gl;
    const parameters = yuvConversionParameters(matrix, source.color.range);
    const sourceX = source.visibleRect.x - source.codedRect.x;
    const sourceY = source.visibleRect.y - source.codedRect.y;
    if (
      sourceX < 0 ||
      sourceY < 0 ||
      sourceX + source.visibleRect.width > width ||
      sourceY + source.visibleRect.height > height
    )
      throw new UnsupportedReferenceRendererError(
        "Reference visible rectangle exceeds the copied coded rectangle.",
      );

    if (this.canvas.width !== source.displayWidth)
      this.canvas.width = source.displayWidth;
    if (this.canvas.height !== source.displayHeight)
      this.canvas.height = source.displayHeight;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.glProgram);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform1i(this.uniforms.isNv12, source.format === "NV12" ? 1 : 0);
    gl.uniform2f(this.uniforms.sourceOffset, sourceX / width, sourceY / height);
    gl.uniform2f(
      this.uniforms.sourceScale,
      source.visibleRect.width / width,
      source.visibleRect.height / height,
    );
    gl.uniform2f(
      this.uniforms.chromaOffset,
      source.chromaLocation === "center" ? 0 : 0.5 / width,
      source.chromaLocation === "topleft" ? 0.5 / height : 0,
    );
    gl.uniform1f(this.uniforms.yOffset, parameters.yOffset / 255);
    gl.uniform1f(this.uniforms.yMultiplier, 255 / parameters.yRange);
    gl.uniform1f(this.uniforms.chromaCenter, parameters.chromaOffset / 255);
    gl.uniform1f(this.uniforms.chromaMultiplier, 255 / parameters.chromaRange);
    gl.uniform1f(this.uniforms.kr, parameters.kr);
    gl.uniform1f(this.uniforms.kb, parameters.kb);
    gl.uniform1i(this.uniforms.transferMode, DISPLAY_TRANSFER_MODE[transfer]);
    gl.uniform1f(this.uniforms.transferGamma, DISPLAY_TRANSFER_GAMMA[transfer]);
    /* The frame's own gamut to the canvas's. A tag naming a gamut we do not
       implement is not guessed at: it renders as the output gamut, which is
       the same picture the pipeline produced before any of this existed. */
    const gamut = gamutConversionMatrix(sourcePrimaries, this.outputPrimaries);
    /* Column-major, which is what uniformMatrix3fv wants and the transpose of
       how the maths reads. */
    gl.uniformMatrix3fv(this.uniforms.gamutMatrix, false, [
      gamut[0],
      gamut[3],
      gamut[6],
      gamut[1],
      gamut[4],
      gamut[7],
      gamut[2],
      gamut[5],
      gamut[8],
    ]);
    gl.uniform1i(
      this.uniforms.passthrough,
      sourceTransfer === "sdr" && transfer === "srgb" && isIdentityGamut(gamut)
        ? 1
        : 0,
    );
    /* 10 bits sitting in the low end of 16-bit words: the hardware normalises
       against 65535, the YUV maths wants full scale. */
    gl.uniform1f(this.uniforms.sampleScale, tenBit ? 65535 / 1023 : 1);
    gl.uniform1i(
      this.uniforms.hdrMode,
      sourceTransfer === "pq" ? 1 : sourceTransfer === "hlg" ? 2 : 0,
    );
    gl.uniform1f(this.uniforms.referenceWhiteNits, this.referenceWhiteNits);
    gl.uniform1f(this.uniforms.peakNits, this.peakNits);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.activeTextureBank = textureBank;

    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      throw new UnsupportedReferenceRendererError(
        `Reference renderer WebGL2 error ${String(error)}.`,
      );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.onContextRestored,
    );
    for (const bank of this.textureBanks)
      for (const item of bank) this.gl.deleteTexture(item);
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteProgram(this.glProgram);
  }
}
