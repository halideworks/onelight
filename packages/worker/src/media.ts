import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodePeaks } from "@onelight/core";
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
  nominalRate?: boolean;
}

/* Sound has no frames, and every position in this system is an integer frame
   plus a rational rate: a note on a mix has to land somewhere countable. Audio
   versions are therefore given a nominal timebase, and 60 is the finest rate
   the timecode code supports with an exact integer denominator -- 16.67 ms
   per frame, which is close enough to a fader move that nobody argues about
   which word the note was on. The flag rides along so the UI can say the
   timecode is nominal rather than pretending the file carried one. */
export const NOMINAL_AUDIO_RATE = { num: 60, den: 1 };

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

// Drop-frame timecode exists only for the 29.97 (30000/1001) and 59.94
// (60000/1001) NTSC rates; a ";" on any other rate is a mistag.
const isNtscDropRate = (num?: number, den?: number): boolean =>
  den === 1001 && (num === 30000 || num === 60000);

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
  if (probed) {
    const clamped = clampToSupportedRate(probed);
    normalized.frameRateNum = clamped.rate.num;
    normalized.frameRateDen = clamped.rate.den;
    if (!clamped.exact) {
      normalized.frameRateClamped = true;
      normalized.probedFrameRate = `${probed.num}/${probed.den}`;
    }
  }
  const timecode = findTimecode(document);
  if (timecode !== undefined) {
    normalized.sourceTimecodeStart = timecode;
    // Drop-frame timecode is defined only for the 29.97 and 59.94 NTSC rates.
    // A ";" separator on any other (commonly mistagged 24/25/30) source is not
    // drop-frame; honoring it would corrupt frame math and break exports, so
    // dropFrame is gated on the clamped rate as well as the separator.
    normalized.dropFrame =
      timecode.includes(";") &&
      isNtscDropRate(normalized.frameRateNum, normalized.frameRateDen);
  }
  const rate =
    normalized.frameRateNum && normalized.frameRateDen
      ? { num: normalized.frameRateNum, den: normalized.frameRateDen }
      : undefined;
  const duration = video ? frameCount(video, format, rate) : undefined;
  if (duration !== undefined) normalized.durationFrames = duration;
  if (
    !video &&
    streams.some((stream) => stream.codec_type === "audio") &&
    normalized.frameRateNum === undefined
  ) {
    normalized.frameRateNum = NOMINAL_AUDIO_RATE.num;
    normalized.frameRateDen = NOMINAL_AUDIO_RATE.den;
    normalized.nominalRate = true;
    const seconds = Number(format["duration"]);
    if (Number.isFinite(seconds) && seconds > 0)
      normalized.durationFrames = Math.max(
        1,
        Math.round((seconds * NOMINAL_AUDIO_RATE.num) / NOMINAL_AUDIO_RATE.den),
      );
  }
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

/* An ffmpeg/ffprobe with no output for this long is treated as hung and
   killed. ffmpeg prints progress to stderr continuously while it works and a
   probe finishes in well under this, so only a genuinely stuck process (filter
   deadlock, unterminated probe) goes silent long enough to trip it. Without
   it, a hung child pins its job 'processing' forever, the pump's 6h deadline
   requeues it into a worker that still reports 409, and each of the retries
   burns another 6h against the same wedged process while it pegs a core. */
const PROCESS_IDLE_TIMEOUT_MS = 5 * 60_000;

export const runProcess = (
  command: string,
  args: string[],
  cwd?: string,
  idleTimeoutMs = PROCESS_IDLE_TIMEOUT_MS,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let idle: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, idleTimeoutMs);
    };
    const settle = (): void => clearTimeout(idle);
    arm();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      arm();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      arm();
    });
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      if (timedOut) {
        reject(
          new Error(
            `${command} was killed after ${String(
              Math.round(idleTimeoutMs / 1000),
            )}s without output (treated as hung).`,
          ),
        );
        return;
      }
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

// vf_libplacebo needs an explicit Vulkan device on the ffmpeg builds we ship:
// bookworm's 5.1 and even 6.0 abort the tonemap with "Missing vulkan
// hwdevice" unless a device is created and selected (automatic creation only
// landed in ffmpeg 6.1). mesa-vulkan-drivers in the worker image provides
// lavapipe, a software Vulkan implementation, as device 0. These are global
// options and must precede the input, so every builder that emits the
// libplacebo tonemap prepends them right after -hide_banner -y.
export const VULKAN_HWDEVICE_ARGS: ReadonlyArray<string> = [
  "-init_hw_device",
  "vulkan=vk:0",
  "-filter_hw_device",
  "vk",
];

