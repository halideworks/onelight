# Browser color verification and SDR reference playback

Implementation specification, 2026-07-23. This spec follows
`docs/research/browser-color-reference-2026-07.md` and supersedes the two
browser-color bullets in `docs/ROADMAP.md`.

## 1. Scope and non-goals

This work ships in four independently releasable stages:

1. Native-path color self-check and server diagnostics.
2. A WebGL2 SDR reference renderer prototype.
3. Production SDR reference mode with audio, transport, and fallback.
4. HDR capability tightening and a later controlled-HDR research gate.

The first production reference renderer supports 8-bit BT.709 limited-range
H.264 review proxies through 4096x2160 at 30 fps. It does not promise:

- display calibration
- deterministic native HDR
- Dolby Vision or HDR10+ rendering
- arbitrary ICC profiles
- resolutions above 4K or frame rates above 30 fps before measurement
- DRM media
- a per-browser gamma correction table

## 2. Invariants

- Positions remain integer frames plus an exact rational rate.
- The renderer never derives frame identity from `currentTime`.
- The proxy's probed color metadata must agree with decoded-frame metadata.
- Missing or conflicting required metadata fails closed to native playback.
- Reference mode owns YUV range, matrix, and transfer conversion.
- A browser `drawImage`, RGB `copyTo`, `copyExternalImageToTexture`, or
  `importExternalTexture` conversion is not a reference render.
- No more than six decoded `VideoFrame` objects may remain open.
- Every decoder, GPU, allocation, seek, and source change has a cancellation
  path.
- Device or context loss falls back to native playback at the same frame.
- Diagnostics contain no raw GPU name, device identifier, IP address, or
  persistent cross-site identifier.

## 3. Data and API deltas

### 3.1 Rendition metadata

The existing rendition `meta` object is the source of truth. Every playable
video rendition must expose:

```ts
interface RenditionColorContract {
  frame_rate_num: number;
  frame_rate_den: number;
  source_timecode_start?: string;
  source_timecode_source?: "tmcd_stream" | "format" | "video_stream" | "stream";
  source_color: {
    primaries: string | null;
    transfer: string | null;
    matrix: string | null;
    range: string | null;
    pixelFormat: string | null;
    bitsPerRawSample: string | null;
    assumed: boolean;
  };
  output_color: {
    primaries: "bt709";
    transfer: "bt709";
    matrix: "bt709";
    range: "tv";
  };
}
```

The worker already writes these fields. Contract tests must require them for
newly transcoded video renditions while remaining tolerant of older rows.

### 3.2 Color diagnostic

Extend the existing playback-diagnostic routes with a discriminated body, not
a second endpoint:

```ts
type ColorDiagnostic = {
  kind: "color_self_check";
  outcome: "pass" | "warning" | "unsupported";
  stage:
    | "load"
    | "decode"
    | "canvas"
    | "readback"
    | "compare"
    | "complete";
  engine_family: "chromium" | "firefox" | "webkit" | "unknown";
  engine_major: number | null;
  platform_class: "mac" | "windows" | "linux" | "mobile" | "unknown";
  canvas_color_space: "srgb" | "display-p3" | "unknown";
  patch_max_delta: [number, number, number] | null;
  failed_patches: string[];
  elapsed_ms: number;
  failure: string | null;
};
```

The server adds request, user, share, asset, and version context as it does for
J/K/L diagnostics. Rate limit by session and version. Log the summary as one
structured record. Never send patch pixels, GPU adapter strings, raw user-agent
client hints beyond what the server already receives, or display identifiers.

### 3.3 Preference

The production reference player will add a browser-local preference:

```ts
type ColorPlaybackMode = "automatic" | "native" | "reference";
```

- `automatic`: native when the self-check passes, reference when production
  reference mode is supported and the self-check warns.
- `native`: always native and retain the self-check result as information.
- `reference`: request reference mode and fall back with an explicit reason.

The preference is local to the browser. It is not synced into review data.

