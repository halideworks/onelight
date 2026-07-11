import { spawn } from "node:child_process";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaInfo, TranscodeJob, TranscodeResult } from "@onelight/core";

export interface ProbeDocument {
  format?: Record<string, unknown>;
  streams?: Array<Record<string, unknown>>;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface NormalizedMediaInfo extends MediaInfo {
  dropFrame?: boolean;
  frameRateClamped?: boolean;
  probedFrameRate?: string;
}

export interface PlannedRendition {
  kind: string;
  filename: string;
  height?: number;
}

export interface TranscodeRunResult extends TranscodeResult {
  failures: Array<{ kind: string; error: string }>;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const parseRational = (
  value: unknown,
): { num: number; den: number } | undefined => {
  if (typeof value !== "string") return undefined;
  const [rawNum, rawDen] = value.split("/");
  const num = Number(rawNum);
  const den = Number(rawDen ?? 1);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0)
    return undefined;
  return { num, den };
};

export const SUPPORTED_MEDIA_RATES: ReadonlyArray<{
  num: number;
  den: number;
}> = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];

export const clampToSupportedRate = (rate: {
  num: number;
  den: number;
}): { rate: { num: number; den: number }; exact: boolean } => {
  const exact = SUPPORTED_MEDIA_RATES.find(
    (candidate) => candidate.num * rate.den === rate.num * candidate.den,
  );
  if (exact) return { rate: exact, exact: true };
  const fps = rate.num / rate.den;
  let best = SUPPORTED_MEDIA_RATES[0] as { num: number; den: number };
  for (const candidate of SUPPORTED_MEDIA_RATES)
    if (
      Math.abs(candidate.num / candidate.den - fps) <
      Math.abs(best.num / best.den - fps)
    )
      best = candidate;
  return { rate: best, exact: false };
};

// The spec mandates avg_frame_rate; r_frame_rate is only a fallback.
const probedFrameRate = (
  stream: Record<string, unknown>,
): { num: number; den: number } | undefined =>
  parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate);

// r_frame_rate vs avg_frame_rate rounding differences (24000/1001 vs 24)
// are not VFR. Only a material mismatch (over 1.5 percent) flags VFR.
// Running the vfrdet filter during probe is a future improvement.
const materiallyDifferentRates = (
  left: { num: number; den: number },
  right: { num: number; den: number },
): boolean => {
  const a = left.num / left.den;
  const b = right.num / right.den;
  return Math.max(a, b) / Math.min(a, b) > 1.015;
};

const frameCount = (
  stream: Record<string, unknown>,
  format: Record<string, unknown>,
  rate: { num: number; den: number } | undefined,
): number | undefined => {
  const direct = Number(stream.nb_frames);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const duration = Number(stream.duration ?? format.duration);
  if (Number.isFinite(duration) && duration > 0 && rate)
    return Math.round((duration * rate.num) / rate.den);
  return undefined;
};

const findTimecode = (document: ProbeDocument): string | undefined => {
  const formatTags = document.format?.tags as
    Record<string, unknown> | undefined;
  const streamTags =
    document.streams?.flatMap((stream) => {
      const tags = stream.tags as Record<string, unknown> | undefined;
      return tags ? [tags] : [];
    }) ?? [];
  const candidates = [
    formatTags?.timecode,
    ...streamTags.map((tags) => tags.timecode),
  ];
  return candidates.map(asString).find((value) => value !== undefined);
};

