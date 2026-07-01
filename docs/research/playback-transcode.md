# Research: browser playback and transcode pipeline state of the art (2025-2026)

Deep-research report, 2026-07-01. One of three reports underpinning `onelight_design_doc.md`. ~180 sources searched, ~80 fetched, 10 contested claims adversarially verified (10/10 confirmed). "RISK:" marks licensing landmines.

## 1. Frame-accurate playback in the browser

### 1.1 Delivery: progressive MP4 (faststart) vs fMP4/HLS via MSE

- **Progressive MP4 + `-movflags +faststart`** puts the `moov` atom (full sample table: `stts`/`stss`/`ctts`) up front, so the browser knows every sample timestamp before download completes; `currentTime` seeks land on exact sample boundaries. Simplest path to deterministic timestamps - one file, one timeline, no re-segmentation ([ffmpeg formats docs](https://ffmpeg.org/ffmpeg-formats.html)).
- **HLS/DASH via MSE** (hls.js/dash.js/Shaka; Safari plays HLS natively) buys ABR, faster startup on long assets, and CDN friendliness - but packaging can shift PTS: a documented hls.js case shows AWS MediaConvert HLS renditions offset **0.213 s** from the source MP4, corrupting seek positions ([hls.js #6649](https://github.com/video-dev/hls.js/issues/6649)). Commercial "frame-accurate" MSE players (THEOplayer, Accurate.Video) exist specifically to compensate for such offsets ([THEOplayer](https://www.theoplayer.com/blog/frame-accurate-clipping-in-hls), [Accurate.Video](https://docs.accurate.video/docs/system-overview/accurate-player-product-specification/)).
- **What frame.io does (verified):** uploads transcode to H.264 (HEVC for HDR) **MP4 proxies at 2160/1080/720/540/360p, framerate same-as-source, High profile L5.2, AAC 128k** ([frame.io support](https://support.frame.io/en/articles/13321-what-are-my-assets-converted-to-when-it-s-uploaded)). Legacy v2/v3 player served these progressive MP4s (`h264_360...h264_2160` media links + `thumb_scrub` sprites); the **V4 player (2024) moved to "standardized HLS playback" with frame-accurate seeking and hover filmstrip previews** ([frame.io V4 blog](https://blog.frame.io/2024/05/28/frame-io-v4-features-player-and-commenting/)). No public engineering writeup of their stepping mechanism exists.
- **Pragmatic recommendation:** progressive faststart MP4 as the review master (deterministic timeline, trivial frame math), HLS only if you need ABR at scale - and if you go HLS, validate PTS alignment between renditions and against frame 0.

### 1.2 requestVideoFrameCallback (rVFC)

- Provides per-composited-frame metadata: **`mediaTime`** (the frame's PTS on the `currentTime` timeline - the value to use for frame identification), `presentedFrames` (running count - diff it to detect dropped frames), `expectedDisplayTime`, `processingDuration`, width/height ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [spec](https://wicg.github.io/video-rvfc/)).
- **Use `mediaTime`, never `currentTime`**: in Chromium `currentTime` is driven by the audio clock; `mediaTime` comes from the frame's presentation timestamp ([web.dev](https://web.dev/articles/requestvideoframecallback-rvfc)).
- **Frame number math / off-by-one:** `mediaTime` is the frame's *start* PTS, and rational rates (24000/1001) through float conversion can land at `N/fps - delta`, so `floor(mediaTime*fps)` returns N-1. Robust idiom: **`frame = Math.round(mediaTime * fps)`** (equivalently floor after adding a half-frame epsilon), computed with the rational rate, never a truncated 23.98 ([W3C media-and-entertainment #4](https://github.com/w3c/media-and-entertainment/issues/4), [WICG/video-rvfc #69](https://github.com/WICG/video-rvfc/issues/69)).
- **Support is now universal**: Chrome/Edge 83+ (2020), Safari 15.4+ (2022), **Firefox 132 (Oct 2024)** ([web.dev](https://web.dev/articles/requestvideoframecallback-rvfc), [Firefox 132 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/132)).
- Caveats: best-effort API - may fire one vsync late (compare `now` vs `expectedDisplayTime`); fires at min(video fps, display Hz); Safari rVFC breaks under EME/DRM playback (video.js ships an rAF fallback, [video.js #7854](https://github.com/videojs/video.js/pull/7854)). "Safari mediaTime quantization" is unconfirmed folklore - only the DRM bug is documented.

### 1.3 Frame stepping

**(a) Seek-based (what most review tools ship):** seek to the frame *middle* - `video.currentTime = N/fps + 1/(2*fps)` - so rounding can't land on frame N-1's tail (failure mode documented in [w3c/media-and-entertainment#4](https://github.com/w3c/media-and-entertainment/issues/4)). Then **verify with rVFC**: after `seeked`, read the next callback's `mediaTime`, recompute the frame, nudge half a frame and reseek if off - exactly what the [rVFC prev/next demo](https://github.com/angrycoding/requestVideoFrameCallback-prev-next) does. Cost: each step is a full seek pipeline (demux to prior keyframe, decode forward, composite), tens-to-hundreds of ms on long-GOP H.264 - hence short GOPs in proxies (section 2.1). Firefox's `seekToNextFrame()` is non-standard/deprecated ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/seekToNextFrame)).

**(b) WebCodecs (true decode control):** demux, `VideoDecoder.configure({codec, description})` (AVCC extradata for H.264), `EncodedVideoChunk`s, `decode()`/`flush()`, draw `VideoFrame` to canvas ([Chrome WebCodecs guide](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)). You get deterministic frame indexing (count samples, no float math), instant stepping within a cached GOP, reverse play. You pay: rebuild A/V sync + audio (WebAudio), strict memory discipline (**`frame.close()` promptly** - 4K frames are tens of MB), no DRM. Demuxer ecosystem has moved past mp4box.js (serial parse, weak seeking - [mp4box.js #243](https://github.com/gpac/mp4box.js/issues/243)) to **[mediabunny](https://mediabunny.dev/)** (pure-TS, `VideoSampleSink.getSample(t)` returns the exact frame at a timestamp, pooled canvases - [sinks guide](https://mediabunny.dev/guide/media-sinks)) and [@remotion/media-parser](https://www.remotion.dev/docs/media-parser/webcodecs).

**2025-era best practice - hybrid:** keep `<video>` for realtime playback; run a WebCodecs/mediabunny sidecar for frame stepping, hover previews, and scopes.

**(c) Competitors:** frame.io V4 = HLS + frame-accurate seek (internals undocumented). **SyncSketch transcodes everything to H.264 MP4 + AAC** tuned for scrub responsiveness ([encoding settings](https://support.syncsketch.com/hc/en-us/articles/32393972829972-Encoding-Settings)); the folklore that it plays per-frame extracted images is not supported by any public source.

### 1.4 VFR, and audio scrubbing

- **VFR breaks everything** - all `frame = round(t*fps)` math presumes constant frame duration; W3C lists VFR as a blocker for time-frame conversion ([w3c #4](https://github.com/w3c/media-and-entertainment/issues/4)). Detect: `ffmpeg -i in -vf vfrdet -f null -` (fraction of non-uniform deltas, [reference](https://github.com/stoyanovgeorge/ffmpeg/wiki/Variable-Frame-Rate)) and compare ffprobe `r_frame_rate` vs `avg_frame_rate`. **Fix: always transcode proxies to CFR** (`-vf fps=24000/1001` or `-fps_mode cfr`) and derive frame counts from the proxy.
- **Audio scrubbing:** `playbackRate` + `preservesPitch` covers J-K-L shuttle (Gecko mutes outside 0.25-4x - [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/playbackRate)) but is useless for true bidirectional scrubbing. The pro-tool approach: decode the audio track once into an `AudioBuffer`, then per scrub tick fire a one-shot `AudioBufferSourceNode.start(when, offsetSec, ~20-80ms)` grain at the playhead with short gain crossfades; rate-warp grains via `playbackRate.value` (no pitch preservation exists on that node - [WebAudio #2487](https://github.com/WebAudio/web-audio-api/issues/2487)). Reverse scrub = pre-reversed buffer copy.

### 1.5 Timecode math (SMPTE ST 12-1)

- **NDF rates** (24/25/30/48/50/60): frame labels count 0..N-1, timecode == wall clock at integer rates. **23.976 counts as if 24 fps: timecode runs 0.1% slower than real time, and there is NO 23.976 drop-frame** - the discrepancy doesn't yield an integer droppable count on any minute cycle ([davidheidelberger.com](https://www.davidheidelberger.com/2010/06/10/drop-frame-timecode/)). 29.97/59.94 NDF drifts 3.6 s/hour vs wall clock ([Wikipedia SMPTE timecode](https://en.wikipedia.org/wiki/SMPTE_timecode)).
- **Drop-frame (29.97 DF):** skip frame *labels* :00 and :01 in the first second of every minute except minutes divisible by 10; semicolons signal DF; no frames are dropped. 59.94 DF drops 4 labels. Residual ~86.4 ms/day.
- **Frame to DF timecode** (Heidelberger, derived from Andrew Duncan's classic; `\` = int div, dropFrames=2 @29.97 / 4 @59.94, framesPer10Min=17982, framesPerMin=1798):

```
D = frame \ framesPer10Min ;  M = frame % framesPer10Min
frame += dropFrames*9*D + (M > dropFrames ? dropFrames*((M-dropFrames) \ framesPerMin) : 0)
// then split with timeBase 30 (or 60): ff=f%30; ss=(f\30)%60; mm=...; hh=...
```

- **DF timecode to frame:** `frame = 108000*hh + 1800*mm + 30*ss + ff - 2*(totalMinutes - totalMinutes\10)` where `totalMinutes = 60*hh+mm` (reject ff in {0,1} when ss==0 and mm%10 != 0). Both formulas verified against [davidheidelberger.com](https://www.davidheidelberger.com/2010/06/10/drop-frame-timecode/); Duncan's original (andrewduncan.net/timecodes/) has an expired TLS cert - cite via archive.
- **Implementation rule:** store positions as **integer frame indices + rational fps + source start TC**; render timecode only at display time; DF/NDF toggle for 29.97/59.94, flag inherited from source metadata.

### 1.6 Extracting source start timecode

- QuickTime/MP4 store start TC in a **`tmcd` timecode track** (ffprobe shows `codec_type: data, codec_name: tmcd`); ffmpeg mirrors it into format- and stream-level `timecode` tags. Canonical probe:

```
ffprobe -v error -show_entries format_tags=timecode:stream_tags=timecode \
        -of default=noprint_wrappers=1:nokey=1 input.mov
```

([ffmpeg-user thread with worked example](https://ffmpeg-user.ffmpeg.narkive.com/pR5AYegJ/extracting-starting-timecode-info-using-ffmpeg-ffprobe)). A `;` in the value means drop-frame.
- **MXF:** TC lives in Material Package TimecodeComponents; ffprobe surfaces a `timecode` tag but bmx (`mxf2raw`) or MediaInfo read the full picture. ARRI: MXF/ProRes header TC + ARRI Meta Extract ([ARRI metadata spec](https://www.arri.com/resource/blob/223768/21fbcf5308b408dccc485db986b37ab5/2020-11-arri-mxfprores-metadata-specification-3-0-0-10-en-data.pdf)); RED needs REDline/SDK.
- **Propagate into proxies:** `ffmpeg -i src -timecode 01:00:00;00 ...` writes a tmcd track for MOV/MP4 (`-write_tmcd auto`). Player displays `sourceStartTC + frameIndex`.

## 2. Proxy transcode pipeline

### 2.1 H.264 review proxy recipe

- **CRF 18-20** for hero review quality, 21-23 for the bandwidth ladder - the [ASWF Encoding Guidelines](https://academysoftwarefoundation.github.io/EncodingGuidelines/Encodeh264.html) (built for VFX dailies review) call CRF 23 "low quality" and recommend ~18; +/- 6 CRF is roughly half/double size ([slhck CRF guide](https://slhck.info/video/2017/02/24/crf-guide.html)).
- `-preset medium`/`slow` (ASWF: anything slower gains nothing), **`-pix_fmt yuv420p` mandatory** for browser compat, High profile (L4.1 for 1080p30, L4.2 for 1080p60; frame.io emits L5.2), `-tune film`, `-movflags +faststart`, CRF + `-maxrate/-bufsize` VBV cap.
- **Always tag color** (section 2.4): `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`.
- **GOP:** review proxies want short GOPs for snappy seek-stepping - **1-2 s (`-g 24`-`48`), `-sc_threshold 0`**; all-intra is the extreme (instant stepping, ~3-5x bitrate). HLS ladders need segment-aligned fixed GOPs.
- **Renditions:** frame.io generates discrete progressive MP4s (360 to 2160p, ~2.2/4/14 Mbps SD/HD/4K), user-switchable - not classic ABR. For a new build: single 1080p CRF-capped MP4 review master + 540p mobile rendition covers most needs.
- **Hardware encode:** NVENC does H.264/HEVC/AV1 8/10-bit at 5-15x realtime; libx264 still slightly beats h264_nvenc per-bit but the gap vanishes above ~10 Mbps 1080p ([NVIDIA app note](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-application-note/index.html)). VideoToolbox is bitrate-only (no CRF) and has reported silent 8-bit fallbacks - validate output bit depth.

### 2.2 HDR sources: preserve + tonemap (do both)

frame.io's template: **HEVC Main10 L5.1 proxy preserving source color (Rec.2100/2020/P3, HDR10 only - no Dolby Vision, no HDR10+) plus tone-mapped SDR playback for non-HDR devices** ([frame.io HDR overview](https://help.frame.io/en/articles/4305435-hdr-overview)). AV1 10-bit (SVT-AV1 or av1_nvenc) is the royalty-friendlier HDR rail for Chrome/Firefox/Edge; Safari needs the HEVC rail.

### 2.3 HDR-to-SDR tonemapping in ffmpeg

- **Classic CPU chain** (verified exact command, [gist](https://gist.github.com/goyuix/033d35846b05733d77f568b754e7c3ea)):

```
-vf zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,\
tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p
```

Linearize, float RGB, convert primaries, Hable tonemap (`desat=0` avoids the washed-out look), BT.709 limited-range yuv420p.
- **Modern: `libplacebo`** (Vulkan) does tone+gamut mapping in one pass; `tonemapping=bt.2390` is the ITU broadcast-standard EETF ([filter docs](https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/libplacebo.html), [libplacebo options](https://libplacebo.org/options/)). GPU throughput reference on 4K HDR10: zscale CPU ~10 fps, tonemap_opencl ~40 fps, NVDEC + libplacebo + NVENC 60+ fps ([32blog](https://32blog.com/en/ffmpeg/ffmpeg-hdr-to-sdr-tonemapping)).
- **HLG != PQ:** PQ is absolute (needs true tonemapping); HLG needs inverse-OOTF at the target peak - libplacebo/tonemap_opencl handle it, naive PQ-tuned zscale chains misrender HLG.
- Best practice for a colorist-facing product: prefer a **supplied 3D LUT** over auto-tonemap for the SDR derivation (YouTube's model - [YouTube HDR upload help](https://support.google.com/youtube/answer/7126552)).

### 2.4 Color pitfalls (the #1 review-tool quality bug)

Untagged video is roulette - verified per-browser ([Mux: "Your browser and my browser see different colors"](https://www.mux.com/blog/your-browser-and-my-browser-see-different-colors)): Safari assumes BT.601 regardless of resolution; Chrome/Windows guesses 601-SD/709-HD; Firefox assumes 709; Edge ignores tags. **Always write `-colorspace/-color_primaries/-color_trc/-color_range` explicitly.** Full-range (pc) mis-flagged as limited (tv) means washed out or crushed blacks ([Chromium issue 41280571](https://issues.chromium.org/issues/41280571)) - emit limited-range yuv420p. The **QuickTime gamma shift** (Apple ~1.96 vs graded 2.4 on 1-1-1-tagged Rec.709; Resolve's "Rec.709-A" tag workaround) is why Mac exports "look lifted" - QC your recipe across Safari/Chrome/QuickTime/VLC before locking it ([BMD forum megathread](https://forum.blackmagicdesign.com/viewtopic.php?t=101253), [thepostprocess.com](https://www.thepostprocess.com/2020/07/17/color-on-mac-displays-from-davinci-resolve-to-the-internet-with-quicktime-tags/)).

### 2.5 Scrub thumbnails / filmstrip sprites

One-pass ffmpeg sprite sheet: `-vf "fps=1/5,scale=128:72,tile=11x11"` ([Mux](https://www.mux.com/articles/extract-thumbnails-from-a-video-with-ffmpeg)); reference tool [rmp-create-vtt-thumbnails](https://github.com/radiantmediaplayer/rmp-create-vtt-thumbnails). Sidecar **WebVTT storyboard** cues point into the sprite via spatial media fragments (`sprite.jpg#xywh=0,0,128,72`) - the de-facto convention consumed by Shaka/Radiant/most players. Review platforms go denser (1-2 s) than streaming. Also see [mt](https://github.com/mutschler/mt) (Go, `--webvtt`).

### 2.6 Audio waveforms

**BBC [audiowaveform](https://github.com/bbc/audiowaveform)** (C++, GPL-3.0 - safe as a subprocess, don't link it) generates binary `.dat`/JSON peaks (`-b 8 -z 256` typical); **[peaks.js](https://github.com/bbc/peaks.js/)** consumes it natively with zoom levels in samples/pixel (defaults 512-4096). wavesurfer.js accepts precomputed peaks but normalizes differently - rescale ([discussion](https://github.com/katspaugh/wavesurfer.js/discussions/2769)). DIY alternative: extract PCM via ffmpeg and compute min/max buckets yourself.

### 2.7 Pro format ingest matrix

| Format | ffmpeg? | Path | Landmine |
|---|---|---|---|
| ProRes (all, incl 4444/XQ) | yes (decode); 3 encoders (`prores_ks`) | native | RISK: reverse-engineered, not Apple-certified - decoding for proxies is universal/low-risk; *selling ProRes encoding* is where Apple certification/trademark exposure lives ([Apple authorized list](https://support.apple.com/en-us/118584)) |
| DNxHD/DNxHR (MOV/MXF) | yes (decode+encode) | native | - |
| XAVC / XAVC-S / XAVC HS | yes (H.264/HEVC in MXF/MP4) | native | - |
| REDCODE R3D | no (only ancient JPEG2000-era; modern R3D undecodable - [verified](https://patchwork.ffmpeg.org/comment/49242/)) | R3D SDK (C++) or REDline CLI piped to ffmpeg | RISK HIGH: [R3D SDK license](https://www.reddigitalcinema.com/legal/red-r3d-sdk-license-agreement) permits internal dev, tight redistribution, instant termination - SaaS/cloud use not addressed; get written clearance from RED/Nikon (Nikon acquired RED, April 2024) |
| Blackmagic RAW | no (unofficial fork [ffmpeg-braw](https://github.com/adinbied/ffmpeg-braw) only; nothing merged) | free [BRAW SDK](https://www.blackmagicdesign.com/developer/products/braw) (CPU/Metal/CUDA/OpenCL); community bridge [braw-decode](https://github.com/AkBKukU/braw-decode) to ffmpeg; or headless Resolve | RISK MEDIUM: "free" but proprietary EULA; redistribution terms unverified - read the EULA in the SDK bundle; Resolve-as-server-transcoder EULA cleanliness also unverified |
| ARRIRAW | no | ARRI Reference Tool / partner-gated SDK | RISK: partner-program terms unverified |
| CinemaDNG | partial (GSoC 2019; patchy debayer) | prefer libraw/OIIO/Resolve | - |
| EXR sequences | partial (decoder lags OpenEXR - no deep data, weak multi-part) | ASWF-blessed: OCIO/ACES via `oiiotool --colorconvert acescg srgb` then ffmpeg ("FFmpeg is not a great tool for colorspace conversion" - [ASWF](https://academysoftwarefoundation.github.io/EncodingGuidelines/EncodingOverview.html)); [generate-dailies](https://github.com/jedypod/generate-dailies) is the canonical OSS tool | - |
| DPX | yes (solid) | native | - |
| PDF | n/a | pdf.js in-browser + server pdftoppm/poppler rasters | - |
| Large stills | n/a | libvips to DZI/IIIF tiles, OpenSeadragon ([guide](https://openseadragon.github.io/examples/creating-zooming-images/)) | - |
| PSD/AI/TIFF/HEIC/RAW stills | via ImageMagick/libvips/libheif/libraw | flatten to PNG/JPEG proxies (frame.io's approach) | - |

RISK: **Codec royalties (verified Dec 2025 shake-up):** Access Advance **acquired Via LA's HEVC/VVC pools on Dec 15, 2025** (renamed "VCL Advance"), consolidating HEVC licensing; its **VDP pool (Jan 2025) levies content/streaming-distribution royalties explicitly covering HEVC, VVC, AV1, and VP9** ([announcement](https://accessadvance.com/2025/12/15/access-advance-and-via-licensing-alliance-announce-hevc-vvc-program-acquisition/), [VDP pool](https://accessadvance.com/licensing-programs/vdp-pool/)). AV1 is AOM-royalty-free with a defensive patent license, but Sisvel and now the VDP pool contest the edges. **Posture: H.264 everywhere (mature, cheap, expiring patents), HEVC only where HDR forces it, monitor VDP.**

## 3. HDR playback in browsers (2025-2026)

### 3.1 Support matrix

| | HEVC | AV1 | HDR notes |
|---|---|---|---|
| Chrome/Edge | HW-decode-only, default since 107 (no software decoder; Linux needs VAAPI) - [chromestatus](https://chromestatus.com/feature/5186511939567616), [StaZhu tracker](https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding) | Full since 70 (Edge re-added in 121 after dropping in 116-120 - [caniuse](https://caniuse.com/av1)) | HDR10 (PQ static) + HLG; HDR10+ SEI ignored, treated as HDR10. Widevine L1 HEVC Windows-only; DV P8/9 play as plain base layer |
| Safari | Full since 11 (sw+hw) | 17+, hardware-only: A17 Pro / M3+ / M4 iPad - no software AV1 decoder as of 2026 ([Bitmovin](https://bitmovin.com/blog/apple-av1-support/)) | HDR10, HLG, Dolby Vision (HLS); DV Profile 10 (AV1) on capable HW |
| Firefox | OS-decoder passthrough, default 134 (Win) / 136 (macOS) / 137 (Linux/Android) ([Mozilla](https://support.mozilla.org/en-US/kb/audio-and-video-firefox)) | Full since 67 | Verified caveat: "HEVC 10-bit HDR videos are supported, but currently Firefox won't render them properly" - treat Firefox as SDR-only (experimental HDR only in Nightly 148, Jan 2026) |

### 3.2 Signaling

- **`hvc1` vs `hev1`** (verified): Apple's stack only plays `hvc1` (parameter sets in the sample entry) - always package/remux with `-tag:v hvc1` ([Apple forum](https://developer.apple.com/forums/thread/132293), [Bitmovin](https://community.bitmovin.com/t/whats-the-difference-between-hvc1-and-hev1-hevc-codec-tags-for-fmp4/101)). Chrome 120+ MSE errors on init-segment/codec-string mismatch ([go2rtc #2205](https://github.com/AlexxIT/go2rtc/issues/2205)).
- **AV1 codec string carries full color info**: HDR10 = `av01.0.05M.10.0.110.09.16.09.0` (cp=09 BT.2020, tc=16 PQ, mc=09; tc=18 = HLG) ([Jake Archibald](https://jakearchibald.com/2022/html-codecs-parameter-for-av1/), [AV1-ISOBMFF](https://aomediacodec.github.io/av1-isobmff/)). HEVC Main10 ~ `hvc1.2.4.L153.B0`. Container: `colr` (nclx) + `mdcv`/`clli` boxes / HEVC SEI carry ST 2086 static metadata; per-browser precedence between them is not uniformly documented.

### 3.3 Capability + display detection (both are required)

- `mediaCapabilities.decodingInfo()` with `hdrMetadataType` ('smpteSt2086'|'smpteSt2094-10'|'smpteSt2094-40'), `colorGamut`, `transferFunction` - implemented in Chrome (121+) and Safari; Firefox: not started ([W3C HDR explainer](https://github.com/w3c/media-capabilities/blob/main/hdr_explainer.md)).
- **Verified gotcha:** Chrome **always returns `supported:true` for smpteSt2086 even on SDR displays** (it tone-maps internally) and false for 2094-10/-40 ([Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/0neM-5GDn8I)). So decodingInfo answers "can decode somehow," not "will show HDR."
- **Therefore gate on display too:** `matchMedia('(dynamic-range: high)')` (Chrome/Edge 98+, Firefox 100+, Safari 13.1+ - [caniuse](https://caniuse.com/mdn-css_at-rules_media_dynamic-range)) + `change` listener for monitor moves. `video-dynamic-range` is patchier; `screen.colorDepth` is useless for HDR (commonly reports 24). `screen.colorInfo`/HDR-headroom APIs are still [ColorWeb-CG proposals](https://github.com/w3c/ColorWeb-CG/blob/main/hdr_html_canvas_element.md), not shipped.

### 3.4 Canvas + HDR (the annotation problem)

- True HDR 2D canvas (`rec2100-pq`/`rec2100-hlg`) is still proposal/flag-only everywhere ([ColorWeb-CG](https://github.com/w3c/ColorWeb-CG/blob/main/hdr_html_canvas_element.md)); `colorSpace:'display-p3'` is wide-gamut, not HDR; float16 canvas backing shipped in Chromium (option renamed `pixelFormat` in 133) but doesn't alone put nits on screen.
- **The shipped HDR path is WebGPU**: Chrome 129's `toneMapping: { mode: 'extended' }` on an `rgba16float` canvas draws into EDR headroom ([Chrome blog](https://developer.chrome.com/blog/new-in-webgpu-129)). WebCodecs HDR `VideoFrame` to 2D canvas yields tone-mapped SDR; the zero-copy HDR route is WebGPU `importExternalTexture()` + your own PQ/HLG shader math ([gpuweb #4384](https://github.com/gpuweb/gpuweb/discussions/4384)).
- **Practical architecture: don't route HDR video through canvas.** Play HDR in a plain `<video>` (compositor handles PQ/HLG correctly in Chrome/Safari) and draw annotations on a transparent SDR canvas layered above - SDR-over-HDR compositing works today. Reach for WebGPU only for scopes/false-color of HDR pixels.
- **Platform strategy (what everyone converges on):** frame.io serves HDR HEVC where playable, tone-maps to SDR elsewhere, supports no DV/HDR10+, and concedes accurate web color review is hard (points users at iPhone/iPad - [frame.io HDR overview](https://help.frame.io/en/articles/4305435-hdr-overview)). The gate: `decodingInfo(pq + smpteSt2086) && matchMedia('(dynamic-range: high)')`; Firefox: SDR unconditionally; label the fallback "SDR preview (tone-mapped)".

## 4. Resumable large uploads

### 4.1 tus vs direct-to-storage

- **tus 1.0** ([spec](https://tus.io/protocols/resumable-upload)): POST-create, `PATCH` with `Upload-Offset`, `HEAD` to resume from exact byte; extensions for expiration, per-PATCH checksums (`Upload-Checksum`), parallel concatenation. [tusd](https://github.com/tus/tusd) (Go) is the reference server with S3/GCS backends. Tradeoff: byte-exact resume but your server proxies every byte; Cloudflare-proxied PATCHes also hit per-request body limits (~100 MB Free).
- **IETF successor "RUFH"** ([draft-ietf-httpbis-resumable-upload](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-resumable-upload), at -11, March 2026, still not an RFC): normal POST/PUT becomes resumable via `Upload-Complete` + interim `104 Upload Resumption Supported`. Apple ships OS-level client support (URLSession); no browser-native client yet ([implementations](https://github.com/tus/rufh-implementations)). Watch it, don't build on it yet.
- **Direct-to-S3 multipart (the industry default, incl. frame.io):** backend `CreateMultipartUpload`, presigned per-part `UploadPart` URLs, browser PUTs `file.slice()` chunks in parallel (CORS must expose `ETag`), `CompleteMultipartUpload`; **resume = `ListParts` and skip what's there** (S3 is the source of truth across page reloads). frame.io's device/API upload is exactly this ([frame.io dev docs](https://developer.frame.io/docs/device-integrations/how-to-basic-upload)). MASV is many-parallel-TCP + edge ingest, explicitly not UDP ([whitepaper](https://massive.io/whitepapers/masv-file-transfer-acceleration/)); browsers can't do raw UDP anyway.
- **Client:** [Uppy `@uppy/aws-s3`](https://uppy.io/docs/aws-s3/) (`shouldUseMultipart` defaults to files > 100 MiB; you implement `createMultipartUpload/signPart/listParts/complete/abort`).

### 4.2 Limits and quirks (verified)

- **S3:** parts 5 MiB-5 GiB, 10,000 parts; **max object now 48.8 TiB** (raised from 5 TiB, announced Dec 2, 2025 - [AWS](https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-maximum-object-size-50-tb/), [docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)). Cost landmine: abandoned multipart parts bill as storage forever and are invisible to listing - set an `AbortIncompleteMultipartUpload` lifecycle rule (e.g. 7 days) on day one ([AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html)).
- **R2:** object max ~5 TiB (4.995), parts 5 MiB-5 GiB, 10k parts, and - verified quirk - **all parts except the last MUST be equal size** ([R2 multipart docs](https://developers.cloudflare.com/r2/objects/multipart-objects/)); pick a fixed chunk and never vary it within an upload. Incomplete MPUs auto-abort after 7 days by default. Presigned URLs: S3-API domain only, no POST-policy uploads, max 7-day expiry ([docs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)); presigned `UploadPart` works (standard Uppy-on-R2 pattern - [Transloadit guide](https://transloadit.com/devtips/browser-uploads-to-cloudflare-r2-with-aws-sdk/)).

### 4.3 Checksums

- S3 supports ten algorithms - CRC64NVME (default, computed server-side since Dec 2024), CRC32/CRC32C, SHA-1/SHA-256, plus MD5/XXHash3/64/128/SHA-512 added April 2026 ([announcement](https://aws.amazon.com/about-aws/whats-new/2026/04/s3-five-additional-checksum-algorithms/), [integrity docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)).
- **Key design fact:** only CRC-family checksums linearize, so **full-object checksums on multipart uploads require CRC32/CRC32C/CRC64NVME** (declare `x-amz-checksum-type: FULL_OBJECT` at create); SHA-family is composite-only. **ETag != MD5** for any multipart or KMS object - never treat it as a content hash.
- **Browser hashing:** `crypto.subtle.digest()` is one-shot - no streaming - so it can't hash a 50 GB file; use **[hash-wasm](https://github.com/Daninet/hash-wasm)** (incremental WASM, hash-state save/restore for cross-session resume) in a Web Worker on the same pass as slicing. Prefer CRC32C/CRC64NVME over SHA-256 for transit integrity.

### 4.4 Folder uploads (camera cards, 10k-frame sequences)

- `<input webkitdirectory>` is Baseline as of Aug 2025 (all engines, desktop) - flat `FileList` + `webkitRelativePath`; empty dirs omitted; no enumeration progress (100k-file cards stall the picker) ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory)).
- Drag-drop: `webkitGetAsEntry()` recursion - Chromium's `readEntries()` returns max 100 entries per call; loop until empty.
- **File System Access API (`showDirectoryPicker`) remains Chromium-only** - Mozilla marked it harmful, Safari ships only OPFS ([caniuse](https://caniuse.com/native-filesystem-api)). Where available it's strictly better for huge trees: lazy iteration, persistent handles (resume a folder upload after browser restart). Feature-detect, fall back.
- Sequence strategy: multipart only for big files, batch presigning (100-500 keys/call), bounded global concurrency (~5-10 in flight), manifest-first design (client posts file list, server returns keys+URLs, resume-by-diff), sanitize client-supplied `webkitRelativePath` before using as object keys.

## 5. Annotation / drawing over video

### 5.1 Architecture

- Consensus: absolutely-positioned transparent canvas over `<video>`, redrawn per frame via rVFC (`mediaTime` to frame number). Store coordinates **normalized 0-1 against `videoWidth/videoHeight`**, and at render time compute the `object-fit: contain` content rect (`scale = min(elemW/videoW, elemH/videoH)`, centered offsets) - mismatched spaces are the classic mispositioned-annotation bug. Size backing store by `devicePixelRatio`.
- Ink: **[perfect-freehand](https://github.com/steveruizok/perfect-freehand)** (pressure-sensitive `[x,y,pressure]` to deterministic outline polygon; used by tldraw/Excalidraw/Canva) if building lean; **[tldraw](https://github.com/tldraw/tldraw)** is production-proven as a video-annotation overlay (Jam.dev built theirs on it - [writeup](https://jam.dev/blog/how-we-built-video-annotations-w-tldraw/); note tldraw SDK license key requirement - free-with-watermark or paid). Konva over Fabric for many-object annotation scenes.
- OSS review players worth studying: [Clapshot](https://github.com/elonen/clapshot) (Rust+Svelte, real-time mirrored playback/drawing - closest OSS frame.io analog), [FreeFrame](https://github.com/Techiebutler/freeframe), [FrameTrail](https://frametrail.org/), [VGG VIA 3](https://www.robots.ox.ac.uk/~vgg/software/via/).

### 5.2 Data model

- Anchor to integer frame + rational fps + source start TC (never wall-clock seconds), optional out-frame for ranges; per-page for PDFs. This is exactly what EDL export requires - Resolve import misaligns unless the timeline start TC matches ([frame.io Resolve import guide](https://help.frame.io/en/articles/4128691-import-comments-into-resolve-with-edl)).
- Strokes: raw point arrays `[x, y, pressure, t]` + tool metadata; perfect-freehand's determinism means storing input points (not rasters) reproduces identical ink everywhere - and lets you share one normalized-space renderer between browser and server burn-in.
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) (Media Fragments `#t=npt:10,20` + `#xywh=`) is a fine interchange serialization but `t=npt` is seconds-based, not frame-accurate - keep frames as the internal truth.
- **Verified gap = differentiation opportunity:** frame.io does NOT carry comments forward across versions - official guidance is copy/paste ([frame.io](https://help.frame.io/en/articles/1711085-how-to-copy-and-paste-comments-legacy)). Auto re-anchoring across cuts (EDL diff / perceptual frame matching) would exceed the market leader.

### 5.3 Export formats (exact syntax)

**DaVinci Resolve - marker EDL** (imported via Timelines > Import > Timeline Markers from EDL; format verified from two working converter codebases: [XlsToResolveEdl](https://github.com/snorkem/XlsToResolveEdl), [X-Raym REAPER script](https://github.com/X-Raym/REAPER-ReaScripts/blob/master/Regions/X-Raym_Export%20markers%20and%20regions%20as%20Davinci%20Resolve%20EDL%20file.lua)):

```
TITLE: Review_Comments
FCM: NON-DROP FRAME

001  001      V     C        01:00:05:00 01:00:05:01 01:00:05:00 01:00:05:01
 |C:ResolveColorBlue |M:Comment text here |D:1
```

Colors: `ResolveColorBlue/Red/Yellow/Green/Cyan/Purple/Pink/Fuchsia...`. Gotchas (from Kollaborate, who ship this): Resolve drops notes starting with a digit (prefix `_`), ASCII only (strip emoji), overlapping same-frame markers collapse to the first ([Kollaborate help](https://www.kollaborate.tv/help/Comments/Importing_Comments)).

**Avid Media Composer** - Tools > Markers > Import, accepts (a) tab-separated .txt: `name <TAB> timecode <TAB> track(V1/A1/TC1) <TAB> color <TAB> comment` (+ observed trailing numeric field - semantics unverified; round-trip a real MC export before shipping), or (b) Avid Marker XML - what frame.io actually emits (schema not public) ([frame.io Avid export article](http://support.frame.io/en/articles/706299-export-comments-to-avid-media-composer-legacy), [parser reference](https://github.com/Iddos-l/resolve_import_avid_markers)).

**Premiere Pro** - no native CSV import; sequence markers arrive via FCP7 XML (xmeml) import ([Adobe](https://helpx.adobe.com/premiere-pro/using/importing-xml-project-files-final.html)); frame.io's real Premiere path is its panel extension. Third-party: Markerbox.

**FCPX - FCPXML**: `<marker start="43703/29s" duration="1/29s" value="note"/>` - rational-seconds time, child of the clip element ([Apple FCPXML docs](https://developer.apple.com/documentation/professional-video-applications/describing-final-cut-pro-items-in-fcpxml), [fcp.cafe](https://fcp.cafe/developers/fcpxml/)).

**Ground truth to match - frame.io's export menu:** CSV, plain text, FCPX (fcpxml), Avid Marker XML, Resolve EDL, and PDF "Print Comments" with per-comment frame grab including composited annotations ([frame.io](https://help.frame.io/en/articles/9105309-comment-printing-and-comment-exporting)). Exports respect active comment filters - replicate that deliberately. Reference converter to diff against: [editingtools.io/marker](https://editingtools.io/marker/).

### 5.4 Burn-in export

Share the normalized-coords stroke renderer between browser and Node; render annotated frames with node-canvas or skia-canvas (Skia ~ Chrome rendering, fewer AA/font diffs), pipe into ffmpeg (`-f image2pipe`) or composite transparent PNGs with `overlay=enable='between(t,in,out)'` over only the annotated ranges ([Creatomate tutorial](https://creatomate.com/blog/video-rendering-with-nodejs-and-ffmpeg), [Konva server rendering](https://leanylabs.com/blog/node-videos-konva/)). PDF reports: HTML via Puppeteer, frame grabs via `ffmpeg -ss t -frames:v 1`.

## 6. Real-time collaboration

### 6.1 Comments transport

- **SSE is the 2025-2026 sweet spot for comment feeds**: the HTTP/1.1 6-connection objection is dead under HTTP/2/3 multiplexing ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)); auto-reconnect + `Last-Event-ID` resume built in; proxy/firewall-friendly ([Ably comparison](https://ably.com/blog/websockets-vs-sse)). Native `EventSource` can't send auth headers - use [@microsoft/fetch-event-source](https://github.com/Azure/fetch-event-source) or hand-roll over fetch streams. Writes go over normal REST anyway.
- **Presence forces long-lived bidirectional infra.** Options: self-hosted WS + Redis pub/sub; Cloudflare Durable Objects with WebSocket Hibernation (one DO per review room - [docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)); Supabase Realtime; Ably/Liveblocks managed. Precedent: frame.io rewrote its backend in Elixir/Phoenix (2018) precisely for live comments/presence ([frame.io engineering](https://medium.com/frame-io-engineering/elixir-open-source-frame-io-849f4b1ebd9a)).
- **CRDTs are overkill for comments** (single-author, LWW). They earn their keep only for simultaneous multi-user drawing on one canvas ([Yjs](https://github.com/yjs/yjs) - `Y.Map` of strokes; Yjs "awareness" for ephemeral in-progress ink) or co-edited rich-text notes.

### 6.2 Watch-together synced playback

- **Reference architecture** (Syncplay / Jellyfin SyncPlay consensus): leader (or server) owns `{playing, mediaTime, atServerTime, rate}`; broadcasts events + a ~1 s state tick; followers compute expected position and apply two-tier correction - playbackRate nudging for small drift, hard seek for large ([Jellyfin SyncPlay reference](https://mhbxyz.github.io/OpenWatchParty/technical/jellyfin-syncplay-reference/)).
- **Verified shipped constants** ([Syncplay constants.py](https://raw.githubusercontent.com/Syncplay/syncplay/master/syncplay/constants.py)): `SLOWDOWN_RATE=0.95`, nudge kicks in at 1.5 s drift, resets within 0.1 s, hard rewind at 4 s, fast-forward at 5 s. Those are desktop-tolerant; for browser review sessions target tighter: dead zone under ~100 ms, rate 0.95-1.05 nudge to ~1-2 s, hard seek beyond. At 24 fps one frame = 41.7 ms, so 1-3 frames is the meaningful precision band.
- **Clock sync**: NTP-style ping-pong over the existing WS (`offset = t_server - t0 - RTT/2`, median of N samples, resample ~60 s) - [timesync](https://github.com/enmasseio/timesync); ~1 ms precision achievable.
- **Two delivery architectures**: (a) everyone plays the same HLS/MP4 + control-plane sync - cheap, any room size, needs the drift machinery (the default); (b) one real-time composited stream (WebRTC/SRT - Evercast under 100 ms claimed, ClearView Flex) - frame-identical viewing for color-critical sessions, expensive per-session. frame.io has no native watch-together; SyncSketch is the strongest prior art - fully synced playback/scrubbing/drawing with a Presentation Mode leader ([SyncSketch docs](https://support.syncsketch.com/hc/en-us/articles/32393989404564-How-do-real-time-Reviews-Work), used in [Netflix VFX workflows](https://partnerhelp.netflixstudios.com/hc/en-us/articles/4403574612627-SyncSketch-for-VFX-Reviews)).

## Licensing landmine summary

| Item | Risk | Action |
|---|---|---|
| R3D SDK - SaaS/cloud use unaddressed; strict redistribution; instant termination clause | High | Written clearance from RED/Nikon before building R3D ingest ([license](https://www.reddigitalcinema.com/legal/red-r3d-sdk-license-agreement)) |
| HEVC royalties - Access Advance absorbed Via LA's pools (Dec 2025); VDP pool charges streaming-distribution royalties on HEVC/VVC/AV1/VP9 content | High at scale | H.264 default; HEVC only where HDR requires; legal review of VDP exposure ([VDP pool](https://accessadvance.com/licensing-programs/vdp-pool/)) |
| BRAW SDK - free but proprietary EULA; redistribution terms unverified; headless-Resolve-as-transcoder EULA also unverified | Medium | Read the EULA in the SDK bundle; don't assume |
| ffmpeg ProRes - reverse-engineered; decode-for-proxies is universal practice, encoding as a service carries Apple certification/trademark exposure | Medium | Decode freely; get certified if you ever emit ProRes ([Apple](https://support.apple.com/en-us/118584)) |
| AV1 - AOM royalty-free but Sisvel + VDP assert patents at the edges | Low-Med | Monitor; still the best royalty posture |
| audiowaveform (GPL-3.0), tldraw (license key) | Low | Subprocess-only for GPL; budget tldraw license or use perfect-freehand |
| S3 incomplete multipart storage billing | Cost, not legal | Lifecycle abort rule day one (R2 auto-aborts at 7 days) |

## Recommended stack (one paragraph)

Ingest via Uppy presigned multipart direct to S3/R2 (fixed parts per upload on R2, CRC32C full-object checksums via hash-wasm in a worker, lifecycle abort rules, `showDirectoryPicker` with `webkitdirectory` fallback); transcode with ffmpeg to CFR progressive faststart MP4 - H.264 High CRF 18-20, yuv420p, 1-2 s GOP, explicit BT.709/tv tags, `-timecode` copied from the source tmcd - plus HEVC Main10 `hvc1` and/or AV1 10-bit HDR renditions gated by `decodingInfo` + `(dynamic-range: high)` with a libplacebo bt.2390 SDR fallback; sprite-sheet WebVTT storyboards and audiowaveform peaks as sidecars; play in `<video>` with rVFC (`round(mediaTime x fps)`) for frame display, seek-to-frame-middle + rVFC-verify for stepping (WebCodecs/mediabunny sidecar for power stepping); transparent canvas overlay with normalized coords + perfect-freehand, exporting Resolve marker EDL / Avid marker text-XML / xmeml / FCPXML / PDF; SSE for comment feeds, one Durable-Object-or-ws room per asset for presence and Syncplay-style synced playback (rate-nudge 0.95-1.05, hard seek past 1-2 s, NTP-over-WS clock sync).
