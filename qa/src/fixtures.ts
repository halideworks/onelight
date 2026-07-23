/* Fixture corpus synthesis. Everything is generated at test time with
   ffmpeg, never committed (qa/.artifacts/ is gitignored).

   The encode shape deliberately mirrors buildSdrProxyArgs in
   packages/worker/src/media.ts: libx264, CRF 18, preset medium, yuv420p,
   1 second GOP with scene-cut disabled, explicit BT.709 limited-range tags,
   +faststart. The supported rate list and the probe normalizer are imported
   from that module directly so the corpus can never drift from the product
   recipe. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isHdrSource,
  probeFile,
  runProcess,
  SUPPORTED_MEDIA_RATES,
} from "../../packages/worker/src/media.js";
import { fixturesDir, manifestPath } from "./capabilities.js";
import { stripeFilters } from "./stripe.js";

export interface QaRate {
  num: number;
  den: number;
}

export interface RateClipFixture {
  id: string;
  file: string;
  rate: QaRate;
  frames: number;
}

export interface ColorPatch {
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  /* The exact float BT.709 limited-to-full conversion of the encoded YUV:
     the reference a correct browser pipeline must reproduce. Computed in
     TypeScript from the decoded YUV planes, NOT via swscale, whose
     fixed-point RGB output is itself off by up to 3/255. */
  srgb: [number, number, number];
  /* The analytic SMPTE RP 219 value the patch is supposed to carry; the
     generator asserts srgb is within 3/255 of this, so a wrong fixture
     fails at synthesis time, not in the browser. */
  nominal: [number, number, number];
  /* Per-channel assertion tolerance for browser readback, see
     patchTolerance below for the justification of every value. */
  tolerance: [number, number, number];
}

/* Bump to invalidate corpora produced by older synthesis code. */
export const CORPUS_VERSION = 3;

export interface FixtureManifest {
  version: number;
  generatedAt: string;
  fontFile: string | null;
  rateClips: RateClipFixture[];
  dropFrame: { file: string; timecode: string; rate: QaRate };
  shuttleAudio: { file: string; durationSeconds: number };
  bars: {
    file: string;
    width: number;
    height: number;
    patchesFile: string;
    patches: ColorPatch[];
  };
}

const WIDTH = 1280;
const HEIGHT = 720;
const COUNTER_SECONDS = 10;
const BARS_SECONDS = 5;
const SHUTTLE_AUDIO_SECONDS = 6;
export const DF_START_TIMECODE = "00:59:55;00";
export const DF_RATE: QaRate = { num: 30000, den: 1001 };
const BARS_RATE: QaRate = { num: 25, den: 1 };

const ffmpegBin = (): string => process.env.FFMPEG_PATH ?? "ffmpeg";

const gopSize = (rate: QaRate): number =>
  Math.max(1, Math.round(rate.num / rate.den));

const rateId = (rate: QaRate): string => `rate-${rate.num}-${rate.den}`;

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:\\Windows\\Fonts\\arial.ttf",
];

export const findFontFile = (): string | null =>
  FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

/* Windows drive-letter paths crash or misparse inside a filtergraph value;
   forward slashes plus an escaped colon work on every platform. */
const escapeFontPath = (fontFile: string): string =>
  fontFile.replaceAll("\\", "/").replaceAll(":", "\\:");

/* The big centered counter is a human-debuggable aid; verification uses the
   pixel stripe, so a machine without a known font file still produces valid
   fixtures. */
