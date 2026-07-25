import { describe, expect, it } from "vitest";
import {
  ReferenceContextLostError,
  ReferenceGlRenderer,
  UnsupportedReferenceRendererError,
} from "./gl-renderer.js";
import type { PlaneTransfer } from "./protocol.js";

/*
 * A minimal WebGL2 stand-in. Real WebGL is unavailable under vitest, so this
 * records nothing and simply answers every call the renderer makes with a
 * benign value: object handles for create*, `true` for compile/link status,
 * NO_ERROR for getError, and a controllable isContextLost. Uppercase property
 * reads resolve to stable constant numbers.
 */
const makeGl = (
  canvas: HTMLCanvasElement,
  lost: { value: boolean },
  counters: { builds: number },
): WebGL2RenderingContext => {
  const gl = new Proxy(
    {},
    {
      has: () => false,
      get(_target, property) {
        if (property === "canvas") return canvas;
        if (property === "isContextLost") return () => lost.value;
        if (property === "NO_ERROR") return 0;
        if (property === "getError") return () => 0;
        if (property === "getShaderParameter") return () => true;
        if (property === "getProgramParameter") return () => true;
        if (property === "getShaderInfoLog") return () => "";
        if (property === "getProgramInfoLog") return () => "";
        if (property === "getUniformLocation") return () => ({});
        if (property === "createShader") return () => ({});
        if (property === "createProgram") {
          return () => {
            counters.builds += 1;
            return {};
          };
        }
        if (property === "createVertexArray") return () => ({});
        if (property === "createTexture") return () => ({});
        if (typeof property === "string" && /^[A-Z0-9_]+$/.test(property))
          return 1;
        return () => undefined;
      },
    },
  );
  return gl as unknown as WebGL2RenderingContext;
};

const makeCanvas = (
  lost: { value: boolean },
  counters: { builds: number },
): HTMLCanvasElement => {
  const target = new EventTarget();
  let width = 0;
  let height = 0;
  const canvas = {
    get width() {
      return width;
    },
    set width(value: number) {
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      height = value;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as unknown as HTMLCanvasElement;
  (
    canvas as unknown as { getContext: () => WebGL2RenderingContext }
  ).getContext = () => makeGl(canvas, lost, counters);
  return canvas;
};

const sampleFrame = (): PlaneTransfer => ({
  format: "I420",
  buffer: new ArrayBuffer(24),
  layout: [
    { offset: 0, stride: 4 },
    { offset: 16, stride: 2 },
    { offset: 20, stride: 2 },
  ],
  codedWidth: 4,
  codedHeight: 4,
  displayWidth: 4,
  displayHeight: 4,
  codedRect: { x: 0, y: 0, width: 4, height: 4 },
  visibleRect: { x: 0, y: 0, width: 4, height: 4 },
  timestampUs: 0,
  durationUs: null,
  color: {
    primaries: "bt709",
    transfer: "bt709",
    matrix: "bt709",
    range: "tv",
  },
  chromaLocation: "left",
});

describe("ReferenceGlRenderer context loss recovery", () => {
  it("renders normally before any loss", () => {
    const lost = { value: false };
    const counters = { builds: 0 };
    const renderer = new ReferenceGlRenderer(makeCanvas(lost, counters), {
      requireAcceleration: false,
    });
    expect(() => renderer.render(sampleFrame())).not.toThrow();
    expect(counters.builds).toBe(1);
    renderer.close();
  });

  it("signals a recoverable loss, then heals on restore", () => {
    const lost = { value: false };
    const counters = { builds: 0 };
    const canvas = makeCanvas(lost, counters);
    const renderer = new ReferenceGlRenderer(canvas, {
      requireAcceleration: false,
    });

    // Context is lost: render must raise the *recoverable* error, not the
    // permanent unsupported one, so the transport retries instead of latching.
    lost.value = true;
    const lostEvent = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lostEvent);
    expect(lostEvent.defaultPrevented).toBe(true);
    expect(() => renderer.render(sampleFrame())).toThrow(
      ReferenceContextLostError,
    );

    // Browser hands back a fresh context: the renderer rebuilds and draws.
    lost.value = false;
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(counters.builds).toBe(2);
    expect(() => renderer.render(sampleFrame())).not.toThrow();
    renderer.close();
  });

  it("stays in the recoverable-loss state while no restore arrives", () => {
    const counters = { builds: 0 };
    const canvas = makeCanvas({ value: false }, counters);
    const renderer = new ReferenceGlRenderer(canvas, {
      requireAcceleration: false,
    });
    // A loss with no following restore keeps render() raising the recoverable
    // error every frame, never the permanent unsupported one.
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(() => renderer.render(sampleFrame())).toThrow(
      ReferenceContextLostError,
    );
    expect(() => renderer.render(sampleFrame())).toThrow(
      ReferenceContextLostError,
    );
    renderer.close();
    // Rendering after close is a hard error, never a silent no-op.
    expect(() => renderer.render(sampleFrame())).toThrow(Error);
  });

  /* Safari 26 hands back exactly this: an NV12 surface the platform decoder
     range-expanded, tagged with macOS's sRGB transfer convention. Measured on
     an M3 Ultra against 720p, 1080p, 608x1080 and 2160p BT.709 proxies. */
  it("renders a platform-converted surface tagged outside BT.709", () => {
    const canvas = makeCanvas({ value: false }, { builds: 0 });
    const renderer = new ReferenceGlRenderer(canvas, {
      requireAcceleration: false,
    });
    const converted: PlaneTransfer = {
      ...sampleFrame(),
      format: "NV12",
      layout: [
        { offset: 0, stride: 4 },
        { offset: 16, stride: 4 },
      ],
      color: {
        primaries: "bt709",
        transfer: "iec61966-2-1",
        matrix: "bt709",
        range: "pc",
      },
    };
    expect(() => renderer.render(converted)).not.toThrow();

    // A transfer that names different code values, not a display convention,
    // is still refused.
    expect(() =>
      renderer.render({
        ...converted,
        color: { ...converted.color, transfer: "pq" },
      }),
    ).toThrow(UnsupportedReferenceRendererError);
    renderer.close();
  });

  it("still reports unsupported when WebGL2 is entirely absent", () => {
    const canvas = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(
      () => new ReferenceGlRenderer(canvas, { requireAcceleration: false }),
    ).toThrow(UnsupportedReferenceRendererError);
  });
});
