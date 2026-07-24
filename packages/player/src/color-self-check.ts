import {
  COLOR_ORACLE_PATCHES,
  compareColorOracle,
  type ColorDeviationKind,
  type ColorPatchDelta,
  type ColorPatchReading,
  type ColorTriplet,
} from "./color-oracle.js";

export const COLOR_SELF_CHECK_CLIP_URL = "/media/color-check-bt709.mp4";
export const COLOR_SELF_CHECK_CLIP_SHA256 =
  "697e236ea7dbd0d3661bd8c9799231ce4dfa8534cc8da21be3524996b918b1fd";

const CACHE_PREFIX = "onelight.color-self-check.v1:";
const CLIP_WIDTH = 1280;
const CLIP_HEIGHT = 720;
const SAMPLE_TIME_SECONDS = 0.25;

export type BrowserEngineFamily = "chromium" | "firefox" | "webkit" | "unknown";
export type PlatformClass = "mac" | "windows" | "linux" | "mobile" | "unknown";
export type CanvasColorSpace = "srgb" | "display-p3" | "unknown";
export type ColorSelfCheckStage =
  "load" | "decode" | "canvas" | "readback" | "compare" | "complete";

export interface BrowserIdentity {
  engineFamily: BrowserEngineFamily;
  engineMajor: number | null;
  platformClass: PlatformClass;
}

export interface ColorSelfCheckResult {
  outcome: "pass" | "warning" | "unsupported";
  stage: ColorSelfCheckStage;
  deviation: ColorDeviationKind;
  canvasColorSpace: CanvasColorSpace;
  patchMaxDelta: ColorTriplet | null;
  failedPatches: string[];
  elapsedMs: number;
  failure: string | null;
  versionKey: string;
  timestamp: number;
  cached: boolean;
  deltas: ColorPatchDelta[];
}

export interface ColorSelfCheckDiagnostic {
  kind: "color_self_check";
  outcome: "pass" | "warning" | "unsupported";
  stage: ColorSelfCheckStage;
  engine_family: BrowserEngineFamily;
  engine_major: number | null;
  platform_class: PlatformClass;
  canvas_color_space: CanvasColorSpace;
  patch_max_delta: ColorTriplet | null;
  failed_patches: string[];
  elapsed_ms: number;
  failure: string | null;
}

export interface ColorSelfCheckOptions {
  buildId: string;
  clipUrl?: string;
  clipHash?: string;
  identity?: BrowserIdentity;
  timeoutMs?: number;
  storage?: Storage | null;
}

export interface ColorSelfCheckDependencies {
  createVideo?: () => HTMLVideoElement;
  createCanvas?: () => HTMLCanvasElement;
  now?: () => number;
  userAgent?: string;
  platform?: string;
}

interface CachedDelta {
  name: string;
  delta: ColorTriplet;
}

interface CachedColorSelfCheck {
  version_key: string;
  outcome: "pass" | "warning" | "unsupported";
  deltas: CachedDelta[];
  timestamp: number;
}

const inFlight = new Map<string, Promise<ColorSelfCheckResult>>();
const reportedDiagnostics = new Set<string>();

