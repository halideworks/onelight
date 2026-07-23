import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaInfo, TranscodeJob } from "@onelight/core";
import {
  DEFAULT_WATERMARK_FONTFILE,
  HDR_TONEMAP_FILTER,
  POSTER_THUMBNAIL_WINDOW,
  VAAPI_DEVICE_ENV,
  VULKAN_HWDEVICE_ARGS,
  bt709ConvertFilter,
  buildHdrAv1Args,
  buildHdrHevcArgs,
  buildPdfPagesArgs,
  buildCombinedSdrArgs,
  buildSdrProxyArgs,
  buildStillArgs,
  buildWatermarkArgs,
  buildWatermarkFilter,
  canUseVaapi,
  clampToSupportedRate,
  createPeakCollector,
  escapeDrawtextValue,
  isAudioOnly,
  needsBt709Conversion,
  normalizeProbe,
  parseRational,
  peaksChannels,
  peaksPcmArgs,
  peaksSamplesPerPixel,
  planRenditions,
  posterSeekSeconds,
  primaryRenditionKinds,
  probeArgs,
  renderWatermarkText,
  sidecarArgs,
  spriteInterval,
  writeSpriteVtt,
} from "./media.js";

const flag = (args: string[], name: string): string | undefined =>
  args[args.indexOf(name) + 1];

const mediaInfoOf = (overrides: Partial<MediaInfo> = {}): MediaInfo => ({
  format: {},
  streams: [],
  frameRateNum: 24000,
  frameRateDen: 1001,
  variableFrameRate: false,
  colorAssumed: false,
  ...overrides,
});

const jobOf = (mediaInfo: MediaInfo): TranscodeJob => ({
  id: "job",
  sourceKey: "source.mov",
  outputs: [],
  mediaInfo,
});

const hdrMediaInfo = (transfer: string): MediaInfo =>
  mediaInfoOf({
    streams: [
      {
        codec_type: "video",
        color_transfer: transfer,
        color_primaries: "bt2020",
        color_space: "bt2020nc",
      },
    ],
  });

describe("probe normalization", () => {
  it("stores the complete ffprobe JSON without a tags whitelist", () => {
    const args = probeArgs("https://blob.example/source.mov");
    expect(args).toContain("https://blob.example/source.mov");
    expect(args).toContain("-show_format");
    expect(args).toContain("-show_streams");
    expect(args).not.toContain("-show_entries");
  });

  it("prefers avg_frame_rate and does not flag rounding differences as VFR", () => {
    const mediaInfo = normalizeProbe({
      format: { duration: "10" },
      streams: [
        {
          codec_type: "video",
          r_frame_rate: "24000/1001",
          avg_frame_rate: "24000/1001",
          nb_frames: "240",
          tags: { timecode: "01:00:00;00" },
        },
      ],
    });
    expect(mediaInfo.frameRateNum).toBe(24000);
    expect(mediaInfo.frameRateDen).toBe(1001);
    expect(mediaInfo.sourceTimecodeStart).toBe("01:00:00;00");
    // 23.976 is not an NTSC drop rate, so a ";" here is a mistag: not drop.
    expect(mediaInfo.dropFrame).toBe(false);
    expect(mediaInfo.variableFrameRate).toBe(false);
    expect(mediaInfo.colorAssumed).toBe(true);
  });

  it("marks drop-frame only for the 29.97 and 59.94 NTSC rates", () => {
    const dropFrameOf = (avgRate: string): boolean | undefined =>
      normalizeProbe({
        format: {},
        streams: [
          {
            codec_type: "video",
            avg_frame_rate: avgRate,
            tags: { timecode: "01:00:00;00" },
          },
        ],
      }).dropFrame;
    expect(dropFrameOf("30000/1001")).toBe(true);
    expect(dropFrameOf("60000/1001")).toBe(true);
    // A ";" on a mistagged 23.976 or 25 source must not set drop-frame.
    expect(dropFrameOf("24000/1001")).toBe(false);
    expect(dropFrameOf("25/1")).toBe(false);
    // An exact 30 clamps to the supported 29.97 rate, which IS a drop rate,
    // so the flag is evaluated against the clamped rate, not the probed one.
    expect(dropFrameOf("30/1")).toBe(true);
  });

  it("treats 24000/1001 r_frame_rate vs 24 avg_frame_rate as CFR", () => {
    const mediaInfo = normalizeProbe({
      format: {},
      streams: [
        {
          codec_type: "video",
          r_frame_rate: "24000/1001",
          avg_frame_rate: "24/1",
        },
      ],
    });
    expect(mediaInfo.variableFrameRate).toBe(false);
    expect(mediaInfo.frameRateNum).toBe(24);
    expect(mediaInfo.frameRateDen).toBe(1);
    expect(mediaInfo.dropFrame).toBeUndefined();
  });

  it("flags materially different rates as VFR and clamps to the whitelist", () => {
    const mediaInfo = normalizeProbe({
      format: {},
      streams: [
        {
          codec_type: "video",
          r_frame_rate: "30000/1001",
          avg_frame_rate: "15/1",
        },
      ],
    });
    expect(mediaInfo.variableFrameRate).toBe(true);
    expect(mediaInfo.frameRateClamped).toBe(true);
    expect(mediaInfo.probedFrameRate).toBe("15/1");
    expect(mediaInfo.frameRateNum).toBe(24000);
    expect(mediaInfo.frameRateDen).toBe(1001);
  });

  it("clamps to the nearest supported rational rate", () => {
    expect(parseRational("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(clampToSupportedRate({ num: 24000, den: 1001 })).toEqual({
      rate: { num: 24000, den: 1001 },
      exact: true,
    });
    expect(clampToSupportedRate({ num: 48, den: 1 }).exact).toBe(true);
    expect(clampToSupportedRate({ num: 30, den: 1 })).toEqual({
      rate: { num: 30000, den: 1001 },
      exact: false,
    });
    expect(clampToSupportedRate({ num: 48000, den: 1001 })).toEqual({
      rate: { num: 48, den: 1 },
      exact: false,
    });
    expect(clampToSupportedRate({ num: 23, den: 1 }).rate).toEqual({
      num: 24000,
      den: 1001,
    });
  });
});