Supersession, 2026-07-23: do not expose or persist this preference until the
reference picture backend is integrated. Automatic and Native both selected
the native video element during BCR-T04, so presenting them as distinct choices
was misleading. The dormant control, type, storage key, and persistence code
were removed. Add the preference with BCR-T08 and activate Automatic behavior
only when BCR-T10 can perform a real same-frame fallback.

## 4. Components

### 4.1 Shared color oracle

Create `packages/player/src/color-oracle.ts`.

Responsibilities:

- define the canonical patch rectangles and expected sRGB values
- compare readings and return all failures, never only the first channel
- expose the same tolerance logic to product code and `qa/color-qc.spec.ts`
- identify uniform range shifts, likely matrix mismatch, and non-specific
  transfer deviation for diagnostic text without applying a correction

Move the canonical reference data out of QA-only code. The synthesized fixture
remains in `qa`, but a parity test must prove the embedded product clip and the
QA fixture produce the same oracle values.

### 4.2 Self-check

Create:

- `packages/player/src/color-self-check.ts`
- `packages/player/src/color-self-check.test.ts`
- `packages/web/static/media/color-check-bt709.mp4`

The clip is a sub-second, two-keyframe H.264 MP4, faststart, yuv420p, explicitly
tagged BT.709 limited range, without audio. Keep it below 100 KiB. Record the
ffmpeg synthesis command and SHA-256 in `qa/README.md`.

Algorithm:

1. Return a cached result when build ID, engine family and major, platform
   class, and self-check clip hash match.
2. Load the clip into a detached muted video element.
3. Wait for metadata and a presented frame with bounded timeouts.
4. Draw into a 2D canvas explicitly created with `colorSpace: "srgb"`.
5. Read all oracle patches.
6. Compare every channel and classify the outcome.
7. Close and remove all temporary resources.
8. Store only the outcome, deltas, version key, and timestamp in local storage.
9. Post a diagnostic once per version key.

Timeout or unsupported canvas readback returns `unsupported`, not `pass`.

### 4.3 Reference demux and decode worker

Create:

- `packages/player/src/reference/decoder.worker.ts`
- `packages/player/src/reference/protocol.ts`
- `packages/player/src/reference/frame-window.ts`
- `packages/player/src/reference/frame-window.test.ts`

The worker uses mediabunny, which is already a QA dependency. Move it into the
player package production dependencies only when the prototype passes bundle
and memory gates.

Messages into the worker:

```ts
type DecoderCommand =
  | {
      type: "open";
      generation: number;
      url: string;
      expected: ExpectedTrack;
      hardwareAcceleration?:
        | "no-preference"
        | "prefer-hardware"
        | "prefer-software";
    }
  | { type: "seek"; generation: number; frame: number }
  | { type: "play"; generation: number; frame: number; rate: 1 | 2 | 4 }
  | { type: "pause"; generation: number }
  | { type: "close"; generation: number };
```

Messages out:

```ts
type DecoderEvent =
  | { type: "ready"; generation: number; track: DecodedTrack }
  | { type: "frame"; generation: number; frame: number; planes: PlaneTransfer }
  | { type: "stalled"; generation: number; frame: number }
  | { type: "unsupported"; generation: number; reason: string }
  | { type: "error"; generation: number; reason: string };
```

The generation invalidates all results from an earlier source, rendition,
seek, or mode. Decode from the nearest keyframe and retain only the target
window. The initial cap is:

- two frames behind
- current frame
- three frames ahead
- six open frames total

Close evicted frames immediately. Observe `decodeQueueSize` and stop feeding
chunks when the decoder is saturated. `flush()` is not a seek primitive. Reset
and restart from a keyframe when the requested frame leaves the active GOP
window.

### 4.4 Raw-plane transfer

Accepted production input formats:

- I420
- NV12

For each frame:

1. Check `frame.colorSpace` against rendition output metadata.
2. Reject null or conflicting primaries, transfer, matrix, or range.
3. Copy the explicit coded rectangle with `allocationSize()` and `copyTo()`
   without an RGB format.
4. Require exactly three bounded, non-overlapping planes for I420 or two for
   NV12, with valid offsets and strides.
5. Transfer ArrayBuffers, exact plane layouts, coded and visible rectangles,
   and the server-probed chroma location to the main thread.
