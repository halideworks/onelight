import { describe, expect, it } from "vitest";
import {
  COLOR_SELF_CHECK_CLIP_SHA256,
  colorSelfCheckVersionKey,
  detectBrowserIdentity,
  runColorSelfCheck,
} from "./color-self-check.js";
import { COLOR_ORACLE_PATCHES } from "./color-oracle.js";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

class TestVideo extends EventTarget {
  muted = false;
  defaultMuted = false;
  playsInline = false;
  preload = "";
  crossOrigin: string | null = null;
  src = "";
  videoWidth = 1280;
  videoHeight = 720;
  error: MediaError | null = null;
  paused = false;
  removedSource = false;
  loadCalls = 0;
  #currentTime = 0;
  #callback:
    | ((now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void)
    | null = null;

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
    queueMicrotask(() => {
      this.dispatchEvent(new Event("seeked"));
      this.#callback?.(0, {} as VideoFrameCallbackMetadata);
    });
  }

  load(): void {
    this.loadCalls += 1;
    if (this.src)
      queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    this.paused = false;
    queueMicrotask(() =>
      this.#callback?.(0, {
        mediaTime: this.#currentTime,
      } as VideoFrameCallbackMetadata),
    );
    return Promise.resolve();
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
      this.removedSource = true;
    }
  }

  requestVideoFrameCallback(
    callback: (
      now: DOMHighResTimeStamp,
      metadata: VideoFrameCallbackMetadata,
    ) => void,
  ): number {
    this.#callback = callback;
    return 1;
  }

  cancelVideoFrameCallback(): void {
    this.#callback = null;
  }
}

const canvasFor = (
  replacements: Readonly<
    Record<string, readonly [number, number, number]>
  > = {},
): {
  canvas: HTMLCanvasElement;
  state: { drawn: boolean; width: number; height: number };
} => {
  const state = { drawn: false, width: 0, height: 0 };
  const context = {
    drawImage: (): void => {
      state.drawn = true;
    },
    getContextAttributes: () => ({ colorSpace: "srgb" }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const patch = COLOR_ORACLE_PATCHES.find(
        (candidate) => candidate.rect.x === x && candidate.rect.y === y,
      );
      if (!patch)
        throw new Error(`Unknown patch at ${String(x)},${String(y)}.`);
      const rgb = replacements[patch.name] ?? patch.srgb;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
        data[offset + 3] = 255;
      }
      return { data };
    },
  };
  const canvas = {
    get width(): number {
      return state.width;
    },
    set width(value: number) {
      state.width = value;
    },
    get height(): number {
      return state.height;
    },
    set height(value: number) {
      state.height = value;
    },
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, state };
};

describe("browser color self-check", () => {
  it("classifies browser identity without retaining a raw user agent", () => {
    expect(
      detectBrowserIdentity(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
      ),
    ).toEqual({
      engineFamily: "chromium",
      engineMajor: 149,
      platformClass: "windows",
    });
    expect(
      detectBrowserIdentity(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/151.0",
      ),
    ).toEqual({
      engineFamily: "firefox",
      engineMajor: 151,
      platformClass: "mac",
    });
    expect(
      detectBrowserIdentity(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Version/27.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({
      engineFamily: "webkit",
      engineMajor: 27,
      platformClass: "mobile",
    });
  });

  it("keys the cache by build, engine, platform, and clip hash", () => {
    expect(
      colorSelfCheckVersionKey("build-7", {
        engineFamily: "chromium",
        engineMajor: 149,
        platformClass: "windows",
      }),
    ).toBe(`build-7:chromium:149:windows:${COLOR_SELF_CHECK_CLIP_SHA256}`);
  });

  it("runs the detached native path, compares every patch, and cleans up", async () => {
    const storage = new MemoryStorage();
    const video = new TestVideo();
    const { canvas, state } = canvasFor();
    const result = await runColorSelfCheck(
      {
        buildId: "pass-build",
        storage,
        identity: {
          engineFamily: "chromium",
          engineMajor: 149,
          platformClass: "windows",
        },
      },
      {
        createVideo: () => video as unknown as HTMLVideoElement,
        createCanvas: () => canvas,
        now: (() => {
          let value = 100;
          return () => (value += 5);
        })(),
      },
    );
    expect(result).toMatchObject({
      outcome: "pass",
      stage: "complete",
      deviation: "none",
      canvasColorSpace: "srgb",
      failedPatches: [],
      cached: false,
    });
    expect(result.patchMaxDelta).toEqual([0, 0, 0]);
    expect(state.drawn).toBe(true);
    expect(state).toMatchObject({ width: 0, height: 0 });
    expect(video).toMatchObject({
      muted: true,
      defaultMuted: true,
      playsInline: true,
      paused: true,
      removedSource: true,
    });
    expect(storage.length).toBe(1);
  });

  it("reuses the cache without constructing media resources", async () => {
    const storage = new MemoryStorage();
    const identity = {
      engineFamily: "chromium" as const,
      engineMajor: 149,
      platformClass: "windows" as const,
    };
    const first = canvasFor();
    await runColorSelfCheck(
      { buildId: "cached-build", storage, identity },
      {
        createVideo: () => new TestVideo() as unknown as HTMLVideoElement,
        createCanvas: () => first.canvas,
      },
    );
    const cached = await runColorSelfCheck(
      { buildId: "cached-build", storage, identity },
      {
        createVideo: () => {
          throw new Error("cache miss");
        },
        createCanvas: () => {
          throw new Error("cache miss");
        },
      },
    );
    expect(cached).toMatchObject({
      outcome: "pass",
      stage: "complete",
      cached: true,
      failure: null,
    });
  });

  it("reports a classified warning without correcting the readings", async () => {
    const { canvas } = canvasFor({
      black0: [16, 16, 16],
      white100: [235, 235, 235],
    });
    const result = await runColorSelfCheck(
      {
        buildId: "range-warning",
        storage: null,
        identity: {
          engineFamily: "webkit",
          engineMajor: 27,
          platformClass: "mac",
        },
      },
      {
        createVideo: () => new TestVideo() as unknown as HTMLVideoElement,
        createCanvas: () => canvas,
      },
    );
    expect(result).toMatchObject({
      outcome: "warning",
      stage: "complete",
      deviation: "range",
      failedPatches: ["black0", "white100"],
      patchMaxDelta: [20, 20, 20],
    });
  });

  it("returns unsupported on a bounded load timeout and still cleans up", async () => {
    const video = new TestVideo();
    video.load = (): void => {
      video.loadCalls += 1;
    };
    const { canvas, state } = canvasFor();
    const result = await runColorSelfCheck(
      {
        buildId: "load-timeout",
        storage: null,
        timeoutMs: 2,
        identity: {
          engineFamily: "unknown",
          engineMajor: null,
          platformClass: "unknown",
        },
      },
      {
        createVideo: () => video as unknown as HTMLVideoElement,
        createCanvas: () => canvas,
      },
    );
    expect(result).toMatchObject({
      outcome: "unsupported",
      stage: "load",
      cached: false,
    });
    expect(result.failure).toContain("loadedmetadata timed out");
    expect(video.removedSource).toBe(true);
    expect(state).toMatchObject({ width: 0, height: 0 });
  });
});