const counterFilter = (fontFile: string | null): string[] =>
  fontFile === null
    ? []
    : [
        `drawtext=fontfile='${escapeFontPath(fontFile)}':text='%{frame_num}':fontsize=200:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
      ];

const proxyShapeArgs = (rate: QaRate): string[] => [
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-g",
  String(gopSize(rate)),
  "-keyint_min",
  String(gopSize(rate)),
  "-sc_threshold",
  "0",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
  "-movflags",
  "+faststart",
];

export const counterClipArgs = (
  rate: QaRate,
  outputPath: string,
  fontFile: string | null,
  extra: string[] = [],
): string[] => [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `color=c=0x2f2f2f:s=${WIDTH}x${HEIGHT}:r=${rate.num}/${rate.den}:d=${COUNTER_SECONDS}`,
  "-vf",
  [...counterFilter(fontFile), ...stripeFilters()].join(","),
  ...proxyShapeArgs(rate),
  ...extra,
  outputPath,
];

export const barsClipArgs = (outputPath: string): string[] => [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `smptehdbars=s=${WIDTH}x${HEIGHT}:r=${BARS_RATE.num}/${BARS_RATE.den}:d=${BARS_SECONDS}`,
  "-vf",
  "format=yuv420p",
  ...proxyShapeArgs(BARS_RATE),
  outputPath,
];

export const shuttleAudioClipArgs = (outputPath: string): string[] => [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `color=c=0x2f2f2f:s=${WIDTH}x${HEIGHT}:r=24:d=${SHUTTLE_AUDIO_SECONDS}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=997:sample_rate=48000:duration=${SHUTTLE_AUDIO_SECONDS}`,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-vf",
  "format=yuv420p",
  ...proxyShapeArgs({ num: 24, den: 1 }),
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-ar",
  "48000",
  "-b:a",
  "192k",
  "-shortest",
  outputPath,
];

/* SMPTE RP 219 nominal sRGB values after a correct limited-range BT.709
   decode: 75 percent bars are 0.75 * 255 = 191 per lit channel, the pattern
   1 side columns are 40 percent grey. */
const V75 = 191;
const G40 = 102;
const TOP_BAND_NOMINALS: Array<{
  name: string;
  nominal: [number, number, number];
}> = [
  { name: "grey40_left", nominal: [G40, G40, G40] },
  { name: "white75", nominal: [V75, V75, V75] },
  { name: "yellow75", nominal: [V75, V75, 0] },
  { name: "cyan75", nominal: [0, V75, V75] },
  { name: "green75", nominal: [0, V75, 0] },
  { name: "magenta75", nominal: [V75, 0, V75] },
  { name: "red75", nominal: [V75, 0, 0] },
  { name: "blue75", nominal: [0, 0, V75] },
  { name: "grey40_right", nominal: [G40, G40, G40] },
];

interface Run {
  start: number;
  end: number;
  yuv: [number, number, number];
}

/* Planar yuv444p layout: full-resolution Y, then U, then V planes. */
const pixelAt = (
  planes: Buffer,
  x: number,
  y: number,
): [number, number, number] => {
  const offset = y * WIDTH + x;
  const planeSize = WIDTH * HEIGHT;
  return [
    planes[offset] ?? 0,
    planes[planeSize + offset] ?? 0,
    planes[2 * planeSize + offset] ?? 0,
  ];
};

/* Exact limited-range BT.709 YCbCr to full-range sRGB-encoded values, in
   float, rounded once at the end. This is the ground truth conversion the
   design doc's color tags promise (docs/research/playback-transcode.md
   section 2.4). */
const yuvToSrgb = (yuv: [number, number, number]): [number, number, number] => {
  const y = (yuv[0] - 16) / 219;
  const u = (yuv[1] - 128) / 224;
  const v = (yuv[2] - 128) / 224;
  const kr = 0.2126;
  const kb = 0.0722;
  const kg = 1 - kr - kb;
  const r = y + 2 * (1 - kr) * v;
  const g = y - (2 * kb * (1 - kb) * u + 2 * kr * (1 - kr) * v) / kg;
  const b = y + 2 * (1 - kb) * u;
  const quantize = (value: number): number =>
    Math.round(Math.min(1, Math.max(0, value)) * 255);
  return [quantize(r), quantize(g), quantize(b)];
};

/* Browser readback tolerances, per channel.

   Baseline is 2/255: one quantization step can be lost encoding to 8-bit
   limited range and one more converting back to RGB, so |diff| <= 2 is
   rounding noise, while the bug classes this suite exists to catch sit far
   outside it (research report section 2.4): 16-235 vs 0-255 range
   mishandling lifts black by ~16 and clips white by ~20, BT.601 vs BT.709
   matrix confusion moves the R and G of saturated bars by 15+, and a
   QuickTime-style 1.96-vs-2.4 gamma shift moves midtones by 10-20.

   The blue channel of chroma-saturated patches gets 12/255, for a measured
   and understood reason: both Chromium and Firefox draw video to canvas
   through libyuv, whose int8 SIMD kernel must clamp the BT.709 U-to-B
   coefficient (2.1124 * 64 = 135) to the lane maximum 127, i.e. it
   converts with 1.984 instead of 2.1124. That understates |B| by up to
   0.128 * |Cb - 128|, about 11/255 at the 75 percent bars' Cb of 44/212
   (measured: 9). It is an artifact of the canvas readback measurement
   path, not of on-screen rendering, and it affects blue only; matrix and
   range errors remain detected through the R/G channels and the neutral
   patches, which keep the tight tolerance on all three channels. */
const patchTolerance = (
  yuv: [number, number, number],
): [number, number, number] =>
  Math.abs(yuv[1] - 128) <= 4 && Math.abs(yuv[2] - 128) <= 4
    ? [2, 2, 2]
    : [2, 2, 12];

const close = (a: number, b: number, tolerance: number): boolean =>
  Math.abs(a - b) <= tolerance;

const closeRgb = (
  a: [number, number, number],
  b: [number, number, number],
  tolerance: number,
): boolean =>
  close(a[0], b[0], tolerance) &&
  close(a[1], b[1], tolerance) &&
  close(a[2], b[2], tolerance);

/* Splits a scanline into runs of near-constant YUV. Patch centers come
   from run centers, so the exact bar boundary rounding ffmpeg applies never
   matters. */
const segmentRow = (planes: Buffer, y: number): Run[] => {
  const runs: Run[] = [];
  let start = 0;
  let anchor = pixelAt(planes, 0, y);
  for (let x = 1; x <= WIDTH; x += 1) {
    const pixel = x < WIDTH ? pixelAt(planes, x, y) : null;
    if (pixel !== null && closeRgb(pixel, anchor, 8)) continue;
    runs.push({ start, end: x - 1, yuv: anchor });
    if (pixel !== null) {
      start = x;
      anchor = pixel;
    }
  }
  return runs;
};

const regionAverage = (
  planes: Buffer,
  rect: { x: number; y: number; w: number; h: number },
): [number, number, number] => {
  const sums = [0, 0, 0];
  let extremeDeviation = 0;
  const pixels: Array<[number, number, number]> = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1)
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const pixel = pixelAt(planes, x, y);
      pixels.push(pixel);
      sums[0] = (sums[0] ?? 0) + pixel[0];
      sums[1] = (sums[1] ?? 0) + pixel[1];
      sums[2] = (sums[2] ?? 0) + pixel[2];
    }
  const count = rect.w * rect.h;
  const average: [number, number, number] = [
    Math.round((sums[0] ?? 0) / count),
    Math.round((sums[1] ?? 0) / count),
    Math.round((sums[2] ?? 0) / count),
  ];
  for (const pixel of pixels)
    for (let channel = 0; channel < 3; channel += 1)
      extremeDeviation = Math.max(
        extremeDeviation,
        Math.abs((pixel[channel] ?? 0) - (average[channel] ?? 0)),
      );
  if (extremeDeviation > 4)
    throw new Error(
      `Color patch region at ${rect.x},${rect.y} is not uniform (max deviation ${extremeDeviation}); patch geometry is wrong.`,
    );
  return average;
};

const patchFromRun = (
  planes: Buffer,
  run: Run,
  y: number,
  name: string,
  nominal: [number, number, number],
): ColorPatch => {
  const centerX = Math.round((run.start + run.end) / 2);
  const rect = { x: centerX - 10, y: y - 10, w: 20, h: 20 };
  const yuv = regionAverage(planes, rect);
  const srgb = yuvToSrgb(yuv);
  if (!closeRgb(srgb, nominal, 3))
    throw new Error(
      `Bars patch ${name}: decoded YUV ${yuv.join(",")} converts to ${srgb.join(",")}, disagreeing with RP 219 nominal ${nominal.join(",")}; fixture synthesis is broken.`,
    );
  return { name, rect, srgb, nominal, tolerance: patchTolerance(yuv) };
};

export const analyzeBars = async (barsPath: string): Promise<ColorPatch[]> => {
  const rawPath = path.join(fixturesDir, "bars-frame0.yuv");
  /* Dump the decoded frame as planar 4:4:4 YUV: no RGB conversion happens
     in ffmpeg at all, so the reference sRGB values come exclusively from
     the exact float conversion above. The 420-to-444 chroma upsample is
     lossless inside the uniform patch interiors, which the uniformity check
     in regionAverage enforces. */
  await runProcess(ffmpegBin(), [
    "-hide_banner",
    "-y",
    "-i",
    barsPath,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "yuv444p",
    rawPath,
  ]);
  const planes = await readFile(rawPath);
  if (planes.length !== WIDTH * HEIGHT * 3)
    throw new Error(`Unexpected raw frame size ${planes.length}.`);

  /* Pattern 1 (the 75 percent bars plus 40 percent grey columns) occupies
     the top 7/12 of the frame; sample its vertical middle. */
  const topY = Math.round((HEIGHT * 7) / 24);
  const topRuns = segmentRow(planes, topY).filter(
    (run) => run.end - run.start >= 50,
  );
  if (topRuns.length !== TOP_BAND_NOMINALS.length)
    throw new Error(
      `Expected ${TOP_BAND_NOMINALS.length} bars in the top band, found ${topRuns.length}.`,
    );
  const patches = topRuns.map((run, index) => {
    const spec = TOP_BAND_NOMINALS[index];
    if (!spec) throw new Error("unreachable");
    return patchFromRun(planes, run, topY, spec.name, spec.nominal);
  });

  /* Pattern 4 (bottom 3/12 of the frame) carries full 0 percent black and
     100 percent white patches: the strongest range-error detectors. Runs
     are located by value (limited-range YUV), not by hardcoded RP 219
     geometry. */
  const bottomY = Math.round((HEIGHT * 21) / 24);
  const bottomRuns = segmentRow(planes, bottomY).filter(
    (run) => run.end - run.start >= 50,
  );
  const black = bottomRuns
    .filter((run) => closeRgb(run.yuv, [16, 128, 128], 3))
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const white = bottomRuns
    .filter((run) => closeRgb(run.yuv, [235, 128, 128], 3))
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (!black || !white)
    throw new Error(
      `Could not locate 0 percent black and 100 percent white patches in the bottom band (runs: ${bottomRuns
        .map((run) => `${run.start}-${run.end}@${run.yuv.join(",")}`)
        .join(" ")}).`,
    );
  patches.push(patchFromRun(planes, black, bottomY, "black0", [0, 0, 0]));
  patches.push(
    patchFromRun(planes, white, bottomY, "white100", [255, 255, 255]),
  );
  return patches;
};

const manifestUpToDate = async (): Promise<FixtureManifest | null> => {
  try {
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as FixtureManifest;
    if (manifest.version !== CORPUS_VERSION) return null;
    const files = [
      ...manifest.rateClips.map((clip) => clip.file),
      manifest.dropFrame.file,
      manifest.shuttleAudio.file,
      manifest.bars.file,
      manifest.bars.patchesFile,
    ];
    if (files.every((file) => existsSync(path.join(fixturesDir, file))))
      return manifest;
    return null;
  } catch {
    return null;
  }
};

export const synthesizeFixtures = async (
  log: (line: string) => void = console.log,
): Promise<FixtureManifest> => {
  const existing = await manifestUpToDate();
  if (existing) {
    log(`[qa] fixtures: reusing existing corpus in ${fixturesDir}`);
    return existing;
  }
  await mkdir(fixturesDir, { recursive: true });
  const fontFile = findFontFile();
  if (fontFile === null)
    log(
      "[qa] fixtures: no known font file found; clips carry the pixel stripe but no human-readable counter",
    );

  const rateClips: RateClipFixture[] = [];
  for (const rate of SUPPORTED_MEDIA_RATES) {
    const id = rateId(rate);
    const file = `${id}.mp4`;
    const outputPath = path.join(fixturesDir, file);
    log(`[qa] fixtures: synthesizing ${file}`);
    await runProcess(ffmpegBin(), counterClipArgs(rate, outputPath, fontFile));
    const probe = await probeFile(outputPath);
    if (
      probe.frameRateNum !== rate.num ||
      probe.frameRateDen !== rate.den ||
      probe.durationFrames === undefined
    )
      throw new Error(
        `Fixture ${file} probed as ${probe.frameRateNum}/${probe.frameRateDen} with ${probe.durationFrames} frames; expected ${rate.num}/${rate.den}.`,
      );
    rateClips.push({ id, file, rate, frames: probe.durationFrames });
  }

  const dfFile = "dropframe-2997.mp4";
  log(`[qa] fixtures: synthesizing ${dfFile}`);
  await runProcess(
    ffmpegBin(),
    counterClipArgs(DF_RATE, path.join(fixturesDir, dfFile), fontFile, [
      "-timecode",
      DF_START_TIMECODE,
      "-write_tmcd",
      "on",
    ]),
  );

  const barsFile = "bars-bt709.mp4";
  log(`[qa] fixtures: synthesizing ${barsFile}`);
  await runProcess(ffmpegBin(), barsClipArgs(path.join(fixturesDir, barsFile)));
  const patches = await analyzeBars(path.join(fixturesDir, barsFile));
  const patchesFile = "bars-expected.json";
  await writeFile(
    path.join(fixturesDir, patchesFile),
    JSON.stringify({ width: WIDTH, height: HEIGHT, patches }, null, 2),
    "utf8",
  );

  const shuttleAudioFile = "shuttle-audio.mp4";
  log(`[qa] fixtures: synthesizing ${shuttleAudioFile}`);
  await runProcess(
    ffmpegBin(),
    shuttleAudioClipArgs(path.join(fixturesDir, shuttleAudioFile)),
  );

  const manifest: FixtureManifest = {
    version: CORPUS_VERSION,
    generatedAt: new Date().toISOString(),
    fontFile,
    rateClips,
    dropFrame: { file: dfFile, timecode: DF_START_TIMECODE, rate: DF_RATE },
    shuttleAudio: {
      file: shuttleAudioFile,
      durationSeconds: SHUTTLE_AUDIO_SECONDS,
    },
    bars: {
      file: barsFile,
      width: WIDTH,
      height: HEIGHT,
      patchesFile,
      patches,
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  log(`[qa] fixtures: corpus ready in ${fixturesDir}`);
  return manifest;
};

export const readManifest = async (): Promise<FixtureManifest> =>
  JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;

/* HDR fixtures for the tonemap suite (qa/src/hdr-tonemap.spec.ts). These
   live outside the main manifest on purpose: they are synthesized lazily by
   the suite that needs them, so an ffmpeg build that cannot produce 10-bit
   H.264 breaks only the HDR spec, never the whole corpus.

   The clips are a uniform 25 percent grey tagged as PQ (smpte2084) and HLG
   (arib-std-b67) over bt2020 in 10-bit. Tag-only synthesis (no zscale
   dependency): the product's HDR routing keys off the transfer tag
   (isHdrSource), and a known flat input makes the tonemapped center-pixel
   luma assertable without modeling the exact transfer math. */

export type HdrTransfer = "smpte2084" | "arib-std-b67";

export interface HdrClipFixture {
  id: string;
  file: string;
  transfer: HdrTransfer;
  rate: QaRate;
}

const HDR_RATE: QaRate = { num: 25, den: 1 };
const HDR_SECONDS = 2;

export const HDR_CLIPS: ReadonlyArray<{ id: string; transfer: HdrTransfer }> = [
  { id: "hdr-pq", transfer: "smpte2084" },
  { id: "hdr-hlg", transfer: "arib-std-b67" },
];

export const hdrClipArgs = (
  transfer: HdrTransfer,
  outputPath: string,
): string[] => [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `color=c=0x404040:s=640x360:r=${HDR_RATE.num}/${HDR_RATE.den}:d=${HDR_SECONDS}`,
  "-vf",
  "format=yuv420p10le",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p10le",
  "-g",
  String(HDR_RATE.num),
  "-keyint_min",
  String(HDR_RATE.num),
  "-sc_threshold",
  "0",
  "-color_primaries",
  "bt2020",
  "-color_trc",
  transfer,
  "-colorspace",
  "bt2020nc",
  "-color_range",
  "tv",
  "-movflags",
  "+faststart",
  outputPath,
];

export const synthesizeHdrFixtures = async (
  log: (line: string) => void = console.log,
): Promise<HdrClipFixture[]> => {
  await mkdir(fixturesDir, { recursive: true });
  const fixtures: HdrClipFixture[] = [];
  for (const clip of HDR_CLIPS) {
    const file = `${clip.id}.mp4`;
    const outputPath = path.join(fixturesDir, file);
    if (!existsSync(outputPath)) {
      log(`[qa] fixtures: synthesizing ${file} (${clip.transfer})`);
      await runProcess(ffmpegBin(), hdrClipArgs(clip.transfer, outputPath));
    }
    const probe = await probeFile(outputPath);
    if (!isHdrSource(probe))
      throw new Error(
        `HDR fixture ${file} does not probe as HDR; the product's transfer routing would never see it.`,
      );
    fixtures.push({
      id: clip.id,
      file,
      transfer: clip.transfer,
      rate: HDR_RATE,
    });
  }
  return fixtures;
};