6. Close the `VideoFrame` after the copy completes.

The worker may reuse a bounded buffer pool. The pool may hold no more than the
six-frame window plus two buffers in flight.

### 4.5 WebGL2 renderer

Create:

- `packages/player/src/reference/gl-renderer.ts`
- `packages/player/src/reference/color-math.ts`
- `packages/player/src/reference/color-math.test.ts`
- `packages/player/src/ReferenceStage.svelte`

Use:

- `R8` luma texture
- `R8` U and V textures for I420
- `RG8` interleaved chroma texture for NV12
- explicit nearest or specified chroma reconstruction
- an sRGB canvas output contract

Shader stages:

1. sample luma and chroma using visible-rect and chroma-location metadata
2. expand limited or full-range code values
3. apply the selected YUV-to-RGB matrix
4. convert transfer into the output encoding
5. clamp only at the final SDR output

The first production specialization is BT.709 limited to sRGB display output.
The color-math module must still carry exact CPU reference vectors for:

- BT.601 and BT.709
- limited and full range
- black, reference white, 40 percent grey
- 75 percent red, green, blue, cyan, magenta, yellow
- BT.2020 non-constant-luminance vectors for future coverage

The WebGL and CPU results may differ by at most 1/255 per SDR output channel.

Do not use `UNPACK_COLORSPACE_CONVERSION_WEBGL` as the correctness mechanism.
Raw numeric plane textures contain no browser-decoded RGB to correct.

The production renderer requests a high-performance WebGL2 context and fails
when the browser reports a major performance caveat. Headless QA may explicitly
allow software GL to verify shader pixels. A passing software-GL test is never
reported as evidence of hardware acceleration or playback performance.

### 4.6 Player integration and clock

Keep `Player.svelte` responsible for transport state, not decode mechanics.
Add a `PictureBackend` interface:

```ts
interface PictureBackend {
  load(source: SourceContract, frame: number): Promise<void>;
  seek(frame: number, discontinuity?: boolean): void;
  play(frame: number, rate: 1 | 2 | 4): void;
  pause(): void;
  close(): void;
}
```

Implement:

- `NativePictureBackend`, adapting the current HTML video path
- `ReferencePictureBackend`, adapting worker plus WebGL2 canvas

Reference audio uses a small 1x AAC sidecar as the normal-play clock and the
existing 2x and 4x sidecars for J/K/L. The picture frame is selected from the
audio clock using the exact rational rate. rVFC remains native mode's presented
frame source. Pausing or seeking synchronizes both backends to the same integer
frame before control returns.

Pointer scrubbing has a separate bounded scheduler. The playhead follows the
pointer once per animation frame, independently of decode latency. The
reference backend allows one decode window to finish, keeps only the newest
pending target, presents the nearest cached frame while moving, and requests
the exact integer frame when the gesture ends. Forward scrub requests reuse
the verified packet iterator and copy only the requested frame instead of a
six-frame playback window. Reversals and the final release reset from the
verified prior key packet. The WebGL renderer alternates between two persistent
YUV texture banks so a 4K upload does not overwrite textures still sampled by
the previous draw.

The reference backend must preserve:

- J, K, L semantics and audible 2x and 4x sidecars
- I/O marks and loop playback
- frame stepping and range selection
- annotations and marker seeking
- rendition switching
- share URL refresh
- fullscreen

### 4.7 Fallback and recovery

Fallback triggers:

- `VideoDecoder.isConfigSupported()` rejects the track
- demux or decode error
- frame color metadata conflicts with rendition metadata
- format other than I420 or NV12
- WebGL2 unavailable
- context loss
- plane allocation or upload failure
- sustained decode starvation
- frame timestamp or output-order violation

Recovery:

1. Capture the current integer frame and play state.
2. Stop and close reference resources.
3. Load native playback at the same rendition and frame.
4. Resume only if the user had been playing.
5. Show one neutral, non-blocking explanation.
6. Post one bounded diagnostic for that failure class.

No retry loop is allowed during the same source generation.

## 5. HDR selection hardening

Before selecting an HDR rail, require:

