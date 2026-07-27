# Proxies that respect the source colour space

The goal, in David's words: proxies should perfectly respect colour space
(gamma, gamut, everything), and **preserve over convert as much as possible**.
Today they do neither, deliberately and for a reason that has expired.

## What happens now

`packages/worker/src/media.ts` sends every non-709 SDR source through
`bt709ConvertFilter` (`zscale=...:matrix=709:primaries=709:transfer=709`) and
every HDR source through a libplacebo tonemap to 709. So the proxy the player
receives is always BT.709, always. That was the right call while the player
could only render 709: one space in, one space out, nothing to get wrong.

The cost is a conversion baked in at transcode time. A P3-D65 master loses
everything outside 709 permanently -- saturated P3 red sits at
`[1.2249, -0.0421, -0.0196]` in 709 and gets clipped -- and a review tool whose
claim is "what you see is the file" is showing a squeezed copy of it.

## The order this has to happen in

The player must be able to render any space **before** the proxies stop
flattening. A P3 proxy handed to a 709-assuming renderer is worse than the
squeeze: it is wrong and it looks fine. Every step below is safe to ship on its
own and is a no-op until the step after it.

### 1. Gamut transforms (DONE, `0b1278e`)

`color-math.ts` derives RGB-to-XYZ from chromaticities for BT.709, Display P3
(`smpte432`), BT.2020, SMPTE 170M and EBU 3213, and composes source-to-output
3x3 matrices. Matching gamuts return an exact identity so the measured
GL-versus-CPU parity on 709 is untouched. Unimplemented tags return null rather
than a guess.

### 2. Shader applies the gamut, in linear light (DONE, `2dbc24d`)

The conversion is only valid on linear values, so the fragment shader becomes
linearise (by source transfer) -> 3x3 -> encode (for the output space).

**Keep the passthrough.** When the gamut matrix is identity, the transfer is
sRGB and the output is sRGB, the current shader passes code values straight
through, and the 0/255 GL-versus-CPU parity measured on Safari depends on that.
Gate the new path on a `passthrough` uniform rather than always linearising, or
that result is lost to float round-trip.

### 3. Output space, not just sRGB (DONE, `2dbc24d` + `ce8a483`)

The renderer takes an `outputColorSpace` option, asks the context for
`display-p3`, reads the property back to see whether it was honoured, and
reports the result as `outputPrimaries`; every frame is converted into that.

`ReferenceStage` probes the display with `matchMedia("(color-gamut: p3)")` and
asks for a wide buffer when the content is wider than 709 and the display can
show it -- and only then, because 709 into a P3 buffer is a real matrix that
would cost the passthrough for no visible gain.

The renderer is rebuilt when the *requested* space changes, not when the
granted one differs: an engine that refuses display-p3 would otherwise look
like a mismatch on every frame and rebuild forever.

**Deliberately not a user preference.** The content's gamut and the display's
capability answer the question between them; there is nothing here a room
needs to fix by hand, unlike the transfer.

### 4. Carry primaries through the contract (DONE, `8d5557e`)

The availability gate in `source-contract.ts` no longer names BT.709: it asks
whether a gamut matrix can be derived and whether the YUV matrix is
implemented. P3, BT.2020, 170M and 470BG renditions are offered; PQ and HLG
are still refused pending step 6.

`raw-planes.ts` keeps its primaries equality check, and should. It is not a
709 restriction -- it catches a decoder disagreeing with the container about
the gamut, which is still a fault. The renderer converts from whatever the
contract declares.

Trap found here: the contract normaliser strips separators, which flattened
`bt2020-ncl` into `bt2020ncl` and would have failed reconciliation against
WebCodecs' canonical spelling. Restored after normalising.

### 5. Stop flattening in the worker (DONE, `709b159`)

Done. A source whose primaries, matrix and transfer are all renderable is
preserved: no colour filter runs and the proxy is tagged as what it is.
Verified end to end on a synthesised P3 source -- proxy args carry no zscale,
and the encoded file's `colr` box reads primaries 12 (SMPTE 432), which is the
box mediabunny reads to build the WebCodecs config.