describe("SDR proxy recipe", () => {
  it("scales by ladder height with even width and keys CRF on height", () => {
    const cases = [
      { height: 2160, crf: "19" },
      { height: 1080, crf: "18" },
      { height: 540, crf: "21" },
    ];
    for (const entry of cases) {
      const args = buildSdrProxyArgs(
        jobOf(mediaInfoOf()),
        "proxy.mp4",
        entry.height,
      );
      expect(flag(args, "-vf")).toBe(
        `scale=-2:${entry.height},fps=24000/1001,format=yuv420p`,
      );
      expect(flag(args, "-crf")).toBe(entry.crf);
      expect(args).toContain("bt709");
      expect(args).toContain("proxy.mp4");
    }
  });

  it("tonemaps HDR sources with the exact libplacebo BT.2390 chain", () => {
    for (const transfer of ["smpte2084", "arib-std-b67"]) {
      const args = buildSdrProxyArgs(
        jobOf(hdrMediaInfo(transfer)),
        "proxy.mp4",
        1080,
      );
      expect(flag(args, "-vf")).toBe(
        "libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p,scale=-2:1080,fps=24000/1001,format=yuv420p",
      );
      expect(flag(args, "-vf")).not.toContain("inverse_ootf");
    }
    expect(HDR_TONEMAP_FILTER).toBe(
      "libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p",
    );
  });

  it("creates a Vulkan device for every HDR tonemap path, and only those", () => {
    const device = VULKAN_HWDEVICE_ARGS.join(" ");
    const hasDevice = (args: string[]): boolean =>
      args.join(" ").includes(device);
    const beforeInput = (args: string[]): boolean =>
      args.indexOf("-init_hw_device") < args.indexOf("-i");
    for (const transfer of ["smpte2084", "arib-std-b67"]) {
      const job = jobOf({ ...hdrMediaInfo(transfer), durationFrames: 240 });
      const proxy = buildSdrProxyArgs(job, "proxy.mp4", 1080);
      expect(hasDevice(proxy)).toBe(true);
      expect(beforeInput(proxy)).toBe(true);
      const poster = sidecarArgs(job, "poster.png", "poster") ?? [];
      expect(hasDevice(poster)).toBe(true);
      expect(beforeInput(poster)).toBe(true);
      const sprite = sidecarArgs(job, "sprite.png", "sprite") ?? [];
      expect(hasDevice(sprite)).toBe(true);
      expect(beforeInput(sprite)).toBe(true);
    }
    // SDR encodes must not create a Vulkan device (libplacebo is not used).
    const sdr = jobOf(mediaInfoOf({ durationFrames: 240 }));
    expect(hasDevice(buildSdrProxyArgs(sdr, "proxy.mp4", 1080))).toBe(false);
    expect(hasDevice(sidecarArgs(sdr, "poster.png", "poster") ?? [])).toBe(
      false,
    );
    expect(hasDevice(sidecarArgs(sdr, "sprite.png", "sprite") ?? [])).toBe(
      false,
    );
    // The HDR passthrough renditions do not tonemap, so no device either.
    expect(
      hasDevice(buildHdrAv1Args(jobOf(hdrMediaInfo("smpte2084")), "hdr.mp4")),
    ).toBe(false);
    expect(
      hasDevice(buildHdrHevcArgs(jobOf(hdrMediaInfo("smpte2084")), "hdr.mp4")),
    ).toBe(false);
  });
});