1. `decodingInfo()` reports supported and smooth for the exact codec, profile,
   dimensions, bitrate, frame rate, gamut, transfer, and metadata type.
2. `(video-dynamic-range: high)` matches.
3. `(video-color-gamut: rec2020)` matches for BT.2020 material.
4. The rendition's stored metadata is complete and agrees with the source.

Otherwise select the SDR BT.709 tonemapped proxy.

HDR native playback gets an information state, not a "reference" badge.
Controlled HDR rendering remains blocked until all of these are true:

- raw 10-bit plane copy is reliable in current Chromium, Firefox, and Safari
- extended-range canvas output is available in all target engines
- PQ and HLG EOTF, mastering luminance, content light level, and gamut mapping
  decisions are specified
- real HDR monitor measurements pass on macOS and Windows

## 6. UI

The review instrument stays neutral grey.

Add one compact state beside rendition quality:

- `Decode check passed`
- `Decode check warning`
- `Decode check unavailable`
- `Reference renderer`, after the renderer is integrated
- `Native HDR`

The control uses text plus a simple geometric status mark, not color alone.
Activating it opens a value-step panel with:

- active path
- source and rendition primaries, transfer, matrix, and range
- decode-to-sRGB-canvas result and measured maximum readback delta
- diagnostic detail for a warning or unsupported path
- an explicit statement that the check does not measure native video
  composition, ColorSync or ICC transforms, GPU output, or the display
- Automatic, Native, and Reference choices only after their backends differ

Never label a canvas-readback pass as color verification or calibration. No
browser recommendation is hard-coded. If a path warns, state what was measured
and offer reference mode only when it is available.

## 7. Tests

### 7.1 Unit and property tests

- color oracle comparison and classification
- CPU matrix and range vectors
- frame-window eviction, seek cancellation, and six-frame cap
- generation cancellation across source and rendition changes
- decoded timestamp to integer-frame mapping at every supported rate
- fallback state restoration
- metadata agreement and fail-closed behavior

### 7.2 Browser QA

Extend `pnpm qa` across Chromium, Firefox, and Playwright WebKit:

- product self-check reproduces the existing color oracle
- I420 and NV12 raw-plane renders match the oracle
- shader output differs from CPU reference by at most 1/255
- native and reference paths identify the same frame on 20 seeded seeks at all
  existing rates
- source swap, seek storm, context loss, and device loss recover without a
  stale frame
- rapid scrub storms coalesce to the newest target and settle on the exact
  release frame
- all `VideoFrame` instances close and the six-frame cap holds
- accessibility and keyboard transport remain unchanged

Playwright WebKit is not real Safari. The manual matrix includes current Safari
on Intel and Apple Silicon Macs, Chrome and Firefox on Windows, and at least
one integrated Intel GPU Windows machine.

### 7.3 Performance gates

Measure after warm-up on 1080p and 4K H.264 BT.709 proxies:

- cold local-fixture open under 1.5 seconds and first six-frame runway under
  2.5 seconds at 1080p, 3 seconds at 4K30
- 24 and 30 fps: no systematic dropped frames over five minutes
- 4096x2160 at 30 fps: no more than one dropped requested frame over the
  bounded qualification clip, no steady-state main-thread task over 50 ms,
  and seek p95 under 250 ms on the named hardware
- 60 fps prototype gate: no more than 1 percent dropped frames before enabling
  production support
- no steady-state main-thread task over 50 ms
- six decoded frames maximum
- decoded-plane buffer pool no larger than eight frames
- seek to a frame in the active GOP p95 under 80 ms
- seek outside the active GOP p95 under 250 ms on the reference Windows Intel
  machine and Apple Silicon Mac
- a one-second 1080p scrub presents at least eight picture updates, has no
  presentation gap over 250 ms, and settles on the exact release frame within
  750 ms
- a one-second 4K30 scrub presents at least 75 percent of the display ticks
  available to the test, has no presentation gap over 300 ms, no task over
  50 ms, and settles on the exact release frame within 1.5 seconds
- reference bundle increase reported before merge and code split from the
  default review route