// Only HDR sources route through libplacebo, so the Vulkan device is created
// only then: a plain SDR encode must not pay for (or fail on) device init.
const tonemapHwDeviceArgs = (mediaInfo: MediaInfo): string[] =>
  isHdrSource(mediaInfo) ? [...VULKAN_HWDEVICE_ARGS] : [];

// Intel QuickSync (VAAPI) hardware H.264 encode. Opt-in per host through
// ONELIGHT_VAAPI_DEVICE (a render node such as /dev/dri/renderD128) rather than
// autodetected, because the node only exists where the container was actually
// handed the GPU: an unset variable must degrade to software rather than fail
// the job. Unset is the portable default and the path CI exercises.
export const VAAPI_DEVICE_ENV = "ONELIGHT_VAAPI_DEVICE";

// An HDR source tonemaps through libplacebo, which requires -filter_hw_device
// vk. hwupload targets that same filter device, so it would hand Vulkan frames
// to h264_vaapi and abort. The Vulkan device shipped here is lavapipe, a
// software implementation that cannot share surfaces with the GPU's VAAPI, so
// there is no cheap hwmap interop either. HDR therefore stays on the software
// encoder, which is also where its libplacebo tonemap already spends its time.
export const canUseVaapi = (
  mediaInfo: MediaInfo,
  device: string | undefined,
): boolean => Boolean(device) && !isHdrSource(mediaInfo);

// Uploading to the GPU replaces the software pixel-format stage: nv12 is what
// the Intel encoder consumes.
const VAAPI_UPLOAD_FILTER = "format=nv12,hwupload";

// Decode on the GPU too. H.264 decode is normative, so this is bit-exact:
// verified on an N150 by encoding the same source both ways -- identical md5
// of the file AND of every decoded frame. It is pure savings, and it is the
// larger half of them, because software decode of a high-bitrate source costs
// more CPU than the encode ever did. Without -hwaccel_output_format the frames
// are downloaded to system memory, so every existing software filter (swscale,
// zscale, libplacebo) still sees exactly what it saw before: no resampler
// changes, no colour changes.
const vaapiDecodeArgs = (device: string): string[] => [
  "-hwaccel",
  "vaapi",
  "-hwaccel_device",
  device,
];

// -vaapi_device is shorthand for -init_hw_device vaapi=va:<node> plus
// -filter_hw_device va, which is what points hwupload at the GPU. It is a
// global option, so like the Vulkan args it must precede the input.
const vaapiHwDeviceArgs = (device: string): string[] => [
  ...vaapiDecodeArgs(device),
  "-vaapi_device",
  device,
];

// The Alder Lake-N family (the N150 here) exposes only VAEntrypointEncSliceLP,
// so the low-power encoder is the only one that exists; ffmpeg falls back to it
// unprompted today, but saying so keeps the failure legible on parts that
// expose both entrypoints. CQP is the rate control the LP entrypoint supports:
// it has no CRF, so the software ladder's CRF is reused as the QP, trading a
// little file size for the same perceptual target. libx264's -preset and
// -sc_threshold have no VAAPI equivalent and are omitted rather than passed and
// ignored, and -pix_fmt is dropped because the frames are VAAPI surfaces by
// then, not software yuv420p.
const vaapiVideoArgs = (quality: string): string[] => [
  "-c:v",
  "h264_vaapi",
  "-low_power",
  "1",
  "-rc_mode",
  "CQP",
  "-qp",
  quality,
];

const softwareVideoArgs = (quality: string): string[] => [
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  quality,
  "-pix_fmt",
  "yuv420p",
];

// Output half of the SDR BT.709 conversion; the input half is derived per
// source below so zscale always sees a complete input colorspec.
const BT709_OUTPUT_PARAMS = "matrix=709:primaries=709:transfer=709";

const bt709ish = (value: string | undefined): boolean =>
  value === undefined || value === "unknown" || value === "bt709";

