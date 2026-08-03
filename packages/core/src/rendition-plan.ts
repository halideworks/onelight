/* What a version's renditions are, decided without opening a file.
 *
 * This is the vocabulary the server and the worker share: the server plans a
 * job from it and the worker executes the plan, so it has to be readable by
 * both. It lives in core for the same reason `MediaInfo` and `stills-format`
 * do -- and for one more, measured rather than assumed.
 *
 * Every one of these used to live in `@onelight/worker`, whose index re-exports
 * `media.ts`, and `media.ts` imports `node:child_process` on its first line. So
 * a server module that wanted to know which proxies a video should have pulled
 * `spawn` in behind it, and any runtime without it -- the Workers target --
 * could not load the module at all: workerd does not report a missing import
 * there, it takes SIGSEGV and the pool dies. Nothing here touches a process, a
 * file or a clock, so nothing here needs to.
 *
 * The media library still owns everything that runs ffmpeg. What moved is only
 * the deciding.
 */

import type { MediaInfo } from "./ports.js";

export interface PlannedRendition {
  kind: string;
  filename: string;
  height?: number;
}

export type StillRungKind = "poster" | "still_review" | "still_full";

export interface StillRung {
  kind: StillRungKind;
  /** Longest edge in pixels; 0 means the source's own size. */
  longEdge: number;
  filename: string;
  contentType: string;
}

/* q82 mozjpeg for the poster because it is the compatibility surface: link
   unfurls, mail clients and anything else that will not be told what WebP is.
   q82 WebP with smart subsampling for the review still because chroma is what
   a retoucher is looking at, and 4:2:0 on a 2048 still is visible damage;
   measured at 87 KB against 411 KB for the equivalent 4:4:4 JPEG. */
export const STILL_LADDER: StillRung[] = [
  {
    kind: "poster",
    longEdge: 640,
    filename: "poster.jpg",
    contentType: "image/jpeg",
  },
  {
    kind: "still_review",
    longEdge: 2048,
    filename: "still_review.webp",
    contentType: "image/webp",
  },
];

export const STILL_FULL_RUNG: StillRung = {
  kind: "still_full",
  longEdge: 0,
  filename: "still_full.webp",
  contentType: "image/webp",
};

/** A ceiling on the on-demand full-size rung, so a 200 MP scan cannot ask the
    browser for a texture no browser will allocate. */
export const STILL_FULL_MAX_EDGE = 8192;

/* Sixteen positions across a clip, as fractions of its duration.

   Fewer than sixteen and the overlap between two clips is a coarse fraction:
   four samples can only answer in quarters. Sixteen makes the overlap score
   mean something, and sixteen seeks is still a fixed cost that does not care
   how long the clip is.

   They avoid both ends, where a slate, a fade or black would make every clip
   look like every other. */
export const CLIP_HASH_POSITIONS = Array.from(
  { length: 16 },
  (_, index) => 0.06 + (index * 0.88) / 15,
);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const videoStream = (
  mediaInfo: MediaInfo,
): Record<string, unknown> | undefined =>
  mediaInfo.streams.find((stream) => stream.codec_type === "video");

const sourceTransfer = (mediaInfo: MediaInfo): string | undefined =>
  asString(videoStream(mediaInfo)?.color_transfer) ??
  asString(mediaInfo.format["color_transfer"]);

const sourceBitDepth = (mediaInfo: MediaInfo): number => {
  const video = videoStream(mediaInfo);
  const declared = Number(asString(video?.bits_per_raw_sample));
  if (Number.isFinite(declared) && declared > 0) return declared;
  const format = asString(video?.pix_fmt) ?? "";
  const match = /p(\d{2})(?:le|be)?$/.exec(format);
  return match ? Number(match[1]) : 8;
};

/*
 * A tagged PQ or HLG transfer is HDR, and so is an untagged source deeper
 * than eight bits.
 *
 * The second half exists because a Dolby Vision master arrived with its
 * transfer, primaries and matrix all reading "unknown". It was therefore
 * classified SDR, skipped the tonemap, and had BT.709 stamped on it by the
 * colour defaults -- PQ code values encoded as though they were gamma, which
 * looks exactly as wrong as it sounds.
 */
export const isHdrSource = (mediaInfo: MediaInfo): boolean => {
  const transfer = sourceTransfer(mediaInfo);
  if (transfer === "smpte2084" || transfer === "arib-std-b67") return true;
  const untagged = transfer === undefined || transfer === "unknown";
  return untagged && sourceBitDepth(mediaInfo) > 8;
};

export const primaryRenditionKinds = (assetKind: string): string[] =>
  assetKind === "audio"
    ? ["proxy_audio", "audio_peaks"]
    : assetKind === "image"
      ? /* still_tiles stays in the list although nothing produces it any
           more: a version transcoded before the stills ladder existed is a
           picture you can still open, and must not be made unready by a
           change to how the next one is rendered. */
        ["still_review", "poster", "still_tiles"]
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
      { kind: "shuttle_audio_2x", filename: "shuttle_audio_2x.m4a" },
      { kind: "shuttle_audio_4x", filename: "shuttle_audio_4x.m4a" },
      { kind: "waveform_data", filename: "waveform.dat" },
      { kind: "spectrogram", filename: "spectrogram.png" },
      { kind: "poster", filename: "poster.png" },
    ];
  /* Stills get the ladder above, not an ffmpeg recipe. The old plan made a
     4096-wide PNG (14 MB was ordinary) and served it as both the grid tile
     and the review picture, and its poster silently produced nothing at all
     on a JPEG source. See stills.ts for why sharp renders these. */
  if (assetKind === "image")
    return STILL_LADDER.map((rung) => ({
      kind: rung.kind,
      filename: rung.filename,
    }));
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
  if (audio)
    planned.push(
      { kind: "waveform_data", filename: "waveform.dat" },
      { kind: "reference_audio_1x", filename: "reference_audio_1x.m4a" },
      { kind: "shuttle_audio_2x", filename: "shuttle_audio_2x.m4a" },
      { kind: "shuttle_audio_4x", filename: "shuttle_audio_4x.m4a" },
    );
  return planned;
};