Failure on a performance gate disables automatic reference selection on that
platform class. It does not weaken the pixel tolerances.

## 8. Task order

| ID | Task | Acceptance |
|---|---|---|
| BCR-T01 | Extract shared color oracle | Existing QA output is byte-identical and parity test passes. |
| BCR-T02 | Add the tiny product self-check clip and runner | All three CI engines return the expected pass or exact pinned warning. |
| BCR-T03 | Extend structured playback diagnostics | Auth, share scope, rate limits, strict schema, and privacy fields are contract-tested. |
| BCR-T04 | Add neutral decode-readback UI | Desktop, tablet, and phone screenshots match section 24, keyboard focus is complete, and the copy does not claim display verification. |
| BCR-T05 | Prototype mediabunny and VideoDecoder worker | Exact frame timestamps, cancellation, and six-frame resource cap pass. |
| BCR-T06 | Implement raw I420 and NV12 copy | Decoded metadata is checked and no RGB browser conversion occurs. |
| BCR-T07 | Implement WebGL2 color renderer | CPU vectors and all browser oracle patches pass within 1/255. |
| BCR-T08 | Integrate reference picture backend | Step, seek, loop, marks, annotations, rendition switch, and fullscreen pass unchanged. |
| BCR-T09 | Add 1x reference audio sidecar | Normal playback and existing pitch-corrected J/K/L remain audible and synchronized. |
| BCR-T10 | Add automatic fallback and diagnostics | Every listed failure lands on native playback at the same frame without retry loops. |
| BCR-T11 | Run performance and real-browser matrix | 1080p soak and 4K30 qualification gates pass on macOS Safari and Windows Chromium/Firefox, including Intel graphics. |
| BCR-T12 | Harden HDR rendition gating | Unsupported or non-HDR displays receive SDR; qualified native HDR remains opt-in and labeled. |

Implementation status, 2026-07-24:

- BCR-T01 through BCR-T10 and BCR-T12 are implemented and covered by unit,
  contract, browser-pixel, frame-accuracy, fallback and resource-cap tests.
- The forward worker retains one packet iterator across adjacent playback
  windows and forward scrub samples. Random seeks, reverse scrubs and final
  release still reset to the verified prior key packet. It does not flush
  between bounded forward windows or forward scrub samples. Scrubbing copies
  one exact plane and coalesces all pending targets to the newest. Completed raw
  planes are delivered incrementally in presentation order. Decoded
  `VideoFrame` copies are bounded at six concurrent frames; copied raw-plane
  storage is bounded at eight reusable buffers.
- Playback waits for a bounded initial runway before starting its audio clock.
  Normal clock progression does not cancel in-flight decode work, while seeks,
  source changes, loop wraps and reverse motion invalidate the old generation.
- Automatic mode prepares the reference worker, first six-frame runway and 1x
  audio clock in the background after the native picture arrives. The native
  picture remains visible and playable through preparation and hidden catch-up;
  it pauses only for the final exact-frame handoff. Explicit Native mode does
  not spend those resources. Structured diagnostics include preparation time,
  click-to-handoff time and whether preparation completed before the click.
- The accepted production source contract is explicit through 4096x2160 at 30
  fps. A synthesized 3840x2160 30 fps B-frame fixture exercises scheduling,
  worker continuity, buffer recycling and WebGL upload. The strict hardware
  gate is opt-in with `QA_REFERENCE_REQUIRE_HARDWARE=1`; headless software
  results are functional evidence only.
- The 1x, 2x and 4x AAC-LC sidecars are navigation clocks, not reference media.
  Their blobs follow the same rendition foreign-key cascade, project deletion,
  trash purge and orphan reconciliation paths as the video proxy.
- Captions in reference mode are selected from the browser-parsed WebVTT cue
  list by the current integer source-frame interval. The hidden native video
  no longer makes captions disappear.
- Automatic reference selection remains disabled. The explicit Reference
  choice runs the complete runtime preflight and failure recovery, but BCR-T11
  requires sustained hardware measurements on the named real devices before a
  platform class can be selected automatically.

