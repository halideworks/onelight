# qa: automated media verification harness

This package holds the credibility-critical verification suites from design
doc section 21: the WebCodecs frame-accuracy ground truth, the golden-frame
color QC, and the tmcd timecode round-trip. All fixtures are synthesized
with ffmpeg at test time into `qa/.artifacts/` (gitignored); nothing binary
is ever committed.

## Running

```
pnpm qa              # from the repo root; runs every suite
pnpm qa:fixtures     # synthesize the corpus only (debugging aid)
```

Requirements: ffmpeg and ffprobe on PATH (or `FFMPEG_PATH`/`FFPROBE_PATH`),
and Playwright browsers (`pnpm --filter @onelight/qa exec playwright install
chromium firefox`). When a tool is missing each suite skips with a single
logged reason and the run exits 0, so `pnpm qa` is safe on any machine.

CI runs the `media-qc` job (`.github/workflows/ci.yml`) on ubuntu-latest on
every push and pull request: apt ffmpeg + dejavu fonts, Playwright chromium
and firefox, then `pnpm qa`. It is independent of the docker job.

## The fixture corpus

`src/fixtures.ts` synthesizes, per supported rate (24000/1001, 24, 25,
30000/1001, 48, 50, 60000/1001, 60):

- a 10 second 1280x720 clip in the product's SDR proxy shape (libx264
  CRF 18, preset medium, yuv420p, 1 second GOP, sc_threshold 0, explicit
  BT.709 limited-range tags, +faststart; pinned by importing
  `SUPPORTED_MEDIA_RATES`/`probeFile` from `packages/worker/src/media.ts`),
- a large centered drawtext frame counter (`%{frame_num}`) for humans, and
- the machine-readable frame stripe: 8 blocks of 64x64 px along the bottom
  left edge, block i carrying bit i (LSB first) of frame_number mod 256,
  white for 1, black for 0, drawn with per-frame `drawbox` enable
  expressions. Pure-luma blocks this size survive 4:2:0 subsampling and
  CRF 18 intact; decoding thresholds the mean of a 16x16 patch at each
  block center, so edge ringing cannot flip a bit. Combined with the
  requested frame number, the stripe gives exact frame identity.

Plus:

- `dropframe-2997.mp4`: 30000/1001 with `-timecode 00:59:55;00
  -write_tmcd on`, exactly as the proxy recipe re-embeds source timecode.
- `bars-bt709.mp4`: 5 seconds of `smptehdbars` (SMPTE RP 219), BT.709
  tagged, limited range, with a sidecar `bars-expected.json` of expected
  sRGB values. The sidecar reference is the exact float BT.709
  limited-to-full conversion of the encoded YUV (dumped as raw yuv444p, so
  no swscale RGB math touches the reference; swscale itself is off by up to
  3/255). Patch rectangles are found by scanline run segmentation, verified
  uniform, and cross-checked against the analytic RP 219 nominals within
  3/255 at synthesis time, so a broken fixture fails before any browser
  sees it.

## What each suite proves

### frame-accuracy.spec.ts (Playwright chromium)

The design doc acceptance: frame counter matches at 20 random seeks across
all supported rates. For each rate clip, 20 distinct seeded-random frames:

1. Video path: seek to the frame middle (`mediaTimeForFrameMiddle`), read
   the next rVFC `mediaTime`, and assert that the stripe decoded from the
   presented pixels equals frame mod 256 and that `frameAtMediaTime` and
   `frameAtCurrentTime` both name the requested frame.
2. WebCodecs path: mediabunny demuxes the MP4 and drives `VideoDecoder`;
   the decoded sample whose presentation interval contains the seek target
   must carry the same stripe value, and `frameAtMediaTime` applied to the
   decoded sample timestamp must agree.

The harness page (`.artifacts/harness/harness.js`) is bundled by esbuild
from `src/harness-main.ts`, which imports
`packages/player/src/frame-clock.ts` directly: the formulas under test are
the literal player source, compiled into the page, so drift is impossible.

### color-qc.spec.ts (Playwright chromium + firefox; webkit when installed)

Plays the bars clip in a real `<video>` element, draws it to canvas, and
compares every sidecar patch per channel. This catches the bug classes the
design doc says users punish hardest: range mishandling (16-235 vs 0-255
moves black by about 16 and white by about 20; the black0/white100 patches
are the sharpest detectors), BT.601 vs BT.709 matrix confusion (15+ on the
R/G channels of saturated bars), and gamma shift (10-20 on midtone
neutrals such as grey40).

Tolerances (embedded per patch in the sidecar):

- 2/255 baseline: one quantization step encoding to 8-bit limited range
  plus one converting back is rounding noise; every bug class sits far
  outside it.
- 12/255 for the blue channel of chroma-saturated patches only. Measured
  and understood: both Chromium and Firefox draw video to canvas through
  libyuv, whose int8 SIMD kernel clamps the BT.709 U-to-B coefficient
  (2.1124 x 64 = 135) to the lane maximum 127, converting with 1.984
  instead. That understates B by up to 0.128 x |Cb - 128|, about 11/255 at
  the 75 percent bars (measured 9, identically in both browsers). It is an
  artifact of the readback path, not of on-screen rendering; matrix and
  range errors remain fully detected through R/G and the neutral patches.
  Derivation in `patchTolerance` in `src/fixtures.ts`; background in
  `docs/research/playback-transcode.md` section 2.4.

webkit is not installed in CI (documented skip); real Safari belongs to the
manual pass below.

### tmcd.spec.ts (Node only, ffprobe)

Asserts the synthesized drop-frame clip carries a tmcd track, that the
probe normalizer surfaces `00:59:55;00` with the drop-frame flag, and that
`@onelight/core` `parseTimecode`/`framesFromTimecode` decode the label to
the hand-derived SMPTE ST 12-1 start frame (107742) and re-encode it
verbatim. This validates both the proxy write recipe assumptions and the
core math against ffmpeg's own timecode handling.

## Reproducing a failure

Every frame-accuracy run prints its seed:

```
[qa] frame-accuracy: seed 3106127813 (run with QA_SEED=3106127813 to reproduce)
```

Re-run the identical seek sequence with:

```
QA_SEED=3106127813 pnpm qa
```

Assertion messages carry the clip id, frame number, seed, and the observed
mediaTime or sample timestamp, so a CI failure is reproducible locally
byte-for-byte (fixtures are deterministic apart from encoder version).

## What still needs a manual run

Automation is not honest for these; they stay on the per-release manual
protocol (design doc section 21):

- NLE round-trips: import the exported Resolve marker EDL, Avid marker
  text/XML, FCPX FCPXML, and Premiere paths into real Resolve, Media
  Composer, Premiere, and Final Cut, with the recorded checklist.
- HDR tonemap verification on a real libplacebo/Vulkan (or lavapipe)
  stack, and HDR rail playback gating on genuine HDR displays and Safari.
- Real Safari/WebKit color QC on macOS (CI covers chromium and firefox
  only) and hardware-decoder color behavior (the CI runs decode in
  software; this repo's Windows dev runs already showed OS decoder paths
  can differ).
- Compose/burn-in export end-to-end against real graded footage, and the
  curated real-camera corpus (ProRes, DNx, XAVC, VFR phone clips, 8ch MXF)
  which is license-encumbered and lives outside the repo.