export const normalizeProbe = (
  document: ProbeDocument,
): NormalizedMediaInfo => {
  const format = document.format ?? {};
  const streams = document.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const rRate = video ? parseRational(video.r_frame_rate) : undefined;
  const avgRate = video ? parseRational(video.avg_frame_rate) : undefined;
  const probed = video ? probedFrameRate(video) : undefined;
  const variableFrameRate = Boolean(
    rRate && avgRate && materiallyDifferentRates(rRate, avgRate),
  );
  const colors = video
    ? [
        video.color_primaries,
        video.color_transfer,
        video.color_space ?? video.colorspace,
        video.color_range,
      ]
    : [];
  const colorAssumed = colors.every(
    (value) => value === undefined || value === "unknown",
  );
  const normalized: NormalizedMediaInfo = {
    format,
    streams,
    variableFrameRate,
    colorAssumed,
  };
  const timecode = findTimecode(document);
  if (timecode !== undefined) {
    normalized.sourceTimecodeStart = timecode;
    normalized.dropFrame = timecode.includes(";");
  }
  if (probed) {
    const clamped = clampToSupportedRate(probed);
    normalized.frameRateNum = clamped.rate.num;
    normalized.frameRateDen = clamped.rate.den;
    if (!clamped.exact) {
      normalized.frameRateClamped = true;
      normalized.probedFrameRate = `${probed.num}/${probed.den}`;
    }
  }
  const rate =
    normalized.frameRateNum && normalized.frameRateDen
      ? { num: normalized.frameRateNum, den: normalized.frameRateDen }
      : undefined;
  const duration = video ? frameCount(video, format, rate) : undefined;
  if (duration !== undefined) normalized.durationFrames = duration;
  return normalized;
};

// The complete ffprobe JSON is stored verbatim; no tag whitelist.
export const probeArgs = (source: string): string[] => [
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_format",
  "-show_streams",
  source,
];

export const runProcess = (
  command: string,
  args: string[],
  cwd?: string,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else
        reject(
          new Error(
            `${command} exited with ${code}: ${result.stderr.slice(-4000)}`,
          ),
        );
    });
  });

export const probeFile = async (
  source: string,
  ffprobe = process.env.FFPROBE_PATH ?? "ffprobe",
): Promise<NormalizedMediaInfo> => {
  const result = await runProcess(ffprobe, probeArgs(source));
  return normalizeProbe(JSON.parse(result.stdout) as ProbeDocument);
};

const videoStream = (
  mediaInfo: MediaInfo,
): Record<string, unknown> | undefined =>
  mediaInfo.streams.find((stream) => stream.codec_type === "video");

const sourceTransfer = (mediaInfo: MediaInfo): string | undefined =>
  asString(videoStream(mediaInfo)?.color_transfer) ??
  asString(mediaInfo.format["color_transfer"]);

export const isHdrSource = (mediaInfo: MediaInfo): boolean => {
  const transfer = sourceTransfer(mediaInfo);
  return transfer === "smpte2084" || transfer === "arib-std-b67";
};

// libplacebo handles the HLG inverse OOTF internally when converting to an
// SDR BT.709 target; no explicit inverse_ootf option exists.
export const HDR_TONEMAP_FILTER =
  "libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p";

export const BT709_CONVERT_FILTER =
  "zscale=matrix=709:primaries=709:transfer=709";

const bt709ish = (value: string | undefined): boolean =>
  value === undefined || value === "unknown" || value === "bt709";

export const needsBt709Conversion = (mediaInfo: MediaInfo): boolean => {
  if (isHdrSource(mediaInfo)) return false;
  const video = videoStream(mediaInfo);
  if (!video) return false;
  return !(
    bt709ish(asString(video.color_space ?? video.colorspace)) &&
    bt709ish(asString(video.color_primaries)) &&
    bt709ish(asString(video.color_transfer))
  );
};

// "" when the source is already BT.709; otherwise a filter prefix that
// converts to BT.709 (tonemap for HDR, zscale for SDR 601 and friends).
const colorPrefix = (mediaInfo: MediaInfo): string =>
  isHdrSource(mediaInfo)
    ? `${HDR_TONEMAP_FILTER},`
    : needsBt709Conversion(mediaInfo)
      ? `${BT709_CONVERT_FILTER},`
      : "";

const fpsFilter = (mediaInfo: MediaInfo): string =>
  mediaInfo.frameRateNum && mediaInfo.frameRateDen
    ? `fps=${mediaInfo.frameRateNum}/${mediaInfo.frameRateDen}`
    : "fps=24000/1001";