// A component the probe left blank (undefined or the literal "unknown") falls
// back to its SD BT.601 default; a tagged component passes through. ffprobe
// and zscale share these enum spellings.
const knownColorOr = (value: string | undefined, fallback: string): string =>
  value !== undefined && value !== "unknown" ? value : fallback;

// zscale rejects a frame whose input colorspec is incomplete ("no path
// between colorspaces"), which is exactly the common partially-tagged SD case
// (color_space=smpte170m with transfer and primaries unspecified). Supplying
// matrixin/transferin/primariesin, each defaulting to the SD BT.601 value
// when the probe left it blank, gives zscale a complete input spec. A
// fully-tagged non-709 source overrides these with its own values (a no-op),
// so this one recipe covers every needsBt709Conversion source.
export const bt709ConvertFilter = (mediaInfo: MediaInfo): string => {
  const video = videoStream(mediaInfo);
  const matrixin = knownColorOr(
    asString(video?.color_space ?? video?.colorspace),
    "smpte170m",
  );
  const transferin = knownColorOr(asString(video?.color_transfer), "smpte170m");
  const primariesin = knownColorOr(
    asString(video?.color_primaries),
    "smpte170m",
  );
  return `zscale=matrixin=${matrixin}:transferin=${transferin}:primariesin=${primariesin}:${BT709_OUTPUT_PARAMS}`;
};

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
      ? `${bt709ConvertFilter(mediaInfo)},`
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

/* Frame 0 is the worst possible thumbnail: real footage opens on black, a
   slate, a countdown, or bars, so every poster looked identical and told you
   nothing about the clip. Seek 10% in, and let the thumbnail filter pick the
   most representative frame of the next 100 rather than whatever lands under
   the playhead. Short clips (or an unknown duration) stay at the start, where
   10% is not far enough in to matter. */
export const posterSeekSeconds = (mediaInfo: MediaInfo): number => {
  const duration = durationSeconds(mediaInfo);
  return duration > 0 ? Math.min(duration * 0.1, 60) : 0;
};

export const POSTER_THUMBNAIL_WINDOW = 100;

/* A source with no picture in it. Sidecars that mean "a frame of the footage"
   have to mean something else for these: an audio file's poster is a drawing
   of its sound. */
export const isAudioOnly = (mediaInfo: MediaInfo): boolean =>
  !videoStream(mediaInfo) &&
  mediaInfo.streams.some((stream) => stream.codec_type === "audio");

/* The waveform ink is sumimai's straw (--sumimai-b), the same colour the
   player draws peak data in, so the card in a grid and the hero on the review
   page are recognisably the same waveform. */
const WAVEFORM_INK = "#f7e1a0";

/* Sound as a picture, for the places a picture is what fits: the grid tile,
   the share room card, the unfurl. showwavespic draws on transparency, so the
   waveform is laid over an ink ground rather than left to flatten to whatever
   black the PNG encoder picks. Audio assets had no poster at all before this
   and showed as an empty tile.

   Two lanes and a square-root amplitude scale, because this is a thumbnail:
   at 130 pixels wide, a linear drawing of ordinary programme material (mean
   level around -20 dBFS) is a hairline that says nothing. The hero waveform
   on the review page is drawn from real peak data and is not scaled this
   way. */
export const AUDIO_POSTER_WIDTH = 640;
export const AUDIO_POSTER_HEIGHT = 360;
const AUDIO_POSTER_FILTER = [
  `color=c=0x101c28:s=${AUDIO_POSTER_WIDTH}x${AUDIO_POSTER_HEIGHT}[bg]`,
  `[0:a]showwavespic=s=${AUDIO_POSTER_WIDTH}x${AUDIO_POSTER_HEIGHT}:colors=${WAVEFORM_INK}:split_channels=1:scale=sqrt[wave]`,
  "[bg][wave]overlay=format=auto[poster]",
].join(";");

