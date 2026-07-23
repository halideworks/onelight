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

The first production reference renderer supports the existing 8-bit BT.709
limited-range H.264 review proxy at up to 1920x1080. It does not promise:

- display calibration
- deterministic native HDR
- Dolby Vision or HDR10+ rendering
- arbitrary ICC profiles
- 4K or high-frame-rate reference playback before measurement
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

Add a workspace-local player preference:

```ts
type ColorPlaybackMode = "automatic" | "native" | "reference";
```

- `automatic`: native when the self-check passes, reference when production
  reference mode is supported and the self-check warns.
- `native`: always native and retain the self-check result as information.
- `reference`: request reference mode and fall back with an explicit reason.

The preference is local to the browser. It is not synced into review data.

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
  | { type: "open"; generation: number; url: string; expected: ExpectedTrack }
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
3. Call `allocationSize()` and `copyTo()` without an RGB format.
4. Transfer ArrayBuffers and exact plane layouts to the main thread.
5. Close the `VideoFrame` after the copy completes.

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

### 4.6 Player integration and clock

Keep `Player.svelte` responsible for transport state, not decode mechanics.
Add a `PictureBackend` interface:

```ts
interface PictureBackend {
  load(source: SourceContract, frame: number): Promise<void>;
  seek(frame: number): void;
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

- `Color verified`
- `Color warning`
- `Reference color`
- `Native HDR`

The control uses text plus a simple geometric status mark, not color alone.
Activating it opens a value-step panel with:

- active path
- source and rendition primaries, transfer, matrix, and range
- self-check result and measured maximum delta
- reason for any fallback
- a short statement that browser verification is not display calibration
- Automatic, Native, and Reference choices where supported

No browser recommendation is hard-coded. If a path warns, state what was
measured and offer reference mode when available.

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
- all `VideoFrame` instances close and the six-frame cap holds
- accessibility and keyboard transport remain unchanged

Playwright WebKit is not real Safari. The manual matrix includes current Safari
on Intel and Apple Silicon Macs, Chrome and Firefox on Windows, and at least
one integrated Intel GPU Windows machine.

### 7.3 Performance gates

Measure after warm-up on a 1080p H.264 BT.709 proxy:

- 24 and 30 fps: no systematic dropped frames over five minutes
- 60 fps prototype gate: no more than 1 percent dropped frames before enabling
  production support
- no steady-state main-thread task over 50 ms
- six decoded frames maximum
- decoded-plane buffer pool no larger than eight frames
- seek to a frame in the active GOP p95 under 80 ms
- seek outside the active GOP p95 under 250 ms on the reference Windows Intel
  machine and Apple Silicon Mac
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
| BCR-T04 | Add neutral self-check UI | Desktop, tablet, and phone screenshots match section 24 and keyboard focus is complete. |
| BCR-T05 | Prototype mediabunny and VideoDecoder worker | Exact frame timestamps, cancellation, and six-frame resource cap pass. |
| BCR-T06 | Implement raw I420 and NV12 copy | Decoded metadata is checked and no RGB browser conversion occurs. |
| BCR-T07 | Implement WebGL2 color renderer | CPU vectors and all browser oracle patches pass within 1/255. |
| BCR-T08 | Integrate reference picture backend | Step, seek, loop, marks, annotations, rendition switch, and fullscreen pass unchanged. |
| BCR-T09 | Add 1x reference audio sidecar | Normal playback and existing pitch-corrected J/K/L remain audible and synchronized. |
| BCR-T10 | Add automatic fallback and diagnostics | Every listed failure lands on native playback at the same frame without retry loops. |
| BCR-T11 | Run performance and real-browser matrix | 1080p gates pass on macOS Safari and Windows Chromium/Firefox, including Intel graphics. |
| BCR-T12 | Harden HDR rendition gating | Unsupported or non-HDR displays receive SDR; qualified native HDR remains opt-in and labeled. |

Do not start BCR-T07 until BCR-T05 and BCR-T06 prove that each target engine
can return raw planes with trustworthy timestamps and metadata. Do not enable
automatic reference mode until BCR-T11 is recorded.