Supersession, 2026-07-24: the original universal BCR-T07 start gate assumed
that decoder preference could recover raw YUV on every engine. Measured
Playwright 1.61.1 results on Windows disprove that assumption. Chromium returns
I420 for `no-preference` and `prefer-software`, while `prefer-hardware` rejects
the configuration. Firefox returns BGRX for all three preferences, matching
Mozilla bug 1969762. WebCodecs permits RGB output conversion but provides no
BGRX-to-I420 or BGRX-to-NV12 copy option. Converting that BGRX output back to
YUV would launder the browser conversion rather than create a reference path.
Playwright WebKit 26.5 on Windows has neither `VideoDecoder` nor
`requestVideoFrameCallback`; the product self-check returns a bounded
`unsupported` result instead of waiting for a presentation callback that
cannot occur. Its separate attached-video canvas bytes are pinned by platform.

BCR-T07 may therefore be implemented and pixel-qualified only after the
runtime preflight returns native I420 or NV12. A runtime returning RGB remains
on native playback. Browser names are not used as the capability decision.
Automatic reference selection still requires BCR-T11, including current Safari
and Windows Intel graphics measurements at both the 1080p soak and 4K30 target.

Supersession, 2026-07-25: three deltas after the first production incidents.

1. Recovery (supersedes the section 4.7 "no retry loop" rule and BCR-T10's
   acceptance wording). A failed source now advances a bounded escalation
   ladder instead of latching native on first failure: attempt one runs the
   platform decoder, a decoder-fault failure class escalates the next attempt
   to `prefer-software`, and transient classes retry with exponential backoff
   up to three retries per source. Each retry is its own generation, so the
   original rule's intent -- no retry storm inside one generation -- stands.
   Failure classes that indict the media or the environment
   (`decoder_unsupported`, `metadata_conflict`, `raw_format`) still latch
   immediately. A hidden tab pauses playback rather than letting a throttled
   clock starve decode, and an externally paused reference audio clock folds
   into a transport pause.

2. Display transfer. The renderer's output encoding is now explicit: `srgb`
   passes decoded BT.709 code values straight to the sRGB canvas (the former
   behavior), `bt1886` decodes them as pure 2.4 display-referred and re-encodes
   for the canvas. Resolution order: per-asset editor override (`assets.
   display_transfer`, editors and managers only, delivered read-only to share
   viewers), else the source transfer tag (sRGB-family and ~2.2 legacy tags
   map to `srgb`), else `bt1886` -- the post-production reference default.
   Changing the transfer repaints the held frame. The QA browser matrix must
   assert the `bt1886` branch against the CPU `encodeForDisplay` within 1/255
   per channel, alongside the existing pass-through checks.

3. Chroma reconstruction (clarifies section 4.5). The specified reconstruction
   is bilinear (GL_LINEAR) with the siting offset derived from the contract's
   chroma location -- `0.5 / lumaWidth` horizontally for left siting, the
   analogous half-texel vertically for top-left. Nearest sampling is not used;
   it would displace chroma by half a pixel on half the samples. Where an
   engine cannot declare the drawing buffer's color space, a wide-gamut
   display may composite the canvas as device RGB; the value-step panel
   carries that caution.

Supersession, 2026-07-25 (Safari): measured on Safari 26.0.1, macOS 26.0.1,
Apple Silicon (M3 Ultra), against 1280x720, 1920x1080, 608x1080 and 3840x2160
BT.709 limited-range H.264 proxies, at `no-preference`, `prefer-hardware` and
`prefer-software`, on the main thread and in a module worker.

1. The engine qualifies. Every configuration returned `NV12` with tight
   strides, an exact `copyTo` of the coded rect, and monotonic presentation
   timestamps. `drawingBufferColorSpace` is available (output is color
   managed), a strict `failIfMajorPerformanceCaveat` WebGL2 context is
   granted, and R8 uploads with `UNPACK_ROW_LENGTH` padding read back exactly.
   `OffscreenCanvas`, `transferControlToOffscreen` and WebGL2-in-worker are
   all present, so the render-in-worker step has no Safari blocker.

