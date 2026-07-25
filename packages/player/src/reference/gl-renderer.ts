import {
  referenceMatrixFromMetadata,
  yuvConversionParameters,
  type ReferenceDisplayTransfer,
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
in vec2 source_position;
out vec4 output_color;

vec3 srgb_encode(vec3 linear) {
  vec3 lo = linear * 12.92;
  vec3 hi = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), linear));
}

void main() {
  vec2 coordinates = source_offset + source_position * source_scale;
  vec2 chroma_coordinates = coordinates + chroma_offset;
  float y = (texture(luma_plane, coordinates).r - y_offset) * y_multiplier;
  vec2 chroma = is_nv12
    ? texture(chroma_plane, chroma_coordinates).rg
    : vec2(
        texture(chroma_plane, chroma_coordinates).r,
        texture(v_plane, chroma_coordinates).r
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
  /* transfer_mode 1 = BT.1886: the code values are pure-2.4 display-referred,
     so decode to linear and re-encode for the sRGB canvas. Mode 0 = sRGB: the
     code values are already sRGB, pass them through. */
  vec3 encoded = transfer_mode == 1 ? srgb_encode(pow(code, vec3(2.4))) : code;
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
};

type SrgbWebGlContext = WebGL2RenderingContext & {
  drawingBufferColorSpace?: PredefinedColorSpace;
};

type TextureBank = readonly [WebGLTexture, WebGLTexture, WebGLTexture];
type TextureAllocation = {
  width: number;
  height: number;
  bytesPerPixel: 1 | 2;
};

export class ReferenceGlRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  /* True when the engine lets the canvas declare its buffer as sRGB
     (drawingBufferColorSpace). Where it cannot, a wide-gamut display may
     composite the buffer as device RGB and oversaturate the picture; the
     transport surfaces that as a caution instead of claiming reference. */
  readonly colorManagedOutput: boolean;
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
    if (this.colorManagedOutput)
      colorContext.drawingBufferColorSpace = "srgb";

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
  ): void {
    const gl = this.gl;
    const span = planeSpan(
      layout,
      width,
      height,
      bytesPerPixel,
      source.buffer.byteLength,
    );
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textureBanks[bank]?.[unit] ?? null);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, span.rowLength);
    const pixels = new Uint8Array(source.buffer, layout.offset, span.length);
    const format = bytesPerPixel === 1 ? gl.RED : gl.RG;
    const allocations = this.textureAllocations[bank];
    const allocation = allocations?.[unit];
    if (
      !allocation ||
      allocation.width !== width ||
      allocation.height !== height ||
      allocation.bytesPerPixel !== bytesPerPixel
    ) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        bytesPerPixel === 1 ? gl.R8 : gl.RG8,
        width,
        height,
        0,
        format,
        gl.UNSIGNED_BYTE,
        null,
      );
      if (allocations) allocations[unit] = { width, height, bytesPerPixel };
    }
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      format,
      gl.UNSIGNED_BYTE,
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
    if (source.color.primaries !== "bt709" || source.color.transfer !== "bt709")
      throw new UnsupportedReferenceRendererError(
        "The reference renderer currently requires BT.709 SDR input.",
      );
    const matrix = referenceMatrixFromMetadata(source.color.matrix);
    if (matrix !== "bt709")
      throw new UnsupportedReferenceRendererError(
        "The reference renderer currently requires a BT.709 matrix.",
      );
    const width = source.codedRect.width;
    const height = source.codedRect.height;
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);
    const expectedPlanes = source.format === "I420" ? 3 : 2;
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
    this.uploadPlane(textureBank, 0, source, yLayout, width, height, 1);
    if (source.format === "I420") {
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
      );
      this.uploadPlane(
        textureBank,
        2,
        source,
        vLayout,
        chromaWidth,
        chromaHeight,
        1,
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
    gl.uniform1i(this.uniforms.transferMode, transfer === "bt1886" ? 1 : 0);
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
