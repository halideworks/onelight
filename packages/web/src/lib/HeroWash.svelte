<script lang="ts">
  import { onMount } from 'svelte';

  /* The landing wash as light rather than a picture of light: the same
     oklab ramp as the CSS fallback underneath, computed per-pixel in a
     fragment shader with dithering (so banding cannot form at any depth),
     the placed glow drifting almost imperceptibly, and a whisper of
     temporal grain at projection cadence. Without WebGL, or under
     prefers-reduced-motion, the canvas stays inert or still and the CSS
     wash carries the page unchanged. */

  let canvas = $state<HTMLCanvasElement | undefined>();

  /* Stops mirror the CSS hero wash exactly. */
  const STOPS: Array<[string, number]> = [
    ['#0d1117', 0.0],
    ['#101C28', 0.18],
    ['#934337', 0.66],
    ['#F7E1A0', 1.12]
  ];

  const srgbToLinear = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  const hexToOklab = (hex: string): [number, number, number] => {
    const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255);
    const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255);
    const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    ];
  };

  const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_gt;
uniform vec2 u_light;
uniform vec3 u_s0; uniform vec3 u_s1; uniform vec3 u_s2; uniform vec3 u_s3;

vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3(
    4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z
  );
}

float toSrgb1(float c) {
  c = clamp(c, 0.0, 1.0);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 toSrgb(vec3 c) { return vec3(toSrgb1(c.r), toSrgb1(c.g), toSrgb1(c.b)); }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float v = 1.0 - uv.y; /* 0 at the top of the page, 1 at the bottom */

  const float p0 = 0.0; const float p1 = 0.18; const float p2 = 0.66; const float p3 = 1.12;
  vec3 lab;
  if (v < p1) lab = mix(u_s0, u_s1, (v - p0) / (p1 - p0));
  else if (v < p2) lab = mix(u_s1, u_s2, (v - p1) / (p2 - p1));
  else lab = mix(u_s2, u_s3, clamp((v - p2) / (p3 - p2), 0.0, 1.0));

  vec3 rgb = oklabToLinear(lab);

  /* The placed light, added where light adds: in linear. */
  vec2 d = vec2(uv.x, v) - u_light;
  d.x *= u_res.x / u_res.y;
  rgb += vec3(0.055) * exp(-dot(d, d) * 7.0);

  rgb = toSrgb(rgb);

  /* Dither plus a whisper of grain, quantized to projection cadence. */
  float n = hash(gl_FragCoord.xy + vec2(u_gt * 31.7, u_gt * 11.3));
  rgb += (n - 0.5) * (2.6 / 255.0);

  gl_FragColor = vec4(rgb, 1.0);
}
`;

  onMount(() => {
    const element = canvas;
    if (!element) return;
    const gl = element.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return;

    const vertex = gl.createShader(gl.VERTEX_SHADER);
    if (!vertex) return;
    gl.shaderSource(vertex, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }');
    gl.compileShader(vertex);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fragment) return;
    gl.shaderSource(fragment, FRAG);
    gl.compileShader(fragment);
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

    const uniform = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    const stops = STOPS.map(([hex]) => hexToOklab(hex));
    gl.uniform3fv(uniform('u_s0'), stops[0]);
    gl.uniform3fv(uniform('u_s1'), stops[1]);
    gl.uniform3fv(uniform('u_s2'), stops[2]);
    gl.uniform3fv(uniform('u_s3'), stops[3]);
    const uRes = uniform('u_res');
    const uGt = uniform('u_gt');
    const uLight = uniform('u_light');

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = (): void => {
      const w = Math.round(element.clientWidth * dpr);
      const h = Math.round(element.clientHeight * dpr);
      if (element.width !== w || element.height !== h) {
        element.width = w;
        element.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = 0;
    const draw = (ms: number): void => {
      resize();
      const t = ms / 1000;
      /* Grain steps at 12fps; the light wanders on minute-scale periods. */
      gl.uniform1f(uGt, reduced ? 0 : Math.floor(t * 12) / 12);
      gl.uniform2f(
        uLight,
        0.7 + (reduced ? 0 : 0.014 * Math.sin((t * Math.PI * 2) / 47)),
        0.12 + (reduced ? 0 : 0.01 * Math.cos((t * Math.PI * 2) / 59))
      );
      gl.uniform2f(uRes, element.width, element.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    if (reduced) {
      draw(0);
      const observer = new ResizeObserver(() => draw(0));
      observer.observe(element);
      return () => observer.disconnect();
    }
    const loop = (ms: number): void => {
      /* 24fps is plenty for a drift this slow. */
      if (ms - last >= 41) {
        last = ms;
        draw(ms);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onVisibility = (): void => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(loop);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