2. The platform decoder range-expands, truthfully (supersedes the section 4.4
   rule that a frame's color metadata must equal the rendition's). VideoToolbox
   returns limited-range BT.709 as a full-range surface: its luma matches
   ffmpeg's `out_range=pc` conversion byte for byte (45/44/47 where the
   limited-range plane reads 55/54/56), and it reports `fullRange: true` with
   the sRGB transfer tag macOS uses for BT.709. Requiring equality with the
   container refused every Safari frame as `metadata_conflict`. The rule is now
   a reconciliation: primaries and matrix must match, since a decoder changing
   either means the frame is not the promised picture; the transfer tag is
   descriptive and any SDR BT.709-family tag is accepted, because the output
   encoding comes from the display-transfer resolution and never from the
   frame; and the frame's own range wins, because the decoder is the authority
   on the samples it produced. Re-expanding an already expanded surface would
   crush blacks and clip highlights. The deviation is reported in the playback
   diagnostic (`decoded_range`, `decoded_transfer`) and stated in the
   value-step panel.

3. The engine emits in decode order (supersedes the section 4.3 assumption
   behind the `output_order` failure class). WebCodecs specifies
   presentation-order output and Chromium delivers it; WebKit hands back one
   frame per fed packet, in the order fed, so a stream with B-frames arrives
   shuffled. Measured on a worker-produced proxy: a packet's frame runs up to
   three ahead and two behind its position in the stream. Three consequences,
   all in the worker: an output below the high-water mark is a fault only past
   H.264's own reordering ceiling, not on sight; window completeness is now
   "every frame of the window is emitted, held or being copied" rather than a
   high-water mark, since a frame past the window end can arrive while earlier
   ones are still to come; and frames are retained further past the window end
   (L+8), because completing a window at L requires feeding packets that
   produce frames as far out as L+5, and their packets are consumed once.
   Without the last one the following window hunts for frames that can no
   longer be produced and walks the rest of the source: measured as a 636 ms
   freeze every GOP before the fix, 115 ms worst case after. A window that
   stays incomplete well past its own end now stops feeding and lets its
   emitted prefix stand.

4. Pixels verified on the real engine. The product's own self-check clip,
   decoded by Safari, copied by the production copy and drawn by the
   production renderer, reproduces every shared-oracle patch within the
   oracle's tolerance (worst channel 1/255), and the shader agrees with the
   CPU vectors to 0/255 on all eleven patches in both the NV12 branch and an
   I420 conversion of the same picture. The BT.1886 branch matches the CPU
   `encodeForDisplay` within 1/255 -- its first execution outside Chromium.
   Playwright WebKit still cannot stand in for this: it has no WebCodecs.

5. Measured on that Mac, 1920x1080 30 fps proxy, production worker plus
   production backend plus production renderer: cold open 39 ms and first
   runway 75 ms (gates 1.5 s and 2.5 s); seek outside the active GOP p95
   67 ms (gate 250 ms); a one-second scrub presents 32 updates with a 44 ms
   worst gap and settles the exact release frame in 65 ms (gates 8 updates,
   250 ms, 750 ms); six seconds of 30 fps playback presents 161 of 180 frames
   with a 33 ms median interval, an 89 ms p95 and a 115 ms worst gap, never
   out of order and with no failure raised.

   The 11 percent of frames it skips is the one gate this pass does not meet.
   It is not decode throughput: the backend's buffer stays full at its
   six-frame cap throughout and the picture stays on the clock for 142 of 181
   ticks. It is runway depth. The window reaches only three frames ahead, and
   an engine that emits in decode order needs a few more packets per window to
   get there, so the refill occasionally arrives one frame late and the
   transport shows the newest frame it has. Deepening the runway means
   revisiting the six-frame contract in section 4.3, which is a product
   decision, not a Safari fix. Main-thread render cost is 7 ms per 1080p frame
   here, which the OffscreenCanvas step would remove from the budget.

Automatic reference selection stays disabled. BCR-T11 additionally requires
the sustained measurements (five-minute soak, 4K30 qualification) on this Mac,
Windows Chromium and Firefox, and an Intel integrated GPU, none of which this
pass ran.