const gopSize = (mediaInfo: MediaInfo): number =>
  mediaInfo.frameRateNum && mediaInfo.frameRateDen
    ? Math.max(1, Math.round(mediaInfo.frameRateNum / mediaInfo.frameRateDen))
    : 24;

const durationSeconds = (mediaInfo: MediaInfo): number =>
  mediaInfo.durationFrames && mediaInfo.frameRateNum && mediaInfo.frameRateDen
    ? (mediaInfo.durationFrames * mediaInfo.frameRateDen) /
      mediaInfo.frameRateNum
    : 0;

// One 10x10 sprite sheet covers the whole duration: at most 100 tiles, so
// the tile interval grows with duration and is never below 2 seconds.
export const spriteInterval = (mediaInfo: MediaInfo): number =>
  Math.max(2, Math.ceil(durationSeconds(mediaInfo) / 100));

export const SPRITE_TILE_WIDTH = 160;
export const SPRITE_TILE_HEIGHT = 90;

export const sidecarArgs = (
  job: TranscodeJob,
  outputPath: string,
  kind: string,
): string[] | undefined => {
  if (kind === "poster")
    return [
      "-hide_banner",
      "-y",
      "-ss",
      "0",
      "-i",
      job.sourceKey,
      "-frames:v",
      "1",
      "-vf",
      `${colorPrefix(job.mediaInfo)}scale=640:-2:force_original_aspect_ratio=decrease`,
      "-q:v",
      "2",
      outputPath,
    ];
  if (kind === "sprite") {
    const interval = spriteInterval(job.mediaInfo);
    const tile = `scale=${SPRITE_TILE_WIDTH}:${SPRITE_TILE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SPRITE_TILE_WIDTH}:${SPRITE_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2`;
    return [
      "-hide_banner",
      "-y",
      "-i",
      job.sourceKey,
      "-vf",
      `${colorPrefix(job.mediaInfo)}fps=1/${interval},${tile},tile=10x10`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      outputPath,
    ];
  }
  if (kind === "audio_peaks")
    return [
      "-hide_banner",
      "-y",
      "-i",
      job.sourceKey,
      "-filter_complex",
      "[0:a]showwavespic=s=1600x180:colors=#f7e1a0[waves]",
      "-map",
      "[waves]",
      "-frames:v",
      "1",
      outputPath,
    ];
  if (kind === "still_tiles")
    return [
      "-hide_banner",
      "-y",
      "-i",
      job.sourceKey,
      "-frames:v",
      "1",
      "-vf",
      "scale=w='min(iw,4096)':h=-2",
      "-q:v",
      "2",
      outputPath,
    ];
  return undefined;
};

export const buildPdfPagesArgs = (
  source: string,
  outputPrefix: string,
): string[] => ["-png", "-r", "150", source, outputPrefix];

// Frame-exact still extraction from a proxy. The accurate-seek form is used:
// -ss placed AFTER -i decodes from the first packet and discards frames until
// the target, so the emitted frame is exact even when the target sits between
// keyframes. Input seeking (-ss before -i) jumps to the nearest keyframe and
// then still needs a select=eq(n\,k) refinement whose frame counter resets at
// the seek point, which makes k wrong unless the keyframe interval is known.
// The proxies carry a 1 second GOP, so the accurate form costs at most one
// linear decode up to the requested frame and can never return the wrong
// frame. The seek target is half a frame BEFORE frame k: the first decoded
// frame with pts >= target is then exactly frame k, and the 3-decimal
// formatting (max 0.5 ms error) stays far inside the half-frame guard band
// (8.3 ms at 60 fps).
export const buildStillArgs = (
  source: string,
  outputPath: string,
  frame: number,
  rate: { num: number; den: number },
): string[] => {
  const seconds = (Math.max(0, frame - 0.5) * rate.den) / rate.num;
  return [
    "-hide_banner",
    "-y",
    "-i",
    source,
    "-ss",
    seconds.toFixed(3),
    "-frames:v",
    "1",
    outputPath,
  ];
};

export interface WatermarkSpec {
  text?: string;
  position?: "tl" | "tr" | "bl" | "br" | "center" | "tile";
  opacity?: number;
  size?: number;
  box?: boolean;
}