describe("VAAPI (QuickSync) hardware encode", () => {
  const NODE = "/dev/dri/renderD128";
  const tokens = {
    email: "client@example.com",
    name: "Client Name",
    share: "Cut 04 review",
    date: "2026-07-11",
  };

  it("stays on libx264 when no device is configured", () => {
    const args = buildSdrProxyArgs(jobOf(mediaInfoOf()), "proxy.mp4", 1080);
    expect(flag(args, "-c:v")).toBe("libx264");
    expect(flag(args, "-vf")).toBe(
      "scale=-2:1080,fps=24000/1001,format=yuv420p",
    );
    expect(args).not.toContain("-vaapi_device");
  });

  it("encodes on the GPU when a device is configured", () => {
    const args = buildSdrProxyArgs(
      jobOf(mediaInfoOf()),
      "proxy.mp4",
      1080,
      NODE,
    );
    expect(flag(args, "-c:v")).toBe("h264_vaapi");
    expect(flag(args, "-vaapi_device")).toBe(NODE);
    // The device is a global option: it has to precede the input.
    expect(args.indexOf("-vaapi_device")).toBeLessThan(args.indexOf("-i"));
    // hwupload replaces the software pixel-format stage.
    expect(flag(args, "-vf")).toBe(
      "scale=-2:1080,fps=24000/1001,format=nv12,hwupload",
    );
    // Alder Lake-N exposes only the low-power entrypoint, and CQP is the rate
    // control it supports -- CRF has no VAAPI equivalent.
    expect(flag(args, "-low_power")).toBe("1");
    expect(flag(args, "-rc_mode")).toBe("CQP");
    expect(flag(args, "-qp")).toBe("18");
    expect(args).not.toContain("-crf");
    // x264-only options must not be handed to a VAAPI encoder.
    expect(args).not.toContain("-preset");
    expect(args).not.toContain("-sc_threshold");
    // The frames are GPU surfaces by this point, not software yuv420p.
    expect(args).not.toContain("-pix_fmt");
  });

  it("keys QP on ladder height exactly as CRF does", () => {
    for (const entry of [
      { height: 2160, qp: "19" },
      { height: 1080, qp: "18" },
      { height: 540, qp: "21" },
    ]) {
      const args = buildSdrProxyArgs(
        jobOf(mediaInfoOf()),
        "proxy.mp4",
        entry.height,
        NODE,
      );
      expect(flag(args, "-qp")).toBe(entry.qp);
    }
  });

  it("keeps the BT.709 tags and GOP structure on the hardware path", () => {
    const args = buildSdrProxyArgs(
      jobOf(mediaInfoOf()),
      "proxy.mp4",
      1080,
      NODE,
    );
    expect(flag(args, "-colorspace")).toBe("bt709");
    expect(flag(args, "-color_primaries")).toBe("bt709");
    expect(flag(args, "-color_trc")).toBe("bt709");
    expect(flag(args, "-color_range")).toBe("tv");
    expect(flag(args, "-g")).toBe("24");
    expect(flag(args, "-keyint_min")).toBe("24");
  });

  // An HDR source tonemaps through libplacebo on -filter_hw_device vk, and
  // hwupload would follow that device and hand Vulkan frames to h264_vaapi.
  it("refuses the GPU for HDR sources even when a device is configured", () => {
    for (const transfer of ["smpte2084", "arib-std-b67"]) {
      const job = jobOf(hdrMediaInfo(transfer));
      expect(canUseVaapi(job.mediaInfo, NODE)).toBe(false);
      const args = buildSdrProxyArgs(job, "proxy.mp4", 1080, NODE);
      expect(flag(args, "-c:v")).toBe("libx264");
      expect(args).not.toContain("-vaapi_device");
      expect(args).not.toContain("hwupload");
      // The Vulkan tonemap device is still created, untouched by any of this.
      expect(args.join(" ")).toContain(VULKAN_HWDEVICE_ARGS.join(" "));
    }
    expect(canUseVaapi(mediaInfoOf(), NODE)).toBe(true);
    expect(canUseVaapi(mediaInfoOf(), undefined)).toBe(false);
  });

  it("burns watermarks on the GPU too, still copying audio", () => {
    const args = buildWatermarkArgs(
      "/blobs/proxy_1080.mp4",
      "/blobs/wm.mp4",
      { text: "{share}", position: "br" },
      tokens,
      { num: 24000, den: 1001 },
      DEFAULT_WATERMARK_FONTFILE,
      NODE,
    );
    expect(flag(args, "-c:v")).toBe("h264_vaapi");
    expect(flag(args, "-vaapi_device")).toBe(NODE);
    expect(flag(args, "-vf")).toContain(",format=nv12,hwupload");
    expect(flag(args, "-c:a")).toBe("copy");
    expect(flag(args, "-colorspace")).toBe("bt709");
    expect(args[args.length - 1]).toBe("/blobs/wm.mp4");
  });

  it("names the env var the deployment actually sets", () => {
    expect(VAAPI_DEVICE_ENV).toBe("ONELIGHT_VAAPI_DEVICE");
  });

  // Decoding is the larger half of the cost on a high-bitrate source, and
  // h264 decode is normative, so this is free correctness-wise.
  it("decodes on the GPU as well as encoding there", () => {
    const args = buildSdrProxyArgs(
      jobOf(mediaInfoOf()),
      "proxy.mp4",
      1080,
      NODE,
    );
    expect(flag(args, "-hwaccel")).toBe("vaapi");
    expect(flag(args, "-hwaccel_device")).toBe(NODE);
    expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"));
    // No -hwaccel_output_format: frames come back to system memory so every
    // software filter still sees what it saw before.
    expect(args).not.toContain("-hwaccel_output_format");
  });

  // The sprite reads every frame of the source, so it pays full decode cost
  // even though it encodes nothing on the GPU.
  it("decodes sidecars on the GPU too, and only when the source is not HDR", () => {
    const sdr = jobOf(mediaInfoOf({ durationFrames: 240 }));
    for (const kind of ["poster", "sprite"]) {
      const args = sidecarArgs(sdr, `${kind}.png`, kind, NODE) ?? [];
      expect(flag(args, "-hwaccel"), kind).toBe("vaapi");
      expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"));
    }
    // Unset device: unchanged, software all the way.
    expect(sidecarArgs(sdr, "poster.png", "poster") ?? []).not.toContain(
      "-hwaccel",
    );
    // HDR keeps its libplacebo path and does not mix in a VAAPI decoder.
    const hdr = jobOf({ ...hdrMediaInfo("smpte2084"), durationFrames: 240 });
    expect(sidecarArgs(hdr, "poster.png", "poster", NODE) ?? []).not.toContain(
      "-hwaccel",
    );
  });
});

