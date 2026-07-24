import {
  referenceMatrixFromMetadata,
  yuvConversionParameters,
} from "./color-math.js";
import type { PlaneLayoutTransfer, PlaneTransfer } from "./protocol.js";

export class UnsupportedReferenceRendererError extends Error {}

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
in vec2 source_position;
out vec4 output_color;

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
  output_color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
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
  private readonly glProgram: WebGLProgram;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly textureBanks: readonly [TextureBank, TextureBank];
  private readonly uniforms: RendererUniforms;
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
    if ("drawingBufferColorSpace" in colorContext)
      colorContext.drawingBufferColorSpace = "srgb";

    this.glProgram = program(gl);
    const vertexArray = gl.createVertexArray();
    if (!vertexArray) {
      gl.deleteProgram(this.glProgram);
      throw new UnsupportedReferenceRendererError(
        "WebGL2 could not allocate a vertex array.",
      );
    }
    this.vertexArray = vertexArray;
    this.textureBanks = [
      [texture(gl), texture(gl), texture(gl)],
      [texture(gl), texture(gl), texture(gl)],
    ];
    this.uniforms = {
      isNv12: uniform(gl, this.glProgram, "is_nv12"),
      sourceOffset: uniform(gl, this.glProgram, "source_offset"),
      sourceScale: uniform(gl, this.glProgram, "source_scale"),
      chromaOffset: uniform(gl, this.glProgram, "chroma_offset"),
      yOffset: uniform(gl, this.glProgram, "y_offset"),
      yMultiplier: uniform(gl, this.glProgram, "y_multiplier"),
      chromaCenter: uniform(gl, this.glProgram, "chroma_center"),
      chromaMultiplier: uniform(gl, this.glProgram, "chroma_multiplier"),
      kr: uniform(gl, this.glProgram, "kr"),
      kb: uniform(gl, this.glProgram, "kb"),
    };

    gl.useProgram(this.glProgram);
    gl.uniform1i(uniform(gl, this.glProgram, "luma_plane"), 0);
    gl.uniform1i(uniform(gl, this.glProgram, "chroma_plane"), 1);
    gl.uniform1i(uniform(gl, this.glProgram, "v_plane"), 2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);

    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  private readonly onContextLost = (): void => {
    this.contextLost = true;
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

  render(source: PlaneTransfer): void {
    if (this.closed)
      throw new Error("Reference renderer has already been closed.");
    if (this.contextLost || this.gl.isContextLost())
      throw new UnsupportedReferenceRendererError(
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
    for (const bank of this.textureBanks)
      for (const item of bank) this.gl.deleteTexture(item);
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteProgram(this.glProgram);
  }
}