export interface WatermarkTokens {
  email?: string;
  name?: string;
  share?: string;
  date?: string;
}

// The worker image installs fonts-dejavu-core, so this path always exists in
// production. Callers may override for local runs.
export const DEFAULT_WATERMARK_FONTFILE =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

// Token substitution happens in TypeScript, never via drawtext expansion, so
// the filter can run with expansion=none and no ffmpeg-side interpolation.
export const renderWatermarkText = (
  template: string,
  tokens: WatermarkTokens,
): string =>
  template
    .replaceAll("{email}", tokens.email ?? "")
    .replaceAll("{name}", tokens.name ?? "")
    .replaceAll("{share}", tokens.share ?? "")
    .replaceAll("{date}", tokens.date ?? "");

// drawtext values cross two parsers: the filtergraph option parser (single
// quotes group, backslash escapes, ":" ends the option, "," ends the filter)
// and drawtext's own expansion pass ("%" and "\" sequences). expansion=none
// disables the second pass entirely, so the only remaining metacharacter
// inside a quoted filtergraph value is the single quote itself, which cannot
// be backslash-escaped inside a quote group: the group is closed, an escaped
// quote is emitted, and a new group opens ("'" becomes "'\''"). Colons,
// backslashes, percent signs, commas, and newlines ride inside the quotes
// verbatim.
export const escapeDrawtextValue = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const watermarkAlpha = (spec: WatermarkSpec): string => {
  const opacity = typeof spec.opacity === "number" ? spec.opacity : 0.4;
  return String(Math.min(1, Math.max(0.05, opacity)));
};

// The burned watermark path always re-encodes the 1080p proxy, so the font
// size is computed against the known 1080 line height rather than an ffmpeg
// expression (fontsize expression support varies across ffmpeg versions).
const watermarkFontSize = (spec: WatermarkSpec): number => {
  const fraction = typeof spec.size === "number" ? spec.size : 0.03;
  return Math.max(
    10,
    Math.round(1080 * Math.min(0.2, Math.max(0.01, fraction))),
  );
};

const WATERMARK_MARGIN = "h*0.02";

const watermarkPositions = (
  position: WatermarkSpec["position"],
): Array<{
  x: string;
  y: string;
}> => {
  const m = WATERMARK_MARGIN;
  if (position === "tl") return [{ x: m, y: m }];
  if (position === "tr") return [{ x: `w-text_w-${m}`, y: m }];
  if (position === "bl") return [{ x: m, y: `h-text_h-${m}` }];
  if (position === "center") return [{ x: "(w-text_w)/2", y: "(h-text_h)/2" }];
  // tile is approximated with three placements on the frame diagonal (top
  // left third, center, bottom right third). A true repeating tile would need
  // one drawtext per cell or a pre-rendered overlay grid; three diagonal
  // placements cover the crop-one-corner attack at a fraction of the filter
  // cost and are the documented v1 behavior.
  if (position === "tile")
    return [
      { x: "(w-text_w)*0.15", y: "(h-text_h)*0.15" },
      { x: "(w-text_w)/2", y: "(h-text_h)/2" },
      { x: "(w-text_w)*0.85", y: "(h-text_h)*0.85" },
    ];
  return [{ x: `w-text_w-${m}`, y: `h-text_h-${m}` }];
};

export const buildWatermarkFilter = (
  spec: WatermarkSpec,
  tokens: WatermarkTokens,
  fontfile = DEFAULT_WATERMARK_FONTFILE,
): string => {
  // Spec values arrive from user-controlled JSON (the API validates only a
  // record shape), so every field is type-checked before use.
  const text = renderWatermarkText(
    typeof spec.text === "string" && spec.text.length
      ? spec.text
      : "{share} {date}",
    tokens,
  );
  const alpha = watermarkAlpha(spec);
  const fontSize = watermarkFontSize(spec);
  const box = spec.box
    ? `:box=1:boxcolor=black@0.35:boxborderw=${Math.max(2, Math.round(fontSize / 3))}`
    : "";
  const common =
    `fontfile=${escapeDrawtextValue(fontfile)}` +
    `:text=${escapeDrawtextValue(text)}` +
    `:expansion=none:fontsize=${fontSize}:fontcolor=white@${alpha}${box}`;
  return watermarkPositions(spec.position)
    .map((at) => `drawtext=${common}:x=${at.x}:y=${at.y}`)
    .join(",");
};