const majorFrom = (userAgent: string, expression: RegExp): number | null => {
  const value = Number(expression.exec(userAgent)?.[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export const detectBrowserIdentity = (
  userAgent: string,
  platform = "",
): BrowserIdentity => {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(
    `${userAgent} ${platform}`,
  );
  const platformClass: PlatformClass = mobile
    ? "mobile"
    : /Windows/i.test(`${userAgent} ${platform}`)
      ? "windows"
      : /Macintosh|Mac OS X|MacIntel/i.test(`${userAgent} ${platform}`)
        ? "mac"
        : /Linux|X11/i.test(`${userAgent} ${platform}`)
          ? "linux"
          : "unknown";

  if (/Firefox\//i.test(userAgent))
    return {
      engineFamily: "firefox",
      engineMajor: majorFrom(userAgent, /Firefox\/(\d+)/i),
      platformClass,
    };
  if (/Edg\/|Chrome\/|Chromium\//i.test(userAgent))
    return {
      engineFamily: "chromium",
      engineMajor:
        majorFrom(userAgent, /(?:Edg|Chrome|Chromium)\/(\d+)/i) ?? null,
      platformClass,
    };
  if (/Safari\//i.test(userAgent))
    return {
      engineFamily: "webkit",
      engineMajor: majorFrom(userAgent, /Version\/(\d+)/i),
      platformClass,
    };
  return {
    engineFamily: "unknown",
    engineMajor: null,
    platformClass,
  };
};

export const colorSelfCheckVersionKey = (
  buildId: string,
  identity: BrowserIdentity,
  clipHash = COLOR_SELF_CHECK_CLIP_SHA256,
): string =>
  [
    buildId,
    identity.engineFamily,
    identity.engineMajor === null ? "unknown" : String(identity.engineMajor),
    identity.platformClass,
    clipHash,
  ].join(":");

export const colorSelfCheckDiagnostic = (
  result: ColorSelfCheckResult,
  identity: BrowserIdentity,
): ColorSelfCheckDiagnostic => ({
  kind: "color_self_check",
  outcome: result.outcome,
  stage: result.stage,
  engine_family: identity.engineFamily,
  engine_major: identity.engineMajor,
  platform_class: identity.platformClass,
  canvas_color_space: result.canvasColorSpace,
  patch_max_delta: result.patchMaxDelta,
  failed_patches: result.failedPatches,
  elapsed_ms: Math.max(0, Math.round(result.elapsedMs)),
  failure: result.failure,
});

export const claimColorSelfCheckDiagnostic = (versionKey: string): boolean => {
  if (reportedDiagnostics.has(versionKey)) return false;
  reportedDiagnostics.add(versionKey);
  return true;
};

const storageFor = (provided: Storage | null | undefined): Storage | null => {
  if (provided !== undefined) return provided;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const cacheKey = (versionKey: string): string => `${CACHE_PREFIX}${versionKey}`;

const validTriplet = (value: unknown): value is ColorTriplet =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((entry) => typeof entry === "number" && Number.isFinite(entry));

const readCache = (
  storage: Storage | null,
  versionKey: string,
): CachedColorSelfCheck | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(cacheKey(versionKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedColorSelfCheck>;
    if (
      value.version_key !== versionKey ||
      !["pass", "warning", "unsupported"].includes(value.outcome ?? "") ||
      !Array.isArray(value.deltas) ||
      typeof value.timestamp !== "number" ||
      !value.deltas.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.name === "string" &&
          validTriplet(entry.delta),
      )
    )
      return null;
    return value as CachedColorSelfCheck;
  } catch {
    return null;
  }
};

const writeCache = (
  storage: Storage | null,
  entry: CachedColorSelfCheck,
): void => {
  if (!storage) return;
  try {
    storage.setItem(cacheKey(entry.version_key), JSON.stringify(entry));
  } catch {
    // Private mode and storage quotas must not turn a color check into a fault.
  }
};

const patchMaxDelta = (
  deltas: readonly Pick<ColorPatchDelta, "delta">[],
): ColorTriplet | null => {
  if (deltas.length === 0) return null;
  const maximum: [number, number, number] = [0, 0, 0];
  for (const { delta } of deltas)
    for (const channel of [0, 1, 2] as const)
      maximum[channel] = Math.max(maximum[channel], Math.abs(delta[channel]));
  return maximum;
};

const resultFromCache = (entry: CachedColorSelfCheck): ColorSelfCheckResult => {
  const deltaByName = new Map(
    entry.deltas.map((delta) => [delta.name, delta.delta]),
  );
  const readings: ColorPatchReading[] = COLOR_ORACLE_PATCHES.flatMap(
    (patch) => {
      const delta = deltaByName.get(patch.name);
      return delta
        ? [
            {
              name: patch.name,
              rgb: [
                patch.srgb[0] + delta[0],
                patch.srgb[1] + delta[1],
                patch.srgb[2] + delta[2],
              ],
            },
          ]
        : [];
    },
  );
  const comparison =
    entry.outcome === "unsupported" ? null : compareColorOracle(readings);
  return {
    outcome: entry.outcome,
    stage: "complete",
    deviation: comparison?.deviation ?? "unclassified",
    canvasColorSpace: "unknown",
    patchMaxDelta: patchMaxDelta(entry.deltas),
    failedPatches: comparison
      ? [...new Set(comparison.failures.map((failure) => failure.patch))]
      : [],
    elapsedMs: 0,
    failure:
      entry.outcome === "unsupported"
        ? "The cached native color check was unsupported."
        : null,
    versionKey: entry.version_key,
    timestamp: entry.timestamp,
    cached: true,
    deltas: comparison?.deltas ?? [],
  };
};

const waitForEvent = (
  target: EventTarget,
  eventName: string,
  timeoutMs: number,
  errorMessage: () => string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(errorMessage()));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`${eventName} timed out after ${String(timeoutMs)} ms.`),
      );
    }, timeoutMs);
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });

const waitForPresentedFrame = (
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<void> => {
  if (typeof video.requestVideoFrameCallback !== "function")
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    let callbackId: number | null = null;
    const cleanup = (): void => {
      clearTimeout(timer);
      if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
      video.removeEventListener("error", onError);
    };
    const onError = (): void => {
      cleanup();
      reject(
        new Error(
          `Video decode failed with media error ${String(video.error?.code ?? 0)}.`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Presented frame timed out after ${String(timeoutMs)} ms.`),
      );
    }, timeoutMs);
    video.addEventListener("error", onError, { once: true });
    callbackId = video.requestVideoFrameCallback(() => {
      cleanup();
      resolve();
    });
  });
};

const canvasColorSpace = (
  context: CanvasRenderingContext2D,
): CanvasColorSpace => {
  const attributes = (
    context as CanvasRenderingContext2D & {
      getContextAttributes?: () => { colorSpace?: string };
    }
  ).getContextAttributes?.();
  return attributes?.colorSpace === "srgb" ||
    attributes?.colorSpace === "display-p3"
    ? attributes.colorSpace
    : "unknown";
};

const averagePatch = (
  context: CanvasRenderingContext2D,
  rect: ColorOraclePatchRect,
): ColorTriplet => {
  const data = context.getImageData(rect.x, rect.y, rect.w, rect.h).data;
  const sums = [0, 0, 0];
  const pixels = rect.w * rect.h;
  for (let offset = 0; offset < data.length; offset += 4) {
    sums[0] = (sums[0] ?? 0) + (data[offset] ?? 0);
    sums[1] = (sums[1] ?? 0) + (data[offset + 1] ?? 0);
    sums[2] = (sums[2] ?? 0) + (data[offset + 2] ?? 0);
  }
  return [
    Math.round((sums[0] ?? 0) / pixels),
    Math.round((sums[1] ?? 0) / pixels),
    Math.round((sums[2] ?? 0) / pixels),
  ];
};

type ColorOraclePatchRect = (typeof COLOR_ORACLE_PATCHES)[number]["rect"];

const performColorSelfCheck = async (
  options: Required<
    Pick<
      ColorSelfCheckOptions,
      "buildId" | "clipUrl" | "clipHash" | "timeoutMs"
    >
  > & {
    identity: BrowserIdentity;
    storage: Storage | null;
  },
  dependencies: ColorSelfCheckDependencies,
): Promise<ColorSelfCheckResult> => {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const timestamp = Date.now();
  const versionKey = colorSelfCheckVersionKey(
    options.buildId,
    options.identity,
    options.clipHash,
  );
  let stage: ColorSelfCheckStage = "load";
  let colorSpace: CanvasColorSpace = "unknown";
  const video =
    dependencies.createVideo?.() ??
    (typeof document === "undefined" ? null : document.createElement("video"));
  const canvas =
    dependencies.createCanvas?.() ??
    (typeof document === "undefined" ? null : document.createElement("canvas"));

  const finishUnsupported = (error: unknown): ColorSelfCheckResult => {
    const failure =
      error instanceof Error ? error.message.slice(0, 300) : String(error);
    const result: ColorSelfCheckResult = {
      outcome: "unsupported",
      stage,
      deviation: "unclassified",
      canvasColorSpace: colorSpace,
      patchMaxDelta: null,
      failedPatches: [],
      elapsedMs: Math.max(0, now() - startedAt),
      failure,
      versionKey,
      timestamp,
      cached: false,
      deltas: [],
    };
    writeCache(options.storage, {
      version_key: versionKey,
      outcome: result.outcome,
      deltas: [],
      timestamp,
    });
    return result;
  };

  if (!video || !canvas)
    return finishUnsupported(
      new Error("HTML video and canvas are unavailable in this environment."),
    );

  try {
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    const loaded = waitForEvent(
      video,
      "loadedmetadata",
      options.timeoutMs,
      () =>
        `Video load failed with media error ${String(video.error?.code ?? 0)}.`,
    );
    video.src = options.clipUrl;
    video.load();
    await loaded;
    if (video.videoWidth !== CLIP_WIDTH || video.videoHeight !== CLIP_HEIGHT)
      throw new Error(
        `Unexpected self-check dimensions ${String(video.videoWidth)}x${String(video.videoHeight)}.`,
      );

    stage = "decode";
    const seeked = waitForEvent(
      video,
      "seeked",
      options.timeoutMs,
      () =>
        `Video decode failed with media error ${String(video.error?.code ?? 0)}.`,
    );
    video.currentTime = SAMPLE_TIME_SECONDS;
    await seeked;
    const presented = waitForPresentedFrame(video, options.timeoutMs);
    await video.play();
    await presented;
    video.pause();

    stage = "canvas";
    canvas.width = CLIP_WIDTH;
    canvas.height = CLIP_HEIGHT;
    const context = canvas.getContext("2d", {
      colorSpace: "srgb",
      willReadFrequently: true,
    });
    if (!context) throw new Error("An sRGB 2D canvas is unavailable.");
    colorSpace = canvasColorSpace(context);
    context.drawImage(video, 0, 0, CLIP_WIDTH, CLIP_HEIGHT);

    stage = "readback";
    const readings: ColorPatchReading[] = COLOR_ORACLE_PATCHES.map((patch) => ({
      name: patch.name,
      rgb: averagePatch(context, patch.rect),
    }));

    stage = "compare";
    const comparison = compareColorOracle(readings);
    const failedPatches = [
      ...new Set(comparison.failures.map((failure) => failure.patch)),
    ];
    const result: ColorSelfCheckResult = {
      outcome: comparison.status,
      stage: "complete",
      deviation: comparison.deviation,
      canvasColorSpace: colorSpace,
      patchMaxDelta: patchMaxDelta(comparison.deltas),
      failedPatches,
      elapsedMs: Math.max(0, now() - startedAt),
      failure: null,
      versionKey,
      timestamp,
      cached: false,
      deltas: comparison.deltas,
    };
    writeCache(options.storage, {
      version_key: versionKey,
      outcome: result.outcome,
      deltas: result.deltas.map((delta) => ({
        name: delta.name,
        delta: delta.delta,
      })),
      timestamp,
    });
    return result;
  } catch (error) {
    return finishUnsupported(error);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    canvas.width = 0;
    canvas.height = 0;
  }
};

export const runColorSelfCheck = async (
  options: ColorSelfCheckOptions,
  dependencies: ColorSelfCheckDependencies = {},
): Promise<ColorSelfCheckResult> => {
  const userAgent =
    dependencies.userAgent ??
    (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const platform =
    dependencies.platform ??
    (typeof navigator === "undefined" ? "" : navigator.platform);
  const identity =
    options.identity ?? detectBrowserIdentity(userAgent, platform);
  const clipUrl = options.clipUrl ?? COLOR_SELF_CHECK_CLIP_URL;
  const clipHash = options.clipHash ?? COLOR_SELF_CHECK_CLIP_SHA256;
  const timeoutMs = options.timeoutMs ?? 5000;
  const storage = storageFor(options.storage);
  const versionKey = colorSelfCheckVersionKey(
    options.buildId,
    identity,
    clipHash,
  );
  const cached = readCache(storage, versionKey);
  if (cached) return resultFromCache(cached);

  const existing = inFlight.get(versionKey);
  if (existing) return existing;
  const pending = performColorSelfCheck(
    {
      buildId: options.buildId,
      clipUrl,
      clipHash,
      timeoutMs,
      identity,
      storage,
    },
    dependencies,
  );
  inFlight.set(versionKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(versionKey) === pending) inFlight.delete(versionKey);
  }
};
