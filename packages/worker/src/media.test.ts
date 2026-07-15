import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MediaInfo, TranscodeJob } from "@onelight/core";
import {
  DEFAULT_WATERMARK_FONTFILE,
  HDR_TONEMAP_FILTER,
  VAAPI_DEVICE_ENV,
  VULKAN_HWDEVICE_ARGS,
  bt709ConvertFilter,
  buildHdrAv1Args,
  buildHdrHevcArgs,
  buildPdfPagesArgs,
  buildSdrProxyArgs,
  buildStillArgs,
  buildWatermarkArgs,
  buildWatermarkFilter,
  canUseVaapi,
  clampToSupportedRate,
  escapeDrawtextValue,
  needsBt709Conversion,
  normalizeProbe,
  parseRational,
  planRenditions,
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
      `${HDR_TONEMAP_FILTER},scale=640:-2:force_original_aspect_ratio=decrease`,
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
      "audio_peaks",
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
      { kind: "audio_peaks", filename: "audio_peaks.png" },
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
    expect(primaryRenditionKinds("audio")).toEqual(["audio_peaks"]);
    expect(primaryRenditionKinds("image")).toEqual(["still_tiles", "poster"]);
    expect(primaryRenditionKinds("pdf")).toEqual(["pdf_pages"]);
  });
});