/* The spectrogram is rendered as luminance, not in one of ffmpeg's colour
   maps, and the player maps it through a palette in the browser. Two reasons:
   the room it lands in decides the colour (the review instrument and a client
   presentation are different worlds), and a colour map baked into a PNG can
   never be undone. magma is the ramp chosen for that luminance because it is
   monotonic in lightness by construction, so format=gray leaves a picture
   where brighter still means louder; a rainbow map does not survive the
   conversion (its reds and blues collapse onto the same grey).

   Log frequency and log amplitude, because that is how hearing works: a
   linear frequency axis spends four fifths of its height on the top two
   octaves, where dialogue and music mostly are not.

   The resample to 48 kHz is what makes the frequency axis knowable. The
   filter's log curve is not a plain logarithm and its shape depends on the
   Nyquist frequency, so without a fixed input rate a 44.1 kHz file and a 96
   kHz file would put 1 kHz at different heights and no axis could be drawn
   over either. The player's SPECTROGRAM_AXIS table is measured against this
   exact string; changing it means re-measuring (qa/spectrogram-axis). */
export const SPECTROGRAM_WIDTH = 2048;
export const SPECTROGRAM_HEIGHT = 512;
export const SPECTROGRAM_RATE = 48000;
const SPECTROGRAM_FILTER = `aresample=${SPECTROGRAM_RATE},showspectrumpic=s=${SPECTROGRAM_WIDTH}x${SPECTROGRAM_HEIGHT}:mode=combined:legend=0:scale=log:fscale=log:color=magma,format=gray`;