// Re-encode of the 1080p proxy with the burned watermark. The proxy is
// already BT.709 yuv420p with AAC audio, so audio is stream-copied and the
// colorimetry tags are re-asserted rather than converted.
export const buildWatermarkArgs = (
  source: string,
  outputPath: string,
  spec: WatermarkSpec,
  tokens: WatermarkTokens,
  rate?: { num: number; den: number },
  fontfile = DEFAULT_WATERMARK_FONTFILE,
): string[] => {
  const gop = rate ? Math.max(1, Math.round(rate.num / rate.den)) : 24;
  return [
    "-hide_banner",
    "-y",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `${buildWatermarkFilter(spec, tokens, fontfile)},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
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
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "0",
    outputPath,
  ];
};

const vttTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds - hours * 3600 - minutes * 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
};

export const writeSpriteVtt = async (
  job: TranscodeJob,
  outputPath: string,
): Promise<string> => {
  const duration = durationSeconds(job.mediaInfo);
  const interval = spriteInterval(job.mediaInfo);
  const count = Math.min(100, Math.max(1, Math.ceil(duration / interval)));
  const rows = ["WEBVTT", ""];
  for (let index = 0; index < count; index += 1) {
    const start = index * interval;
    const end = Math.min(duration || start + interval, start + interval);
    rows.push(
      `${index + 1}`,
      `${vttTime(start)} --> ${vttTime(end)}`,
      `${path.basename(outputPath)}#xywh=${(index % 10) * SPRITE_TILE_WIDTH},${Math.floor(index / 10) * SPRITE_TILE_HEIGHT},${SPRITE_TILE_WIDTH},${SPRITE_TILE_HEIGHT}`,
      "",
    );
  }
  const vttPath = path.join(path.dirname(outputPath), "sprite.vtt");
  await writeFile(vttPath, rows.join("\n"), "utf8");
  return vttPath;
};

