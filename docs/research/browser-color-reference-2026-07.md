# Browser color and reference playback research

Deep-research update, 2026-07-23. This narrows the browser color work in
`docs/research/playback-transcode.md` into an implementable boundary. The
question is not whether current browsers can usually present tagged Rec.709
correctly. They can. The question is which parts of the path Onelight can own
when a browser, operating system, decoder, or display transform does something
different.

## Findings

### 1. Correct source and rendition metadata remains the first line of defense

Apple documents that AVFoundation and ColorSync transform from the media color
tags to the display ICC profile during playback. The display profile and
viewing transform can therefore produce different framebuffer values on two
Macs even when both are behaving as designed. Apple also says untagged media is
generally treated as SD color. This is why a browser-only compensation table
would be wrong: the apparent difference may belong to the display transform,
not the decoder.

Onelight now retains the complete ffprobe record, an explicit source-color
summary, the exact measured rational frame rate, and the source of the chosen
timecode tag. SDR proxies are converted to and tagged as BT.709 limited range.
HDR rails retain source primaries, transfer, matrix, and range tags. These
changes eliminate ambiguous files before browser work begins.

Primary sources:

- [Apple: Evaluating an app's video color](https://developer.apple.com/documentation/avfoundation/evaluating-an-app-s-video-color)
- [WebKit bug 181445: explicit video color tags fix wrong WebGL color](https://bugs.webkit.org/show_bug.cgi?id=181445)
- [WebKit: Wide Gamut 2D Graphics using HTML Canvas](https://webkit.org/blog/12058/wide-gamut-2d-graphics-using-html-canvas/)

### 2. A self-check can detect a bad path, but it cannot repair it

The existing QA harness already has the right oracle: a small BT.709
limited-range bars clip, exact reference RGB patches, and tolerances that
separate quantization noise from range, matrix, and transfer errors. Running a
reduced form of that check once in the product can answer whether the active
native video-to-canvas path reproduces the known clip.

The check must report pass, warning, or unsupported. It must never install a
per-browser correction. Browser version is not a sufficient target because the
same engine can select software decode, VideoToolbox, D3D11, VA-API, or another
hardware path, and the OS can apply a display transform after composition.

The check also cannot prove front-of-screen calibration. It proves only that
the sampled browser path agrees with the encoded reference at the point where
canvas readback occurs. Apple explicitly recommends test patterns and
front-of-screen measurement for judging the complete display path.

Product language must preserve that boundary. A successful check is a decode
and canvas-readback pass, not "color verified." It must not imply that native
video composition, ColorSync, an ICC transform, GPU output, or the physical
display was measured. Playback-mode controls must also remain hidden until
there are genuinely different native and reference backends to select.

### 3. `VideoFrame.colorSpace` is evidence, not authority

WebCodecs exposes primaries, transfer, matrix, and full-range state on each
decoded `VideoFrame`. The decoder may detect those values from the bitstream,
and a `VideoDecoderConfig` can override them. The specification defaults
unspecified YUV to BT.709 limited and unspecified RGB to sRGB.

Current engine behavior is not uniform. Mozilla bug 2048686 records that
constructing a `VideoFrame` from an `HTMLVideoElement` returns null color-space
components in Firefox even though the decoded image carries metadata. The
direct `VideoDecoder` path has a metadata reader, but the bug also documents a
deeper hardware-decoder path whose defaults can remain incomplete. Safari
26.4 fixed H.264 WebCodecs output ordering and AV1 color-profile parsing, and
Safari 27 beta records another B-frame ordering fix. A production decoder must
validate timestamps and color metadata instead of assuming that API presence
means correctness.

Decisions:

- Decode the proxy bitstream directly with `VideoDecoder`, not
  `new VideoFrame(video)`.
- Compare frame metadata with the server-probed rendition metadata.
- Treat disagreement or missing required metadata as a failed reference-mode
  precondition, not a reason to guess.
- Retain native video as the immediate fallback.

Primary sources:

- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)
- [Mozilla bug 2048686: VideoFrame from HTMLVideoElement has null colorSpace](https://bugzilla.mozilla.org/show_bug.cgi?id=2048686)
- [Mozilla bug 1902115: RGB VideoFrame copy work](https://bugzilla.mozilla.org/show_bug.cgi?id=1902115)
- [WebKit features in Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)
- [WebKit in Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)

### 4. The deterministic SDR path must copy raw YUV planes

Several attractive shortcuts still leave the conversion inside the browser:

- `drawImage(video)` honors the video's color information and converts it into
  the canvas color space.
- Drawing a `VideoFrame` to a 2D canvas likewise requests browser conversion.
- `VideoFrame.copyTo()` with an RGB format requests conversion to a predefined
  RGB color space.
- WebGPU `importExternalTexture()` attaches conversion metadata and samples the
  result in the requested color space.

Those paths are useful for ordinary playback, but they do not remove the
engine's YUV-to-RGB implementation from the experiment. The reference path
must:

1. Demux the progressive MP4 with mediabunny.
2. Decode with `VideoDecoder`.
3. Read the frame's native I420 or NV12 planes with `VideoFrame.copyTo()`
   without requesting an RGB format.
4. Upload luma and chroma planes as numeric R8 or RG8 textures.
5. Perform range expansion, YUV matrix conversion, and transfer conversion in
   an audited shader.
6. Present into an explicitly sRGB canvas.

WebGPU numeric textures contain raw numeric values and are not intrinsically
color-managed. WebGL2 offers the same useful property for R8 and RG8 plane
textures and has wider deployed support. WebGL2 is therefore the required
baseline. WebGPU is an optional accelerator after it reproduces the same
oracle.

Primary sources:

- [W3C WebCodecs, VideoFrame and copyTo](https://www.w3.org/TR/webcodecs/)
- [WebGPU specification](https://gpuweb.github.io/gpuweb/)
- [WebGPU external texture descriptor](https://gpuweb.github.io/types/interfaces/GPUExternalTextureDescriptor.html)
- [WHATWG canvas color spaces](https://html.spec.whatwg.org/multipage/canvas.html)

### 5. The first reference path should be deliberately narrow

The workhorse review proxy is CFR H.264, 8-bit 4:2:0, BT.709 limited range.
That makes a narrow first implementation materially useful:

- I420 and NV12 input only
- progressive 8-bit BT.709 limited-range output
- 1920x1080 at 24, 25, 29.97, and 30 fps first
- WebGL2 baseline
- one fixed, tested conversion rather than a generic color-management engine

BT.601, full-range, BT.2020, PQ, HLG, P3, and 10-bit paths still need shader
vector tests because the source corpus and self-check exercise those mistakes.
They do not become production reference-mode inputs until the matching proxy
rail and cross-engine measurements are green.

### 6. Native playback remains the first HDR path

The platform exposes two different questions:

- `navigator.mediaCapabilities.decodingInfo()` can describe codec decode
  support, smoothness, power efficiency, HDR metadata type, gamut, and
  transfer function.
- `video-dynamic-range` and `video-color-gamut` describe what the user agent
  and output device's video plane can present.

Both must agree before choosing an HDR rendition. The SDR tonemapped proxy is
the safe default. A capable decoder on an SDR display is not an HDR playback
path, and an HDR display without a supported codec is not one either.

Chrome 129 exposed an extended-range `rgba16float` WebGPU canvas path. That is
useful evidence for a future controlled HDR renderer, not a cross-engine
contract. The first browser fix must not claim deterministic HDR or replace
native HDR presentation.

Primary sources:

- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/)
- [Chrome 129 WebGPU HDR canvas](https://developer.chrome.com/blog/new-in-webgpu-129)

### 7. Frame identity remains an integer-frame contract

WebCodecs timestamps and the demuxer's sample table are the reference-mode
clock. Floating `currentTime` does not become frame identity. WHATWG issue 609,
requesting rational media seeking, remains open, which reinforces the current
Onelight rule.

The decoder owns a bounded frame window around the requested integer frame. It
must close every `VideoFrame` promptly. The WebCodecs specification warns that
codec resources can be exhausted quickly and should be released immediately.

Primary sources:

- [WHATWG issue 609: rational media seek](https://github.com/whatwg/html/issues/609)
- [W3C WebCodecs resource reclamation](https://www.w3.org/TR/webcodecs/)

### 8. Audio should remain a separate, cheap clock

The HTML standard requires pitch correction when `preservesPitch` is true and
requires rate changes without perceptible gaps or muting. Engine defects still
exist in the field. Firefox has a long-running report of severe audio
artifacts above 2x, and Safari 27 beta records a fix for the combination of
`preservesPitch`, `playbackRate`, and `createMediaElementSource`.

Onelight's precompressed 2x and 4x audio sidecars are therefore the right J/K/L
strategy. They are small, pitch-corrected, and independently diagnosable. A
compact 1x audio sidecar can become the reference renderer's master clock so
the browser never decodes the picture twice merely to obtain audio.

Primary sources:

- [WHATWG media element playback rate and preservesPitch](https://html.spec.whatwg.org/multipage/media.html)
- [Mozilla bug 1427267: high-speed audio artifacts](https://bugzilla.mozilla.org/show_bug.cgi?id=1427267)
- [WebKit in Safari 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)

## Resulting architecture

```text
                         native path
tagged proxy or HDR rail -----------> HTMLVideoElement -----------> display
       |
       | SDR reference mode
       v
mediabunny -> VideoDecoder -> raw I420/NV12 copy -> WebGL2 shader -> sRGB canvas
                                      ^
                                      |
                 server-probed rendition color metadata

1x, 2x, 4x AAC sidecars -> HTMLAudioElement -> playback clock and J/K/L audio
```

The native path remains automatic and universal. Reference mode is a bounded
SDR instrument with an explicit preflight, deterministic conversion, automatic
fallback, and no guessed browser compensation.