describe("one-pass SDR encode", () => {
  const outputs = [
    { kind: "proxy_1080", path: "/out/proxy_1080.mp4", height: 1080 },
    { kind: "proxy_540", path: "/out/proxy_540.mp4", height: 540 },
    { kind: "sprite", path: "/out/sprite.png" },
    { kind: "poster", path: "/out/poster.png" },
    { kind: "audio_peaks", path: "/out/audio_peaks.png" },
  ];

  it("decodes once and splits to every video rendition", () => {
    const args = buildCombinedSdrArgs(jobOf(mediaInfoOf()), outputs) ?? [];
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    const graph = flag(args, "-filter_complex") ?? "";
    expect(graph).toContain("split=3[p0][p1][sp]");
    // Each branch is character-for-character the single-output recipe.
    expect(graph).toContain(
      "[p0]scale=-2:1080,fps=24000/1001,format=yuv420p[v0]",
    );
    expect(graph).toContain(
      "[p1]scale=-2:540,fps=24000/1001,format=yuv420p[v1]",
    );
    expect(graph).toContain("[sp]fps=1/");
    expect(graph).toContain("tile=10x10[vsp]");
    expect(args).toContain("/out/proxy_1080.mp4");
    expect(args).toContain("/out/proxy_540.mp4");
    expect(args).toContain("/out/sprite.png");
    // Poster and waveform are not video branches: they stay separate.
    expect(args).not.toContain("/out/poster.png");
    expect(args).not.toContain("/out/audio_peaks.png");
  });

  it("keeps each output's own quality, colour tags and audio", () => {
    const args = buildCombinedSdrArgs(jobOf(mediaInfoOf()), outputs) ?? [];
    expect(args.filter((a) => a === "-crf")).toHaveLength(2);
    expect(args).toContain("18");
    expect(args).toContain("21");
    expect(args.filter((a) => a === "-c:a")).toHaveLength(2);
    expect(args.filter((a) => a === "-colorspace")).toHaveLength(2);
    expect(args.filter((a) => a === "0:a:0?")).toHaveLength(2);
  });

  it("uses the GPU for the whole pass when a device is configured", () => {
    const args =
      buildCombinedSdrArgs(
        jobOf(mediaInfoOf()),
        outputs,
        "/dev/dri/renderD128",
      ) ?? [];
    expect(flag(args, "-hwaccel")).toBe("vaapi");
    expect(flag(args, "-vaapi_device")).toBe("/dev/dri/renderD128");
    const graph = flag(args, "-filter_complex") ?? "";
    expect(graph.match(/hwupload/g)).toHaveLength(2);
    expect(args.filter((a) => a === "h264_vaapi")).toHaveLength(2);
  });

  it("declines when there is nothing to save", () => {
    expect(
      buildCombinedSdrArgs(jobOf(mediaInfoOf()), [
        outputs[0] as (typeof outputs)[0],
      ]),
    ).toBeUndefined();
    expect(
      buildCombinedSdrArgs(jobOf(mediaInfoOf()), [
        { kind: "poster", path: "/out/poster.png" },
        { kind: "audio_peaks", path: "/out/audio_peaks.png" },
      ]),
    ).toBeUndefined();
  });

  // HDR is a different recipe per output (libplacebo on a Vulkan filter
  // device), not a shared prefix, so it keeps one ffmpeg per rendition.
  it("declines for HDR sources", () => {
    expect(
      buildCombinedSdrArgs(jobOf(hdrMediaInfo("smpte2084")), outputs),
    ).toBeUndefined();
  });

  it("applies the colour conversion once, before the split", () => {
    const sdr601 = mediaInfoOf({
      streams: [{ codec_type: "video", color_space: "smpte170m" }],
    });
    const graph =
      flag(
        buildCombinedSdrArgs(jobOf(sdr601), outputs) ?? [],
        "-filter_complex",
      ) ?? "";
    expect(graph.match(/zscale=/g)).toHaveLength(1);
    expect(graph.indexOf("zscale=")).toBeLessThan(graph.indexOf("split="));
  });
});

describe("poster frame selection", () => {
  // Frame 0 is black, a slate, or bars on real footage: every poster looked
  // the same and told you nothing about the clip.
  it("seeks 10% in rather than grabbing frame 0", () => {
    const job = jobOf(
      mediaInfoOf({ durationFrames: 2400, frameRateNum: 24, frameRateDen: 1 }),
    );
    expect(posterSeekSeconds(job.mediaInfo)).toBeCloseTo(10, 5);
    const args = sidecarArgs(job, "poster.png", "poster") ?? [];
    expect(flag(args, "-ss")).toBe("10");
    // Fast seek: -ss belongs before -i.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  it("picks a representative frame instead of whatever lands on the seek", () => {
    const args =
      sidecarArgs(
        jobOf(mediaInfoOf({ durationFrames: 240 })),
        "p.png",
        "poster",
      ) ?? [];
    expect(flag(args, "-vf")).toContain(
      `thumbnail=${String(POSTER_THUMBNAIL_WINDOW)},`,
    );
    expect(flag(args, "-frames:v")).toBe("1");
  });

  it("caps the seek so a long clip does not poster a minute in", () => {
    expect(
      posterSeekSeconds(
        mediaInfoOf({
          durationFrames: 24 * 3600,
          frameRateNum: 24,
          frameRateDen: 1,
        }),
      ),
    ).toBe(60);
  });

  it("stays at the start when the duration is unknown or the clip is short", () => {
    expect(posterSeekSeconds(mediaInfoOf())).toBe(0);
    const args = sidecarArgs(jobOf(mediaInfoOf()), "p.png", "poster") ?? [];
    expect(flag(args, "-ss")).toBe("0");
  });

  it("converts non-709 SDR sources to BT.709 before tagging", () => {
    const bt601 = mediaInfoOf({
      streams: [
        {
          codec_type: "video",
          color_space: "smpte170m",
          color_primaries: "smpte170m",
          color_transfer: "smpte170m",
        },
      ],
    });
    const args = buildSdrProxyArgs(jobOf(bt601), "proxy.mp4", 1080);
    expect(flag(args, "-vf")).toBe(
      `${bt709ConvertFilter(bt601)},scale=-2:1080,fps=24000/1001,format=yuv420p`,
    );
    expect(bt709ConvertFilter(bt601)).toBe(
      "zscale=matrixin=smpte170m:transferin=smpte170m:primariesin=smpte170m:matrix=709:primaries=709:transfer=709",
    );
    const tagged709 = mediaInfoOf({
      streams: [
        {
          codec_type: "video",
          color_space: "bt709",
          color_primaries: "bt709",
          color_transfer: "bt709",
        },
      ],
    });
    expect(
      flag(buildSdrProxyArgs(jobOf(tagged709), "proxy.mp4", 1080), "-vf"),
    ).toBe("scale=-2:1080,fps=24000/1001,format=yuv420p");
  });

  it("supplies a complete zscale input spec for partially-tagged 601", () => {
    // The common failing case: only the matrix is tagged (color_space=
    // smpte170m); transfer and primaries are unspecified. zscale would fail
    // with "no path between colorspaces" unless the input components are
    // supplied, so each unspecified component defaults to its SD BT.601 value.
    const partial = mediaInfoOf({
      streams: [{ codec_type: "video", color_space: "smpte170m" }],
    });
    expect(needsBt709Conversion(partial)).toBe(true);
    expect(bt709ConvertFilter(partial)).toBe(
      "zscale=matrixin=smpte170m:transferin=smpte170m:primariesin=smpte170m:matrix=709:primaries=709:transfer=709",
    );
    // A tagged component overrides its default; "unknown" is treated as blank.
    const pal = mediaInfoOf({
      streams: [
        {
          codec_type: "video",
          color_space: "bt470bg",
          color_transfer: "unknown",
          color_primaries: "bt470bg",
        },
      ],
    });
    expect(bt709ConvertFilter(pal)).toBe(
      "zscale=matrixin=bt470bg:transferin=smpte170m:primariesin=bt470bg:matrix=709:primaries=709:transfer=709",
    );
  });

  it("writes a tmcd track when the source carries a start timecode", () => {
    const args = buildSdrProxyArgs(
      jobOf(mediaInfoOf({ sourceTimecodeStart: "01:00:00:00" })),
      "proxy.mp4",
      1080,
    );
    expect(flag(args, "-timecode")).toBe("01:00:00:00");
    expect(flag(args, "-write_tmcd")).toBe("on");
    const bare = buildSdrProxyArgs(jobOf(mediaInfoOf()), "proxy.mp4", 1080);
    expect(bare).not.toContain("-write_tmcd");
  });
});