export const buildSdrProxyArgs = (
  job: TranscodeJob,
  outputPath: string,
  height: number,
): string[] => {
  // Ladder numbers are heights; -2 keeps the derived width even.
  const scale =
    height > 0 ? `scale=-2:${height}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const filters = `${colorPrefix(job.mediaInfo)}${scale},${fpsFilter(job.mediaInfo)},format=yuv420p`;
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    job.sourceKey,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    filters,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    height >= 2160 ? "19" : height <= 540 ? "21" : "18",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gopSize(job.mediaInfo)),
    "-keyint_min",
    String(gopSize(job.mediaInfo)),
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
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "0",
  ];
  if (job.mediaInfo.sourceTimecodeStart)
    args.push(
      "-timecode",
      job.mediaInfo.sourceTimecodeStart,
      "-write_tmcd",
      "on",
    );
  args.push(outputPath);
  return args;
};

export const buildHdrAv1Args = (
  job: TranscodeJob,
  outputPath: string,
): string[] => {
  const video = videoStream(job.mediaInfo);
  const gop = gopSize(job.mediaInfo);
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    job.sourceKey,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `${fpsFilter(job.mediaInfo)},format=yuv420p10le`,
    "-c:v",
    "libsvtav1",
    "-preset",
    "6",
    "-crf",
    "28",
    "-g",
    String(gop),
    "-svtav1-params",
    `keyint=${gop}`,
    "-pix_fmt",
    "yuv420p10le",
    "-color_primaries",
    asString(video?.color_primaries) ?? "bt2020",
    "-color_trc",
    asString(video?.color_transfer) ?? "smpte2084",
    "-colorspace",
    asString(video?.color_space ?? video?.colorspace) ?? "bt2020nc",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "0",
  ];
  if (job.mediaInfo.sourceTimecodeStart)
    args.push(
      "-timecode",
      job.mediaInfo.sourceTimecodeStart,
      "-write_tmcd",
      "on",
    );
  args.push(outputPath);
  return args;
};

export const buildHdrHevcArgs = (
  job: TranscodeJob,
  outputPath: string,
): string[] => {
  const video = videoStream(job.mediaInfo);
  const gop = gopSize(job.mediaInfo);
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    job.sourceKey,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `${fpsFilter(job.mediaInfo)},format=yuv420p10le`,
    "-c:v",
    "libx265",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-g",
    String(gop),
    "-x265-params",
    `keyint=${gop}:min-keyint=${gop}:scenecut=0`,
    "-pix_fmt",
    "yuv420p10le",
    "-tag:v",
    "hvc1",
    "-color_primaries",
    asString(video?.color_primaries) ?? "bt2020",
    "-color_trc",
    asString(video?.color_transfer) ?? "smpte2084",
    "-colorspace",
    asString(video?.color_space ?? video?.colorspace) ?? "bt2020nc",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "0",
  ];
  if (job.mediaInfo.sourceTimecodeStart)
    args.push(
      "-timecode",
      job.mediaInfo.sourceTimecodeStart,
      "-write_tmcd",
      "on",
    );
  args.push(outputPath);
  return args;
};

export const buildOutputArgs = (
  job: TranscodeJob,
  outputPath: string,
  kind: string,
  height = 1080,
): string[] =>
  kind === "hdr_av1"
    ? buildHdrAv1Args(job, outputPath)
    : kind === "hdr_hevc"
      ? buildHdrHevcArgs(job, outputPath)
      : buildSdrProxyArgs(job, outputPath, height);

// Rendition plan per asset kind. Primary readiness is per kind: video needs
// proxy_1080, audio needs audio_peaks, image needs still_tiles or poster,
// pdf needs pdf_pages.
export const primaryRenditionKinds = (assetKind: string): string[] =>
  assetKind === "audio"
    ? ["audio_peaks"]
    : assetKind === "image"
      ? ["still_tiles", "poster"]
      : assetKind === "pdf"
        ? ["pdf_pages"]
        : ["proxy_1080"];

export const planRenditions = (
  assetKind: string,
  mediaInfo: MediaInfo,
): PlannedRendition[] => {
  if (assetKind === "audio")
    return [{ kind: "audio_peaks", filename: "audio_peaks.png" }];
  if (assetKind === "image")
    return [
      { kind: "still_tiles", filename: "still_tiles.png" },
      { kind: "poster", filename: "poster.png" },
    ];
  if (assetKind === "pdf")
    return [{ kind: "pdf_pages", filename: "pages/page" }];
  if (assetKind !== "video") return [];
  const video = videoStream(mediaInfo);
  const audio = mediaInfo.streams.find(
    (stream) => stream.codec_type === "audio",
  );
  const sourceWidth = Number(video?.width ?? 1920);
  const ladder =
    sourceWidth >= 3840
      ? [
          { kind: "proxy_2160", height: 2160 },
          { kind: "proxy_1080", height: 1080 },
          { kind: "proxy_540", height: 540 },
        ]
      : [
          { kind: "proxy_1080", height: 1080 },
          { kind: "proxy_540", height: 540 },
        ];
  const planned: PlannedRendition[] = ladder.map((rung) => ({
    ...rung,
    filename: `${rung.kind}.mp4`,
  }));
  if (isHdrSource(mediaInfo))
    planned.push(
      { kind: "hdr_av1", filename: "hdr_av1.mp4" },
      { kind: "hdr_hevc", filename: "hdr_hevc.mp4" },
    );
  planned.push(
    { kind: "poster", filename: "poster.png" },
    { kind: "sprite", filename: "sprite.png" },
  );
  if (audio) planned.push({ kind: "audio_peaks", filename: "audio_peaks.png" });
  return planned;
};

const fileReady = async (file: string): Promise<boolean> => {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

const listPdfPages = async (directory: string): Promise<string[]> => {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort(
      (a, b) =>
        Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0),
    );
};

export const runTranscode = async (
  job: TranscodeJob,
  outputPaths: Array<{ kind: string; path: string; height?: number }>,
  ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg",
  pdftoppm = process.env.PDFTOPPM_PATH ?? "pdftoppm",
): Promise<TranscodeRunResult> => {
  const renditions: TranscodeRunResult["renditions"] = [];
  const failures: TranscodeRunResult["failures"] = [];
  for (const output of outputPaths) {
    try {
      await mkdir(path.dirname(output.path), { recursive: true });
      if (output.kind === "pdf_pages") {
        const directory = path.dirname(output.path);
        if (!(await listPdfPages(directory)).length)
          await runProcess(
            pdftoppm,
            buildPdfPagesArgs(job.sourceKey, output.path),
          );
        const pages = await listPdfPages(directory);
        if (!pages.length) throw new Error("pdftoppm produced no pages.");
        renditions.push({
          kind: output.kind,
          key: path.join(directory, pages[0] as string),
          meta: { page_count: pages.length, pages },
        });
        continue;
      }
      // A finished output from an earlier attempt is reused, so retries do
      // not re-encode. Encodes land in a temp name and rename on success,
      // so a crash never leaves a truncated file at the final path.
      if (!(await fileReady(output.path))) {
        const tempPath = path.join(
          path.dirname(output.path),
          `.tmp-${path.basename(output.path)}`,
        );
        const args =
          sidecarArgs(job, tempPath, output.kind) ??
          buildOutputArgs(job, tempPath, output.kind, output.height ?? 1080);
        await runProcess(ffmpeg, args);
        await rename(tempPath, output.path);
      }
      const meta: Record<string, unknown> = {
        frame_rate_num: job.mediaInfo.frameRateNum,
        frame_rate_den: job.mediaInfo.frameRateDen,
      };
      if (output.height !== undefined) meta.height = output.height;
      if (output.kind === "sprite")
        meta.vtt_path = await writeSpriteVtt(job, output.path);
      renditions.push({ kind: output.kind, key: output.path, meta });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Rendition failed.";
      // Never swallow a rendition failure silently; the caller decides
      // whether the failed kind was primary for the asset.
      console.warn(
        `[onelight-worker] rendition ${output.kind} failed for job ${job.id}: ${message}`,
      );
      failures.push({ kind: output.kind, error: message });
    }
  }
  return { renditions, failures };
};

// Shared single-output convention: an existing finished file is reused, the
// encode lands in a temp name in the same directory, and the rename happens
// only on success, so a crash never leaves a truncated file at the final
// path. The temp prefix keeps the extension so ffmpeg still infers the muxer.
const runFfmpegToFile = async (
  argsFor: (tempPath: string) => string[],
  outputPath: string,
  ffmpeg: string,
): Promise<void> => {
  await mkdir(path.dirname(outputPath), { recursive: true });
  if (await fileReady(outputPath)) return;
  const tempPath = path.join(
    path.dirname(outputPath),
    `.tmp-${path.basename(outputPath)}`,
  );
  await runProcess(ffmpeg, argsFor(tempPath));
  await rename(tempPath, outputPath);
};

export const extractStill = (
  source: string,
  outputPath: string,
  frame: number,
  rate: { num: number; den: number },
  ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg",
): Promise<void> =>
  runFfmpegToFile(
    (tempPath) => buildStillArgs(source, tempPath, frame, rate),
    outputPath,
    ffmpeg,
  );

export const renderWatermark = (
  source: string,
  outputPath: string,
  spec: WatermarkSpec,
  tokens: WatermarkTokens,
  rate?: { num: number; den: number },
  ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg",
  fontfile = DEFAULT_WATERMARK_FONTFILE,
): Promise<void> =>
  runFfmpegToFile(
    (tempPath) =>
      buildWatermarkArgs(source, tempPath, spec, tokens, rate, fontfile),
    outputPath,
    ffmpeg,
  );