Range is deliberately NOT preserved: it is a coding convention rather than a
property of the picture, and a full-range proxy is misread by players that
ignore the flag, which would break the native path every share viewer falls
back to. A full-range source gets a zscale that requantises and nothing else.

The watermark render inherits the proxy's space by probing it, rather than
re-asserting BT.709 as it used to.

The policy, for reference:

- **P3-D65 SDR**: preserve. H.264 VUI can signal `colour_primaries = 12`
  (SMPTE 432) and WebCodecs reports `smpte432`, so it survives to the player.
- **BT.2020 SDR**: preserve by the same mechanism; rare, but free once P3 works.
- **BT.601 / SD**: preserve. David's call, 2026-07-26: preserve over convert
  as much as possible. The renderer already has the 601 matrix, and preserving
  skips a generation of resampling. It touches the most existing media of
  anything here, so it lands last of the SDR spaces and with its own oracle.
- **HDR (PQ/HLG)**: still tonemapped to 709; step 6.

Every preserved space needs its proxy correctly tagged, and the trap in
[[onelight-safari-reference]] applies -- `-color_primaries` alone does not reach
the H.264 VUI without `-x264-params colorprim=...`.

### 6. HDR through the reference renderer (NOT STARTED, and larger than it looks)

Worth being precise about, because "add PQ and HLG to the shader" undersells it
by an order of magnitude. HDR *playback* already works: `hdr_hevc` / `hdr_av1`
renditions play natively via `qualifyNativeHdr`. What is missing is HDR through
the REFERENCE renderer, i.e. frame-accurate stepping and scrubbing with a known
transform. That needs, in rough order of cost:

1. **A 10-bit plane pipeline.** `raw-planes.ts` accepts 8-bit I420 and NV12
   only; HDR is 10-bit (I420P10, P010). This means new accepted formats, R16
   textures and UNSIGNED_SHORT uploads in the renderer (the existing
   `bytesPerPixel: 1 | 2` is groundwork, not the feature), and shader
   normalisation against 1023 rather than 255. On its own this is comparable
   in size to everything in steps 1 to 5.
2. **PQ (ST.2084) and HLG EOTFs**, in the shader and mirrored on the CPU for
   the oracle. Straightforward once the samples arrive intact.
3. **Somewhere to put the result.** Either an HDR canvas (`rec2100-pq`, thin
   and inconsistent engine support today) or a defined tone-map to SDR. If
   tone-mapping, match the worker's `tonemapping=bt.2390` so the reference
   render and the tonemapped proxy agree rather than disagreeing subtly.
4. **The contract**, which currently excludes `hdr_hevc` and `hdr_av1` by kind
   before any colour reasoning happens.
5. **Fixtures and oracles**, which do not exist for HDR at any bit depth.

Until this lands, HDR sources get a tonemapped SDR proxy for review and the
native HDR rendition for viewing, which is the behaviour that has always been
there.

### 7. QA (partly blocked on cost)

The oracles are all 709. The gamut maths is covered by unit tests that check
the derivation against published matrices, which is the strongest evidence
available without new fixtures.

A GL-versus-CPU gamut parity gate was attempted and reverted. The approach
works -- relabel the run's own decoded planes as P3 or BT.2020, render, and
compare against the CPU transform, exactly as the BT.1886 pass isolates the
transfer stage -- but the gamut path costs two `pow` chains and a matrix per
pixel where the passthrough costs nothing, and two extra full-frame renders on
CI's software rasteriser took the probe from 1.3 s to over 40 s. Doing it
properly means rendering a small patch rather than a full frame. Worth having;
not worth a flaky 40-second gate.

Note the existing fixture drift: `bars-bt709.mp4` does not match its
checked-in oracle and is stale, not a bug.

## Unfinished nearby

The project-level display transfer (migration 0027) has a column, a schema and
a player prop, but the projects API does not expose it and there is no settings
UI, so `projectDisplayTransfer` is always null in practice. That is a small,
self-contained piece of work independent of everything above.
