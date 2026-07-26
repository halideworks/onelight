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

### 3. Output space, not just sRGB (PARTLY DONE, `2dbc24d`)

The renderer takes an `outputColorSpace` option, asks the context for
`display-p3`, reads the property back to see whether it was honoured, and
reports the result as `outputPrimaries`; every frame is converted into that.

**Still to do:** nobody passes the option yet. It needs a display capability
probe (`matchMedia("(color-gamut: p3)")`) and a decision about who owns the
choice -- almost certainly the same resolution chain as the transfer, since
"render P3 content on a P3 display" is a preference a room will want to fix.

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

### 5. Then, and only then, stop flattening in the worker

`needsBt709Conversion` becomes a narrower question. The policy worth having:

- **P3-D65 SDR**: preserve. H.264 VUI can signal `colour_primaries = 12`
  (SMPTE 432) and WebCodecs reports `smpte432`, so it survives to the player.
- **BT.2020 SDR**: preserve by the same mechanism; rare, but free once P3 works.
- **BT.601 / SD**: preserve. David's call, 2026-07-26: preserve over convert
  as much as possible. The renderer already has the 601 matrix, and preserving
  skips a generation of resampling. It touches the most existing media of
  anything here, so it lands last of the SDR spaces and with its own oracle.
- **HDR (PQ/HLG)**: step 6.

Every preserved space needs its proxy correctly tagged, and the trap in
[[onelight-safari-reference]] applies -- `-color_primaries` alone does not reach
the H.264 VUI without `-x264-params colorprim=...`.

### 6. HDR through the reference renderer

PQ (ST.2084) and HLG are transfer functions the shader can implement, but they
need somewhere to put the result: an HDR-capable canvas, or a defined tone-map
to SDR. This shares all of step 3's plumbing, which is why gamut and HDR should
be built as one "output path" phase rather than twice.

### 7. QA

The oracles are all 709. Each preserved space needs its own fixture and
checked-in oracle, generated the same way `color-check-bt709.mp4` was. Note the
existing fixture drift: `bars-bt709.mp4` does not match its checked-in oracle
and is stale, not a bug.

## Unfinished nearby

The project-level display transfer (migration 0027) has a column, a schema and
a player prop, but the projects API does not expose it and there is no settings
UI, so `projectDisplayTransfer` is always null in practice. That is a small,
self-contained piece of work independent of everything above.