describe("HDR renditions", () => {
  it("sets a 1-second GOP for svt-av1 and x265", () => {
    const av1 = buildHdrAv1Args(jobOf(hdrMediaInfo("smpte2084")), "hdr.mp4");
    expect(flag(av1, "-g")).toBe("24");
    expect(flag(av1, "-svtav1-params")).toBe("keyint=24");
    expect(flag(av1, "-color_trc")).toBe("smpte2084");
    const hevc = buildHdrHevcArgs(jobOf(hdrMediaInfo("smpte2084")), "hdr.mp4");
    expect(flag(hevc, "-g")).toBe("24");
    expect(flag(hevc, "-x265-params")).toBe(
      "keyint=24:min-keyint=24:scenecut=0",
    );
    expect(flag(hevc, "-tag:v")).toBe("hvc1");
  });
});

describe("sidecars", () => {
  it("computes the sprite interval so one 10x10 sheet covers the duration", () => {
    expect(spriteInterval(mediaInfoOf({ durationFrames: 240 }))).toBe(2);
    const tenMinutes = mediaInfoOf({
      frameRateNum: 24,
      frameRateDen: 1,
      durationFrames: 600 * 24,
    });
    expect(spriteInterval(tenMinutes)).toBe(6);
  });

  it("pads sprite tiles to the exact 160x90 geometry the VTT declares", () => {
    const args = sidecarArgs(
      jobOf(mediaInfoOf({ durationFrames: 240 })),
      "sprite.png",
      "sprite",
    );
    expect(flag(args ?? [], "-vf")).toBe(
      "fps=1/2,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=10x10",
    );
  });

  it("tonemaps posters and sprites from HDR sources", () => {
    const job = jobOf({ ...hdrMediaInfo("arib-std-b67"), durationFrames: 240 });
    const poster = sidecarArgs(job, "poster.png", "poster");
    expect(flag(poster ?? [], "-vf")).toBe(
      `${HDR_TONEMAP_FILTER},thumbnail=100,scale=640:-2:force_original_aspect_ratio=decrease`,
    );
    const sprite = sidecarArgs(job, "sprite.png", "sprite");
    expect(
      flag(sprite ?? [], "-vf")?.startsWith(`${HDR_TONEMAP_FILTER},`),
    ).toBe(true);
  });

  it("writes VTT cues whose coordinates match the tile grid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "onelight-sprite-"));
    try {
      const job = jobOf(
        mediaInfoOf({
          frameRateNum: 24,
          frameRateDen: 1,
          durationFrames: 30 * 24,
        }),
      );
      const vttPath = await writeSpriteVtt(job, path.join(root, "sprite.png"));
      const text = await readFile(vttPath, "utf8");
      expect(text).toContain("WEBVTT");
      expect(text).toContain("sprite.png#xywh=0,0,160,90");
      expect(text).toContain("sprite.png#xywh=1440,0,160,90");
      expect(text).toContain("00:00:28.000 --> 00:00:30.000");
      const cues = text.match(/#xywh=/g) ?? [];
      expect(cues.length).toBe(15);
      expect(text).toContain("#xywh=640,90,160,90");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds a pdftoppm invocation for pdf pages", () => {
    expect(buildPdfPagesArgs("/src/deck.pdf", "/out/pages/page")).toEqual([
      "-png",
      "-r",
      "150",
      "/src/deck.pdf",
      "/out/pages/page",
    ]);
  });
});

describe("still extraction recipe", () => {
  it("uses the accurate output-seek form with -ss after -i", () => {
    const args = buildStillArgs(
      "/blobs/proxy_1080.mp4",
      "/out/still.png",
      240,
      {
        num: 24000,
        den: 1001,
      },
    );
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-ss"));
    expect(flag(args, "-frames:v")).toBe("1");
    expect(args[args.length - 1]).toBe("/out/still.png");
  });

  it("seeks half a frame early so rounding can never skip frame k", () => {
    // Frame 240 at 23.976: pts = 240 * 1001 / 24000 = 10.010 s. The target
    // is 239.5 * 1001 / 24000 = 9.989 s, strictly between frames 239 and 240.
    const args = buildStillArgs("p.mp4", "s.png", 240, {
      num: 24000,
      den: 1001,
    });
    expect(flag(args, "-ss")).toBe("9.989");
    const frameZero = buildStillArgs("p.mp4", "s.png", 0, { num: 24, den: 1 });
    expect(flag(frameZero, "-ss")).toBe("0.000");
    const pal = buildStillArgs("p.mp4", "s.png", 25, { num: 25, den: 1 });
    expect(flag(pal, "-ss")).toBe("0.980");
  });
});

describe("watermark recipe", () => {
  const tokens = {
    email: "client@example.com",
    name: "Client Name",
    share: "Cut 04 review",
    date: "2026-07-11",
  };

  it("substitutes tokens in TypeScript, never via drawtext expansion", () => {
    expect(renderWatermarkText("{name} <{email}> {share} {date}", tokens)).toBe(
      "Client Name <client@example.com> Cut 04 review 2026-07-11",
    );
    expect(renderWatermarkText("{email}", {})).toBe("");
  });

  it("escapes drawtext metacharacters by quote wrapping", () => {
    // Colons, backslashes, and newlines are inert inside a filtergraph quote
    // group; only the quote itself needs the close-escape-reopen dance.
    expect(escapeDrawtextValue("a:b")).toBe("'a:b'");
    expect(escapeDrawtextValue("back\\slash")).toBe("'back\\slash'");
    expect(escapeDrawtextValue("it's")).toBe("'it'\\''s'");
    expect(escapeDrawtextValue("two\nlines")).toBe("'two\nlines'");
  });

  it("carries hostile text through the filter intact", () => {
    const filter = buildWatermarkFilter(
      { text: "a:b 'c' \\d\ne", position: "tl" },
      {},
    );
    expect(filter).toContain(":text='a:b '\\''c'\\'' \\d\ne':");
    expect(filter).toContain("expansion=none");
  });

  it("places each corner and center position", () => {
    const at = (position: "tl" | "tr" | "bl" | "br" | "center"): string =>
      buildWatermarkFilter({ text: "x", position }, {});
    expect(at("tl")).toContain(":x=h*0.02:y=h*0.02");
    expect(at("tr")).toContain(":x=w-text_w-h*0.02:y=h*0.02");
    expect(at("bl")).toContain(":x=h*0.02:y=h-text_h-h*0.02");
    expect(at("br")).toContain(":x=w-text_w-h*0.02:y=h-text_h-h*0.02");
    expect(at("center")).toContain(":x=(w-text_w)/2:y=(h-text_h)/2");
    // Default is bottom right.
    expect(buildWatermarkFilter({ text: "x" }, {})).toContain(
      ":x=w-text_w-h*0.02:y=h-text_h-h*0.02",
    );
  });

  it("approximates tile with three diagonal drawtext placements", () => {
    const filter = buildWatermarkFilter({ text: "x", position: "tile" }, {});
    const placements = filter.split(",");
    expect(placements).toHaveLength(3);
    expect(placements[0]).toContain(":x=(w-text_w)*0.15:y=(h-text_h)*0.15");
    expect(placements[1]).toContain(":x=(w-text_w)/2:y=(h-text_h)/2");
    expect(placements[2]).toContain(":x=(w-text_w)*0.85:y=(h-text_h)*0.85");
  });

  it("applies opacity, relative size, and the optional box", () => {
    const filter = buildWatermarkFilter(
      { text: "x", opacity: 0.25, size: 0.05, box: true },
      {},
    );
    expect(filter).toContain("fontcolor=white@0.25");
    expect(filter).toContain("fontsize=54");
    expect(filter).toContain("box=1:boxcolor=black@0.35:boxborderw=18");
    const bare = buildWatermarkFilter({ text: "x" }, {});
    expect(bare).toContain("fontcolor=white@0.4");
    expect(bare).toContain("fontsize=32");
    expect(bare).not.toContain("box=1");
  });

  it("re-encodes the proxy with copied audio and BT.709 tags", () => {
    const args = buildWatermarkArgs(
      "/blobs/renditions/v1/proxy_1080.mp4",
      "/blobs/renditions/v1/watermarked-s1-h1.mp4",
      { text: "{share}", position: "br" },
      tokens,
      { num: 24000, den: 1001 },
    );
    expect(flag(args, "-i")).toBe("/blobs/renditions/v1/proxy_1080.mp4");
    expect(flag(args, "-vf")).toBe(
      `drawtext=fontfile='${DEFAULT_WATERMARK_FONTFILE}':text='Cut 04 review':expansion=none:fontsize=32:fontcolor=white@0.4:x=w-text_w-h*0.02:y=h-text_h-h*0.02,format=yuv420p`,
    );
    expect(flag(args, "-c:v")).toBe("libx264");
    expect(flag(args, "-c:a")).toBe("copy");
    expect(flag(args, "-g")).toBe("24");
    expect(flag(args, "-colorspace")).toBe("bt709");
    expect(args[args.length - 1]).toBe(
      "/blobs/renditions/v1/watermarked-s1-h1.mp4",
    );
  });
});

describe("rendition planning per asset kind", () => {
  it("plans the full ladder plus sidecars for video", () => {
    const uhd = mediaInfoOf({
      streams: [{ codec_type: "video", width: 3840 }, { codec_type: "audio" }],
    });
    const kinds = planRenditions("video", uhd).map((entry) => entry.kind);
    expect(kinds).toEqual([
      "proxy_2160",
      "proxy_1080",
      "proxy_540",
      "poster",
      "sprite",
      "waveform_data",
      "shuttle_audio_2x",
      "shuttle_audio_4x",
    ]);
    const hd = mediaInfoOf({
      streams: [{ codec_type: "video", width: 1920 }],
    });
    expect(planRenditions("video", hd).map((entry) => entry.kind)).toEqual([
      "proxy_1080",
      "proxy_540",
      "poster",
      "sprite",
    ]);
    const heights = Object.fromEntries(
      planRenditions("video", uhd)
        .filter((entry) => entry.height !== undefined)
        .map((entry) => [entry.kind, entry.height]),
    );
    expect(heights).toEqual({
      proxy_2160: 2160,
      proxy_1080: 1080,
      proxy_540: 540,
    });
  });

  it("adds HDR renditions only for HDR sources", () => {
    const hdr = {
      ...hdrMediaInfo("smpte2084"),
      streams: [
        {
          codec_type: "video",
          width: 3840,
          color_transfer: "smpte2084",
        },
      ],
    };
    const kinds = planRenditions("video", hdr).map((entry) => entry.kind);
    expect(kinds).toContain("hdr_av1");
    expect(kinds).toContain("hdr_hevc");
  });

  it("plans audio, image, and pdf assets without a video map", () => {
    expect(planRenditions("audio", mediaInfoOf())).toEqual([
      { kind: "proxy_audio", filename: "proxy_audio.m4a" },
      { kind: "shuttle_audio_2x", filename: "shuttle_audio_2x.m4a" },
      { kind: "shuttle_audio_4x", filename: "shuttle_audio_4x.m4a" },
      { kind: "waveform_data", filename: "waveform.dat" },
      { kind: "spectrogram", filename: "spectrogram.png" },
      { kind: "poster", filename: "poster.png" },
    ]);
    expect(planRenditions("image", mediaInfoOf()).map((e) => e.kind)).toEqual([
      "still_tiles",
      "poster",
    ]);
    expect(planRenditions("pdf", mediaInfoOf())).toEqual([
      { kind: "pdf_pages", filename: "pages/page" },
    ]);
    expect(planRenditions("file", mediaInfoOf())).toEqual([]);
  });

  it("declares the primary readiness rendition per kind", () => {
    expect(primaryRenditionKinds("video")).toEqual(["proxy_1080"]);
    expect(primaryRenditionKinds("audio")).toEqual([
      "proxy_audio",
      "audio_peaks",
    ]);
    expect(primaryRenditionKinds("image")).toEqual(["still_tiles", "poster"]);
    expect(primaryRenditionKinds("pdf")).toEqual(["pdf_pages"]);
  });
});

describe("audio sidecars", () => {
  const audioInfo = (channels = 2, duration?: number): MediaInfo => ({
    ...mediaInfoOf({
      format: duration === undefined ? {} : { duration: String(duration) },
      streams: [{ codec_type: "audio", channels }],
    }),
    /* An audio source is probed without a picture, so it reaches the sidecar
       builders with the nominal timebase, not a video rate. */
    frameRateNum: 60,
    frameRateDen: 1,
  });

  it("gives an audio source a nominal 60 fps timebase", () => {
    const probed = normalizeProbe({
      format: { duration: "125.5" },
      streams: [{ codec_type: "audio", channels: 2 }],
    });
    expect(probed.frameRateNum).toBe(60);
    expect(probed.frameRateDen).toBe(1);
    expect(probed.nominalRate).toBe(true);
    expect(probed.durationFrames).toBe(7530);
    /* A source with picture keeps the rate it actually has. */
    const video = normalizeProbe({
      format: { duration: "10" },
      streams: [
        { codec_type: "video", avg_frame_rate: "24/1", nb_frames: "240" },
        { codec_type: "audio" },
      ],
    });
    expect(video.frameRateNum).toBe(24);
    expect(video.nominalRate).toBeUndefined();
    /* A still is not audio and gets no invented timebase. */
    expect(
      normalizeProbe({ format: {}, streams: [] }).nominalRate,
    ).toBeUndefined();
  });

  it("knows a source with no picture in it", () => {
    expect(isAudioOnly(audioInfo())).toBe(true);
    expect(
      isAudioOnly(
        mediaInfoOf({
          streams: [{ codec_type: "video" }, { codec_type: "audio" }],
        }),
      ),
    ).toBe(false);
    /* A PDF or a still has neither stream and is not audio either. */
    expect(isAudioOnly(mediaInfoOf())).toBe(false);
  });

  it("encodes a stereo AAC proxy and drops cover art", () => {
    const args = sidecarArgs(
      jobOf(audioInfo()),
      "/out/proxy_audio.m4a",
      "proxy_audio",
    );
    expect(args).toBeDefined();
    expect(args).toContain("-vn");
    expect(flag(args ?? [], "-c:a")).toBe("aac");
    expect(flag(args ?? [], "-b:a")).toBe("192k");
    expect(flag(args ?? [], "-ac")).toBe("2");
    expect(args?.[args.length - 1]).toBe("/out/proxy_audio.m4a");
  });

  it("encodes pitch-corrected 2x and 4x shuttle sidecars", () => {
    const twice = sidecarArgs(
      jobOf(audioInfo()),
      "/out/shuttle_audio_2x.m4a",
      "shuttle_audio_2x",
    );
    const fourTimes = sidecarArgs(
      jobOf(audioInfo()),
      "/out/shuttle_audio_4x.m4a",
      "shuttle_audio_4x",
    );
    expect(flag(twice ?? [], "-filter:a")).toBe("atempo=2");
    expect(flag(fourTimes ?? [], "-filter:a")).toBe("atempo=2,atempo=2");
    for (const args of [twice, fourTimes]) {
      expect(args).toContain("-vn");
      expect(flag(args ?? [], "-c:a")).toBe("aac");
      expect(flag(args ?? [], "-profile:a")).toBe("aac_low");
      expect(flag(args ?? [], "-b:a")).toBe("64k");
      expect(flag(args ?? [], "-ac")).toBe("2");
      expect(flag(args ?? [], "-ar")).toBe("48000");
      expect(flag(args ?? [], "-map_metadata")).toBe("-1");
      expect(flag(args ?? [], "-map_chapters")).toBe("-1");
    }
  });

  it("renders the spectrogram as luminance on log axes", () => {
    const args = sidecarArgs(
      jobOf(audioInfo()),
      "/out/spectrogram.png",
      "spectrogram",
    );
    const filter = flag(args ?? [], "-filter_complex") ?? "";
    expect(filter).toContain("showspectrumpic");
    expect(filter).toContain("scale=log");
    expect(filter).toContain("fscale=log");
    /* Gray, so the player picks the colour, not ffmpeg. */
    expect(filter).toContain("format=gray");
    expect(filter).toContain("legend=0");
  });

  it("draws the poster from the sound when there is no picture", () => {
    const audio = sidecarArgs(jobOf(audioInfo()), "/out/poster.png", "poster");
    const filter = flag(audio ?? [], "-filter_complex") ?? "";
    expect(filter).toContain("showwavespic");
    expect(filter).toContain("overlay");
    /* A video source keeps the frame-grab poster it always had. */
    const video = sidecarArgs(
      jobOf(mediaInfoOf({ streams: [{ codec_type: "video", width: 1920 }] })),
      "/out/poster.png",
      "poster",
    );
    expect(flag(video ?? [], "-vf")).toContain("thumbnail=");
  });

  it("asks the decoder for raw interleaved PCM on stdout", () => {
    const args = peaksPcmArgs("source.wav", 2);
    expect(flag(args, "-f")).toBe("s16le");
    expect(flag(args, "-ar")).toBe("48000");
    expect(flag(args, "-ac")).toBe("2");
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  it("folds a surround source down to stereo and mono to mono", () => {
    expect(peaksChannels(audioInfo(6))).toBe(2);
    expect(peaksChannels(audioInfo(2))).toBe(2);
    expect(peaksChannels(audioInfo(1))).toBe(1);
  });

  it("caps the sidecar size on long files instead of growing forever", () => {
    /* Five minutes: the plain 200 points per second rate. */
    expect(peaksSamplesPerPixel(48000, 300)).toBe(240);
    /* Three hours would be two million points at that rate; it is capped. */
    const long = peaksSamplesPerPixel(48000, 3 * 3600);
    expect((3 * 3600 * 48000) / long).toBeLessThanOrEqual(120_000);
    expect(long).toBeGreaterThan(240);
    /* Unknown duration still produces a sane bucket. */
    expect(peaksSamplesPerPixel(48000, 0)).toBe(240);
  });

  it("reduces PCM to min/max pairs per channel", () => {
    const pcm = new Int16Array([
      // bucket 0: L -100..300, R -50..50
      -100, -50, 300, 50,
      // bucket 1: L 0..0, R -32768..1000
      0, -32768, 0, 1000,
    ]);
    const collector = createPeakCollector(2, 2);
    collector.push(new Uint8Array(pcm.buffer));
    const { samples, length } = collector.finish();
    expect(length).toBe(2);
    expect(samples[0]).toBeCloseTo(-100 / 32768, 6);
    expect(samples[1]).toBeCloseTo(300 / 32768, 6);
    expect(samples[2]).toBeCloseTo(-50 / 32768, 6);
    expect(samples[3]).toBeCloseTo(50 / 32768, 6);
    expect(samples[6]).toBeCloseTo(-1, 6);
    expect(samples[7]).toBeCloseTo(1000 / 32768, 6);
  });

  it("gives the same answer however the pipe splits the bytes", () => {
    const pcm = new Int16Array(64);
    for (let index = 0; index < pcm.length; index += 1)
      pcm[index] = Math.round(20000 * Math.sin(index / 3));
    const bytes = new Uint8Array(pcm.buffer);
    const whole = createPeakCollector(2, 5);
    whole.push(bytes);
    const expected = whole.finish();
    /* Odd split sizes cut sample frames and even single samples in half. */
    for (const size of [1, 3, 7, 13]) {
      const split = createPeakCollector(2, 5);
      for (let at = 0; at < bytes.length; at += size)
        split.push(bytes.subarray(at, Math.min(bytes.length, at + size)));
      const actual = split.finish();
      expect(actual.length).toBe(expected.length);
      expect(Array.from(actual.samples)).toEqual(Array.from(expected.samples));
    }
  });

  it("keeps a partly filled last bucket", () => {
    const pcm = new Int16Array([1000, -1000, 500]);
    const collector = createPeakCollector(1, 2);
    collector.push(new Uint8Array(pcm.buffer));
    const { length, samples } = collector.finish();
    expect(length).toBe(2);
    expect(samples[2]).toBeCloseTo(0, 6);
    expect(samples[3]).toBeCloseTo(500 / 32768, 6);
  });
});