export const sidecarArgs = (
  job: TranscodeJob,
  outputPath: string,
  kind: string,
  vaapiDevice = process.env[VAAPI_DEVICE_ENV],
): string[] | undefined => {
  /* Sidecars encode nothing on the GPU, but they still decode the source --
     the sprite reads every frame of it -- so the decoder is worth moving even
     here. */
  const decodeArgs = canUseVaapi(job.mediaInfo, vaapiDevice)
    ? vaapiDecodeArgs(vaapiDevice as string)
    : [];
  if (kind === "poster" && isAudioOnly(job.mediaInfo))
    return [
      "-hide_banner",
      "-y",
      "-i",
      job.sourceKey,
      "-filter_complex",
      AUDIO_POSTER_FILTER,
      "-map",
      "[poster]",
      "-frames:v",
      "1",
      outputPath,
    ];
  if (kind === "poster")
    return [
      "-hide_banner",
      "-y",
      ...tonemapHwDeviceArgs(job.mediaInfo),
      ...decodeArgs,
      "-ss",
      String(posterSeekSeconds(job.mediaInfo)),
      "-i",
      job.sourceKey,
      "-frames:v",
      "1",
      "-vf",
      `${colorPrefix(job.mediaInfo)}thumbnail=${String(POSTER_THUMBNAIL_WINDOW)},scale=640:-2:force_original_aspect_ratio=decrease`,
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
      ...tonemapHwDeviceArgs(job.mediaInfo),
      ...decodeArgs,
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
  /* The playable audio. Sources arrive as WAV, AIFF, FLAC, 24-bit, 96 kHz,
     eight channels of stems: none of that is what a browser should stream, and
     several of those a browser will not decode at all. AAC at 192k stereo is
     the same bargain the video ladder makes -- good enough to judge the mix,
     small enough to scrub -- and the original is one click away for anyone who
     needs the real thing. -vn drops cover art, which would otherwise be muxed
     in as a video stream and make the file look like a one-frame movie. */
  if (kind === "proxy_audio")
    return [
      "-hide_banner",
      "-y",
      "-i",
      job.sourceKey,
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath,
    ];
  if (kind === "spectrogram")
    return [
      "-hide_banner",
      "-y",
      "-i",
      job.sourceKey,
      "-filter_complex",
      `[0:a]${SPECTROGRAM_FILTER}[spec]`,
      "-map",
      "[spec]",
      "-frames:v",
      "1",
      outputPath,
    ];
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
  vaapiDevice = process.env[VAAPI_DEVICE_ENV],
): string[] => {
  const gop = rate ? Math.max(1, Math.round(rate.num / rate.den)) : 24;
  // The source here is our own finished proxy, which is always SDR BT.709, so
  // there is no HDR case to exclude: the device alone decides.
  const hardware = Boolean(vaapiDevice);
  return [
    "-hide_banner",
    "-y",
    ...(hardware ? vaapiHwDeviceArgs(vaapiDevice as string) : []),
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `${buildWatermarkFilter(spec, tokens, fontfile)},${
      hardware ? VAAPI_UPLOAD_FILTER : "format=yuv420p"
    }`,
    ...(hardware ? vaapiVideoArgs("18") : softwareVideoArgs("18")),
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    ...(hardware ? [] : ["-sc_threshold", "0"]),
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

// Ladder numbers are heights; -2 keeps the derived width even.
const ladderScale = (height: number): string =>
  height > 0 ? `scale=-2:${height}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";

const ladderQuality = (height: number): string =>
  height >= 2160 ? "19" : height <= 540 ? "21" : "18";

const SPRITE_TILE_FILTER = `scale=${SPRITE_TILE_WIDTH}:${SPRITE_TILE_HEIGHT}:force_original_aspect_ratio=decrease,pad=${SPRITE_TILE_WIDTH}:${SPRITE_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2`;

/* Everything after the filter for one proxy output: encoder, GOP, colorimetry,
   audio, faststart, timecode, path. Shared so the one-pass builder below cannot
   drift from the single-output recipe. */
const sdrProxyOutputTail = (
  job: TranscodeJob,
  outputPath: string,
  height: number,
  hardware: boolean,
): string[] => {
  const args = [
    ...(hardware
      ? vaapiVideoArgs(ladderQuality(height))
      : softwareVideoArgs(ladderQuality(height))),
    "-g",
    String(gopSize(job.mediaInfo)),
    "-keyint_min",
    String(gopSize(job.mediaInfo)),
    ...(hardware ? [] : ["-sc_threshold", "0"]),
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

export const COMBINABLE_PROXY_KINDS = ["proxy_2160", "proxy_1080", "proxy_540"];

/* One decode, every SDR video rendition.

   runTranscode spawns one ffmpeg per rendition, so a 31 Mbps source was decoded
   from scratch for proxy_1080, again for proxy_540, and again for the sprite,
   which reads every frame. Decoding is the dominant cost of each of those
   passes, so paying it N times is most of why a job felt slow.

   This emits them all from a single decode with a split. Filters per branch are
   character-for-character what the single-output builders emit, so the outputs
   are the same files, just produced once.

   HDR is excluded: it tonemaps through libplacebo on a Vulkan filter device and
   is a different recipe per output, not a shared prefix.

   Returns undefined when there is nothing to save (fewer than two combinable
   outputs), and the caller treats any failure as "just encode them one by one" —
   this is an optimisation, never a new failure mode. */
export const buildCombinedSdrArgs = (
  job: TranscodeJob,
  outputs: Array<{ kind: string; path: string; height?: number }>,
  vaapiDevice = process.env[VAAPI_DEVICE_ENV],
): string[] | undefined => {
  if (isHdrSource(job.mediaInfo)) return undefined;
  const proxies = outputs.filter((o) =>
    COMBINABLE_PROXY_KINDS.includes(o.kind),
  );
  const sprite = outputs.find((o) => o.kind === "sprite");
  const branches = proxies.length + (sprite ? 1 : 0);
  if (branches < 2) return undefined;

  const hardware = canUseVaapi(job.mediaInfo, vaapiDevice);
  const labels = proxies.map((_, index) => `p${String(index)}`);
  if (sprite) labels.push("sp");

  // The colour conversion is identical for every branch, so it happens once,
  // before the split.
  const chains = [
    `[0:v]${colorPrefix(job.mediaInfo)}split=${String(labels.length)}${labels
      .map((l) => `[${l}]`)
      .join("")}`,
    ...proxies.map(
      (output, index) =>
        `[${labels[index] as string}]${ladderScale(output.height ?? 1080)},${fpsFilter(
          job.mediaInfo,
        )},${hardware ? VAAPI_UPLOAD_FILTER : "format=yuv420p"}[v${String(index)}]`,
    ),
    ...(sprite
      ? [
          `[sp]fps=1/${String(spriteInterval(job.mediaInfo))},${SPRITE_TILE_FILTER},tile=10x10[vsp]`,
        ]
      : []),
  ];

  const args = [
    "-hide_banner",
    "-y",
    ...(hardware ? vaapiHwDeviceArgs(vaapiDevice as string) : []),
    "-i",
    job.sourceKey,
    "-filter_complex",
    chains.join(";"),
  ];
  proxies.forEach((output, index) => {
    args.push("-map", `[v${String(index)}]`, "-map", "0:a:0?");
    args.push(
      ...sdrProxyOutputTail(job, output.path, output.height ?? 1080, hardware),
    );
  });
  if (sprite)
    args.push("-map", "[vsp]", "-frames:v", "1", "-q:v", "3", sprite.path);
  return args;
};

export const buildSdrProxyArgs = (
  job: TranscodeJob,
  outputPath: string,
  height: number,
  vaapiDevice = process.env[VAAPI_DEVICE_ENV],
): string[] => {
  const scale = ladderScale(height);
  const hardware = canUseVaapi(job.mediaInfo, vaapiDevice);
  const filters = `${colorPrefix(job.mediaInfo)}${scale},${fpsFilter(job.mediaInfo)},${
    hardware ? VAAPI_UPLOAD_FILTER : "format=yuv420p"
  }`;
  return [
    "-hide_banner",
    "-y",
    ...tonemapHwDeviceArgs(job.mediaInfo),
    ...(hardware ? vaapiHwDeviceArgs(vaapiDevice as string) : []),
    "-i",
    job.sourceKey,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    filters,
    ...sdrProxyOutputTail(job, outputPath, height, hardware),
  ];
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
// proxy_1080, audio needs something to play, image needs still_tiles or
// poster, pdf needs pdf_pages.
//
// Audio's primary is the proxy, not the waveform: a version whose spectrogram
// or peak sidecar failed is still a version you can play and comment on, and
// audio_peaks stays in the list so a version transcoded before proxy_audio
// existed is not retroactively unready.
export const primaryRenditionKinds = (assetKind: string): string[] =>
  assetKind === "audio"
    ? ["proxy_audio", "audio_peaks"]
    : assetKind === "image"
      ? ["still_tiles", "poster"]
      : assetKind === "pdf"
        ? ["pdf_pages"]
        : ["proxy_1080"];

export const planRenditions = (
  assetKind: string,
  mediaInfo: MediaInfo,
): PlannedRendition[] => {
  /* An audio asset gets everything its page is made of: the proxy it plays,
     the peak data the waveform is drawn from, the spectrogram under it, and a
     poster so the file is not a blank tile everywhere it is listed. */
  if (assetKind === "audio")
    return [
      { kind: "proxy_audio", filename: "proxy_audio.m4a" },
      { kind: "waveform_data", filename: "waveform.dat" },
      { kind: "spectrogram", filename: "spectrogram.png" },
      { kind: "poster", filename: "poster.png" },
    ];
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
  /* Peak data rather than the old showwavespic PNG: the timeline's waveform
     lane is drawn from it now, at whatever width the lane happens to be. */
  if (audio) planned.push({ kind: "waveform_data", filename: "waveform.dat" });
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

  /* Fast path: emit every SDR video rendition from one decode instead of
     decoding the source once per rendition. Only outputs that do not already
     exist are worth producing, and each lands at a temp name that is renamed on
     success, so a crash never leaves a truncated file at a final path -- the
     same contract the per-output loop keeps.

     Any failure here is swallowed on purpose: the loop below then encodes each
     rendition exactly as it always did. This can make a job faster; it must
     never make one fail. */
  const pending: Array<{ kind: string; path: string; height?: number }> = [];
  for (const output of outputPaths)
    if (!(await fileReady(output.path))) pending.push(output);
  const combined = buildCombinedSdrArgs(
    job,
    pending.map((output) => ({
      ...output,
      path: path.join(
        path.dirname(output.path),
        `.tmp-combined-${path.basename(output.path)}`,
      ),
    })),
  );
  if (combined) {
    const temps = pending
      .filter(
        (output) =>
          COMBINABLE_PROXY_KINDS.includes(output.kind) ||
          output.kind === "sprite",
      )
      .map((output) => ({
        final: output.path,
        temp: path.join(
          path.dirname(output.path),
          `.tmp-combined-${path.basename(output.path)}`,
        ),
      }));
    try {
      await mkdir(path.dirname(temps[0]?.final ?? job.sourceKey), {
        recursive: true,
      });
      await runProcess(ffmpeg, combined);
      for (const { temp, final } of temps) await rename(temp, final);
    } catch (error) {
      console.warn(
        `[onelight-worker] one-pass encode failed for job ${job.id}, falling back to one ffmpeg per rendition: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const { temp } of temps) await rm(temp, { force: true });
    }
  }

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
      // Peak data is the one output no ffmpeg invocation can write on its
      // own: ffmpeg decodes, this process reduces. Same reuse and rename
      // contract as every other output (writePeaks keeps it).
      if (output.kind === "waveform_data") {
        const meta = (await fileReady(output.path))
          ? { content_type: "application/octet-stream" }
          : await writePeaks(job.sourceKey, output.path, job.mediaInfo, ffmpeg);
        renditions.push({ kind: output.kind, key: output.path, meta });
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
      /* Remove the half-written temp. The GC in maintenance.ts deliberately
         skips .tmp-* names, so a leaked temp is never reclaimed -- and on a
         tight container disk a recurring failure would otherwise grow temps
         until the disk fills and every encode fails, a self-sustaining loop. */
      await rm(
        path.join(
          path.dirname(output.path),
          `.tmp-${path.basename(output.path)}`,
        ),
        { force: true },
      ).catch(() => undefined);
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
/* ---- waveform peak data ----
 *
 * ffmpeg decodes the source to raw PCM on stdout and this reads it as it
 * comes, keeping one running min/max per bucket. Nothing is staged on disk:
 * an hour of stereo 48 kHz PCM is 690 MB, which the container disk limit does
 * not have room for, and the sidecar it reduces to is under a megabyte.
 */

/* One decode rate for every source, so the same file always produces the same
   sidecar. 48 kHz is above anything that matters to a waveform drawing; the
   resample only discards content that was never going to be visible. */
export const PEAKS_SAMPLE_RATE = 48000;
/* Roughly a point every 5 ms: fine enough that a drum hit is a spike rather
   than a smudge at any width a screen has. */
export const PEAKS_POINTS_PER_SECOND = 200;
/* ...but a long file is capped, so a 90 minute podcast makes a 1.7 MB sidecar
   instead of a 26 MB one. Past the cap the resolution degrades gracefully:
   still ~22 points per second at three hours. */
export const PEAKS_MAX_POINTS = 120_000;

const audioStream = (
  mediaInfo: MediaInfo,
): Record<string, unknown> | undefined =>
  mediaInfo.streams.find((stream) => stream.codec_type === "audio");

/* Stereo or mono, never more: a surround stem is folded down for the drawing.
   Anyone judging a 5.1 mix needs the original, not a picture of it. */
export const peaksChannels = (mediaInfo: MediaInfo): number =>
  Number(audioStream(mediaInfo)?.channels ?? 2) >= 2 ? 2 : 1;

/* Seconds of media, from whatever the probe knew. Audio has no frame count,
   so the format duration is the only source. */
export const sourceDurationSeconds = (mediaInfo: MediaInfo): number => {
  const framed = durationSeconds(mediaInfo);
  if (framed > 0) return framed;
  const value = Number(mediaInfo.format["duration"]);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const peaksSamplesPerPixel = (
  sampleRate: number,
  duration: number,
): number => {
  const perPoint = Math.max(
    1,
    Math.round(sampleRate / PEAKS_POINTS_PER_SECOND),
  );
  if (duration <= 0) return perPoint;
  const points = (duration * sampleRate) / perPoint;
  if (points <= PEAKS_MAX_POINTS) return perPoint;
  return Math.ceil((duration * sampleRate) / PEAKS_MAX_POINTS);
};

export const peaksPcmArgs = (
  source: string,
  channels: number,
  sampleRate = PEAKS_SAMPLE_RATE,
): string[] => [
  "-hide_banner",
  "-v",
  "error",
  "-i",
  source,
  "-vn",
  "-ac",
  String(channels),
  "-ar",
  String(sampleRate),
  "-f",
  "s16le",
  "-acodec",
  "pcm_s16le",
  "pipe:1",
];

/* Fold interleaved s16 PCM into min/max pairs, a chunk at a time. The decoder
   is read as it runs rather than collected first: the PCM is two orders of
   magnitude larger than the sidecar it reduces to, and holding an hour of it
   (690 MB) in memory to summarise it would be the same mistake as staging it
   on disk. */
export const createPeakCollector = (
  channels: number,
  samplesPerPixel: number,
): {
  push: (chunk: Uint8Array) => void;
  finish: () => { samples: Float32Array; length: number };
} => {
  const mins = new Float32Array(channels).fill(0);
  const maxes = new Float32Array(channels).fill(0);
  const points: number[] = [];
  let inBucket = 0;
  /* A sample frame is channels * 2 bytes and a chunk boundary lands wherever
     the pipe felt like it, so a partial frame is carried into the next one. */
  const carry = new Uint8Array(channels * 2);
  let carried = 0;
  const flush = (): void => {
    for (let channel = 0; channel < channels; channel += 1) {
      points.push(mins[channel] ?? 0, maxes[channel] ?? 0);
      mins[channel] = 0;
      maxes[channel] = 0;
    }
    inBucket = 0;
  };
  const takeFrame = (view: DataView, at: number): void => {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = view.getInt16(at + channel * 2, true) / 32768;
      if (value < (mins[channel] ?? 0)) mins[channel] = value;
      if (value > (maxes[channel] ?? 0)) maxes[channel] = value;
    }
    inBucket += 1;
    if (inBucket >= samplesPerPixel) flush();
  };
  const push = (chunk: Uint8Array): void => {
    let offset = 0;
    if (carried > 0) {
      const needed = Math.min(carry.length - carried, chunk.length);
      carry.set(chunk.subarray(0, needed), carried);
      carried += needed;
      offset = needed;
      if (carried < carry.length) return;
      takeFrame(new DataView(carry.buffer, carry.byteOffset, carry.length), 0);
      carried = 0;
    }
    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset + offset,
      chunk.length - offset,
    );
    const frameBytes = channels * 2;
    const whole = Math.floor(view.byteLength / frameBytes);
    for (let frame = 0; frame < whole; frame += 1)
      takeFrame(view, frame * frameBytes);
    const rest = view.byteLength - whole * frameBytes;
    if (rest > 0) {
      carry.set(chunk.subarray(chunk.length - rest), 0);
      carried = rest;
    }
  };
  const finish = (): { samples: Float32Array; length: number } => {
    /* A partly filled last bucket is still sound that happened. */
    if (inBucket > 0) flush();
    return {
      samples: Float32Array.from(points),
      length: points.length / (channels * 2),
    };
  };
  return { push, finish };
};

const streamProcess = (
  command: string,
  args: string[],
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    let timedOut = false;
    let idle: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, PROCESS_IDLE_TIMEOUT_MS);
    };
    arm();
    child.stdout.on("data", (chunk: Buffer) => {
      onChunk(chunk);
      arm();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      arm();
    });
    child.once("error", (error) => {
      clearTimeout(idle);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(idle);
      if (timedOut) {
        reject(
          new Error(`${command} was killed after a stall (treated as hung).`),
        );
        return;
      }
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} exited with ${code}: ${Buffer.concat(stderr)
              .toString("utf8")
              .slice(-4000)}`,
          ),
        );
    });
  });

/** Decode the source and write its peak sidecar. Returns the meta the
    rendition row carries, which is what the player needs to draw without
    parsing the file header first. */
export const writePeaks = async (
  source: string,
  outputPath: string,
  mediaInfo: MediaInfo,
  ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg",
): Promise<Record<string, unknown>> => {
  const channels = peaksChannels(mediaInfo);
  const samplesPerPixel = peaksSamplesPerPixel(
    PEAKS_SAMPLE_RATE,
    sourceDurationSeconds(mediaInfo),
  );
  const collector = createPeakCollector(channels, samplesPerPixel);
  await streamProcess(
    ffmpeg,
    peaksPcmArgs(source, channels, PEAKS_SAMPLE_RATE),
    collector.push,
  );
  const { samples, length } = collector.finish();
  if (length === 0) throw new Error("The source decoded to no audio.");
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(outputPath),
    `.tmp-${path.basename(outputPath)}`,
  );
  try {
    await writeFile(
      tempPath,
      encodePeaks({
        sampleRate: PEAKS_SAMPLE_RATE,
        samplesPerPixel,
        channels,
        length,
        samples,
      }),
    );
    await rename(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    content_type: "application/octet-stream",
    peaks_format: "audiowaveform_v2",
    sample_rate: PEAKS_SAMPLE_RATE,
    samples_per_pixel: samplesPerPixel,
    channels,
    points: length,
    duration_seconds: (length * samplesPerPixel) / PEAKS_SAMPLE_RATE,
  };
};

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
  try {
    await runProcess(ffmpeg, argsFor(tempPath));
    await rename(tempPath, outputPath);
  } catch (error) {
    // The GC never reclaims .tmp-* names; clean the half-written temp here so
    // a repeated still/export failure cannot grow the disk without bound.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
