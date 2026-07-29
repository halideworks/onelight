# Stills at scale: 3000-image ingest, batch versioning, and delivery

Status: built, 2026-07-29. `e63bf7d`, `6820e56`, `7a0e413`, `dcfcb84`.
The measurements below are what the plan was derived from; what shipped, and
what did not, is at the end under "What shipped".

Origin: a working photographer's two complaints about frame.io.

1. "There is a limit on how many images you can upload to review and there is a
   limit on how many you can download. So if we have a project with 3000 images
   I can't use it, and if we have one with like 1200 I have to get approval on
   frame and deliver via Dropbox."
2. "When we make updates to a batch, I think you have to drag the version 2s on
   top of the version 1's and it takes a lot of time."

Frame.io's limits are policy. Ours would be throughput, payload shape, and two
outright bugs. This document is what was measured, then what to build.

## What was measured (2026-07-29, nyx, load 0.32)

All timings from a real ffmpeg run in the worker image on a synthetic 6000x4000
(24 MP) source, which is a conservative stand-in for a modern stills camera.

| Step | Command as shipped | Time | Output |
|---|---|---|---|
| probe | `ffprobe -show_streams -show_format` | 72 ms | - |
| still_tiles | `scale=w=min(iw,4096):h=-2` to PNG | 444 ms | 1.8 MB |
| same, to JPEG q3 | `scale=...` to .jpg | 217 ms | 470 KB |
| poster | `-ss 0.004 ... thumbnail=100,scale=640:-2` | 86 ms | **nothing** |

Real renditions in the production database today (two image assets):

```
still_tiles   512 KB    6mwej1.jpg          <- no poster row exists
still_tiles  14.2 MB    a_iaf_boxart.png
poster        1.15 MB   a_iaf_boxart.png
```

### Bug 1: JPEG stills get no poster, ever

`buildSidecarArgs`'s poster branch seeks to `posterSeekSeconds()` and runs
`thumbnail=100` before the scale. On an mjpeg single-frame input this emits zero
frames: ffmpeg reports `Output file is empty, nothing was encoded`. On a PNG
input the same command works. Reproduced directly, and the production rows above
are the same asymmetry: the .jpg asset has no poster row.

Consequence: `posterUrlsFor` and `assetWire` expose the poster only, so every
JPEG asset shows as a monogram card in the project grid, the share room, and the
unfurl. The most common stills format in the world has no thumbnail. Readiness
does not catch it because `primaryRenditionKinds("image")` is satisfied by
`some()`, and still_tiles succeeds.

### Bug 2: still_tiles is a 4096-wide PNG and is also the review file

`planRenditions("image")` produces `still_tiles.png` at up to 4096 wide (the
`-q:v 2` is silently ignored by the PNG encoder), and the review room loads that
exact file to look at the picture. 14.2 MB for one boxart PNG in production.
At 3000 images this is 5 to 40 GB of derived PNG that also has to cross the wire
every time a reviewer opens an image.

### Wall 1: the media pump is serial and paced at one job per second

`apps/server/src/worker-pump.ts` runs a `setInterval(1000)` tick behind a single
`active` re-entrancy guard. Each tick claims **one** job (`claimNextJob`) and
awaits it to completion. `pollWorker` asks the worker for status every 1000 ms,
so even an instant job costs about a second. Every version needs two jobs (probe
enqueues transcode).

3000 images = 6000 jobs = a floor of roughly 100 minutes of pure poll latency,
before any work, on a machine whose actual work per image is under 700 ms and
which has four cores sitting idle the whole time.

The job claim itself is already safe for concurrency: it is a conditional UPDATE
that repeats every claimability predicate, so a losing racer matches zero rows.
The worker also already accepts concurrent jobs (a per-job-id map, `void
runJob`). Only the pump serializes.

### Wall 2: the browser uploader is serial and refetches the list per file

`packages/web/src/lib/upload.ts` plus the project page's `pump()`:

- One file at a time. Four parts in parallel inside a file, which does nothing
  for an 8 MB JPEG (one part).
- Five HTTP round trips per file: create session, start multipart, list parts,
  PUT part, complete. Then a sixth to create the asset.
- `await loadAssets(id)` after every single file: a 100-item list fetch, 3000
  times, which also resets the grid to page one each time.
- One `<li>` per queued file with an `URL.createObjectURL` preview, never
  virtualized. 3000 rows, 3000 live blob URLs, 3000 decoded images.
- Every created asset writes a project event, so every other connected client
  gets 3000 SSE messages and issues its own refetches.

### Wall 3: the share room ships and renders every asset

`GET /s/:slug/assets` returns the whole asset list in one payload with no
pagination, and `routes/s/[slug]/+page.svelte` renders `{#each assets}` with no
virtualization. A 3000-image share is a dead page.

### Download: no count limit, but three sharp edges

The zip writer (`packages/core/src/zip.ts`) is genuinely good and needs no
rewrite: store-only, zip64 per entry and per archive (so more than 65535 entries
and entries over 4 GiB are fine), deterministic layout, exact Content-Length
before a byte is written, ETag, and honest 206 range resume with a CRC cache.
There is no 1200-file ceiling anywhere.

What does break at 3000:

1. `GET /projects/:id/zip?asset_ids=a,b,c...` passes the selection in the query
   string. 3000 ULIDs is about 81 KB of URL. Caddy and Go tolerate it; the
   Cloudflare deployment (16 KB URL cap) and any nginx in front of a self-host
   (8 KB default) do not.
2. One 150 GB zip is a bad delivery unit even when it resumes correctly. A
   client on hotel wifi needs parts.
3. The share room's bulk download drives the browser's download manager one file
   at a time, which is 3000 save dialogs' worth of trust in Chrome not to
   throttle.

### Versioning today

There is no batch path. The uploader gives every queued row a "New version
of..." dropdown (`AssetSelect`) populated from the loaded asset list, and
`POST /assets/:id/versions` is one call per file that also writes a project
event and a notification fan-out to every prior uploader plus every project
manager. For 1200 files that is 1200 dropdown picks and 1200 notifications.
Better than dragging v2 onto v1, but the same order of work.

## The plan

Four phases. Each is independently shippable and independently useful.

### Phase S0: correctness and payload shape (small, ships first)

1. **Fix the still poster.** For `assetKind === "image"`, drop the seek and the
   `thumbnail` filter entirely: the first frame is the only frame. Add a
   contract test that asserts a poster row exists for a JPEG source, and a
   worker unit test on the arg builder. Backfill: a one-shot sweep enqueues
   poster jobs for existing image versions that have none (the watermark sweep
   is the pattern to copy).
2. **Give stills a rendition ladder** instead of one 4096 PNG:
   - `still_thumb`: 480 px long edge, AVIF with a WebP fallback, for grids and
     share cards. Target under 40 KB.
   - `still_review`: 2048 px long edge, JPEG q90 (measured 217 ms, 470 KB at
     4096; smaller and faster at 2048), which is what the review room loads.
   - The original stays the 1:1 zoom source, served through the existing signed
     media path with byte ranges, fetched only when the viewer goes past 100 %.
   - Keep `still_tiles` as a legacy kind so already-transcoded versions still
     resolve; new versions stop producing it.
3. **Poster fallback in the wire mappers.** `posterUrlsFor` and the internal
   asset media resolver fall back through `still_thumb`, `poster`, then
   `still_tiles`, so a half-migrated library never shows a monogram.
4. **Virtualize the three lists that can reach 3000 rows**: the upload queue,
   the project grid/list, and the share room grid. Object URLs are created for
   visible rows only and revoked on scroll-out.
5. **Stop the per-file list refetch.** `POST /projects/:id/assets` already
   returns the created row; splice it in. Coalesce inbound SSE `asset.created`
   events into one refresh per 500 ms window.

Acceptance: a 3000-image project's grid scrolls at 60 fps with under 200 live
DOM cards; every JPEG has a thumbnail; opening an image in review transfers
under 1 MB before the 1:1 zoom.

### Phase S1: ingest throughput

Target: 3000 JPEGs (about 24 GB) from drop to fully ready in under 10 minutes on
four cores, with the pump never taking more than a configured share of the box
(nyx runs production on the same four cores).

1. **Concurrent pump.** Replace the single `active` guard with a slot pool of
   `MEDIA_CONCURRENCY` (default `max(1, cores - 2)`, env-overridable, 1 restores
   today's behavior). Each slot claims and runs independently; the claim is
   already atomic. Exports keep their own single slot so a long PDF cannot head
   of line block media, which is the bug the current comment documents.
2. **Kill the poll floor.** `pollWorker` backs off from 100 ms rather than
   sitting at 1000 ms, and the worker's `GET /jobs/:id` grows a `?wait=25` long
   poll that holds the connection until the job finishes or the deadline. A
   sub-second job then costs a sub-second round trip.
3. **One job per still, not two.** Add job kind `stills` that probes and renders
   the ladder in one worker call for `kind === "image"`. Halves the job count and
   removes a full pump round trip per image.
4. **Batch the job.** `stills` accepts up to 64 versions per job and the worker
   loops them in one process. Per-job overhead (HTTP, signature, DB writes,
   lease heartbeats) amortizes to nothing; 3000 images become about 47 jobs.
   Partial failure is per-item in the result payload, not per-job.
5. **Upload path, client side:**
   - `UPLOAD_FILE_CONCURRENCY` of 4 to 6 files in flight, sharing a global part
     budget so large files do not starve.
   - `POST /uploads/direct`: one request that carries the bytes, completes the
     session, and returns the created asset, for files at or under the part size.
     Five round trips become one for a typical JPEG.
   - `POST /projects/:id/assets:batch`, up to 500 `upload_id`s: creates all rows
     in one transaction, enqueues one batched stills job, writes **one**
     `assets.created_batch` project event, and one aggregated notification.
6. **Aggregate the event and notification storm.** A batch writes one event with
   a count and a sample, not 3000. The SSE consumer learns `assets.created_batch`
   and does a single refresh.

Acceptance: an integration test uploads 3000 small JPEGs and asserts wall clock
under a threshold, one project event, one notification per recipient, and 3000
ready versions with a thumb, a review still, and a poster each.

### Phase S2: batch versioning (the second complaint)

The interaction to beat: drop 1200 files, get "1,187 of these look like new
versions of assets already here. Upload as versions?" and press one button.

1. **Schema.** `assets.stack_key TEXT NOT NULL DEFAULT ''` plus an index on
   `(project_id, stack_key)`. Derived on create and on rename from the asset
   name: lowercase, drop the extension, strip trailing version tokens
   (`_v2`, `-v02`, `_r3`, ` copy`, ` copy 2`, `.2`, `_final`, `_rev2`), collapse
   whitespace, underscore and hyphen runs to one separator. The rule lives in
   `packages/core` with property tests, because both the API and the client show
   its output to a human.
2. **`POST /projects/:id/versions:match` (dry run, no writes).** Body is a list
   of `{filename, relative_path, upload_id?}`. Returns for each: the matched
   asset id, the rule that matched (`exact-name`, `stack-key`,
   `stack-key-in-folder`, `stem-different-extension`), a confidence, or a reason
   for no match. Anything matching more than one asset is returned as a conflict
   with the candidates, never auto-resolved. Folder-scoped matching wins over
   project-wide.
3. **`POST /projects/:id/versions:batch` (commit).** A list of
   `{upload_id, asset_id, carry_forward}`. In one transaction per chunk: insert
   versions, advance `current_version_id`, carry unresolved comments forward,
   enqueue one batched stills job, write one `asset.versions_created_batch`
   project event, and one aggregated notification per recipient ("Jane added
   version 2 to 1,187 assets in Day 3 selects"). Same conflict rules as the
   single endpoint, reported per item.
4. **Uploader UI.** On drop, call the dry run before a byte moves. The queue
   grows a header:

   ```
   1,187 of 1,200 files match assets already in this folder.
   [ Upload as new versions ]  [ Upload as new assets ]   13 unmatched, 2 ambiguous
   ```

   The unmatched and ambiguous rows expand into a table where the existing
   per-row dropdown still overrides anything. Carry comments forward is one
   checkbox for the batch, per-row overridable. The choice is made once.
5. **Undo.** A batch version commit records its event id; `POST
   /projects/:id/versions:batch/:event_id/undo` within the session drops the
   versions it created and restores the previous `current_version_id`. Stacking
   1200 files the wrong way must not be a manual repair job.

Acceptance: contract tests for the matcher's rules and its refusal to guess on
ambiguity; a test that 1200 uploads stack in one call, produce one event and one
notification, and undo cleanly.

### Phase S3: the stills review and delivery instrument

This is what makes it better than frame.io rather than merely unlimited.

1. **Next and previous in the review room.** The room takes the folder's ordered
   asset list and steps through it with the arrow keys, prefetching the next
   two review stills. It does not exist today: reviewing 3000 images means
   returning to the grid 3000 times.
2. **Keyboard triage.** `A` approve, `X` changes requested, `U` unset, arrows to
   move, `Z` to hold 1:1 zoom. Status writes are queued and batched to the
   existing bulk status endpoint. A client can approve a 3000-image shoot in one
   pass without touching the mouse.
3. **Selects.** A per-asset flag distinct from approval status (photographers
   pick before they approve), filterable in the grid and exportable as a list of
   filenames (CSV and plain text) for the retoucher. This is the artifact that
   currently gets rebuilt by hand in a spreadsheet.
4. **Compare.** The still viewer already loads the previous version for A/B.
   Add wipe and onion-skin with synchronized zoom and pan, which is how a
   retouch round is actually judged.
5. **Delivery.**
   - `POST /projects/:id/downloads` takes a manifest (asset ids, folder,
     filters), returns a short-lived token; `GET /downloads/:token/zip` streams
     it. Kills the 81 KB query string and works on Cloudflare.
   - `?part_size=25GB` partitions the entry list into N standalone archives,
     each with its own exact Content-Length and its own resumable range, named
     `Project (1 of 7).zip`. Deterministic partitioning, so part 4 is the same
     bytes on every request.
   - The share room offers the same manifest zip alongside the existing one at a
     time loop, under the share's existing `allow_download` policy.
6. **Formats a stills project actually contains.** `assetKind` today knows
   `jpg jpeg png tif tiff webp exr dpx`. Add `heic heif avif` and the RAW family
   (`cr2 cr3 arw nef dng raf orf rw2 pef srw`), rendered through libraw or
   dcraw_emu to the same ladder, with the embedded JPEG preview as the fast path
   and a full demosaic only for the 1:1 view. Note that `gif` currently falls
   through to `kind: file`.

Acceptance: a 3000-image share room loads in under 2 seconds to first cards; a
reviewer can traverse and approve the whole set from the keyboard; a 3000-file
delivery downloads as resumable parts at disk speed and each part opens in
Windows Explorer, macOS Archive Utility, and 7-Zip.

## Order and rough effort

| Phase | Effort | Unblocks |
|---|---|---|
| S0 | 2 to 3 days | Every JPEG has a thumbnail; grids survive 3000 rows |
| S1 | 4 to 6 days | 3000 images ingest in minutes, not hours |
| S2 | 4 to 5 days | The second complaint, entirely |
| S3 | 1.5 to 2 weeks | The claim that this is the best stills review tool |

S0 and S1 are the "no limits" answer. S2 is the "no dragging" answer. S3 is the
reason to switch rather than merely the absence of a reason not to.

## Constraints to respect

- nyx runs production on the same four cores. `MEDIA_CONCURRENCY` defaults
  conservatively and every new sweep is bounded per pass, as the watermark and
  shuttle-audio sweeps already are.
- The still ladder is a new rendition kind set: migrations must be D1-safe and
  the embedded migration copies stay in parity (`pnpm db:check`).
- Every new endpoint lands with contract tests in `packages/api/src/contract/`
  and a regenerated `openapi.json`.
- The review room's neutrality rule still holds for stills: the contact sheet and
  the still viewer are grey. The share room in presentation mode is not.

## What shipped

All four phases, then the three formats and the compare mode that the first
pass left out, then a full review of the lot. Gates green at every commit
(typecheck, eslint, prettier, the Node suite, the D1 conformance leg,
db:check, openapi:check, svelte-check).

**S0, `e63bf7d`.** The stills renderer (`packages/worker/src/stills.ts`), on
sharp, with ffmpeg as the decoder for PSD, EXR and DPX. EXIF orientation is
applied and the ICC profile is converted to sRGB rather than ignored. The
ladder is a 640 JPEG poster and a 2048 WebP review still; `still_tiles` is
retired but still read. Migration 0028. A bounded sweep backfills every image
version that has no `still_review`, which is both the JPEGs that never got a
poster and everything transcoded before the ladder. The upload queue, the
asset browser and the share room are windowed on measured cell geometry
(`packages/web/src/lib/virtual.ts`, unit tested); the queue holds a budget of
object URLs; upload progress keeps running totals instead of walking the
queue; the share room is paged, and the share endpoints that hold one asset or
one comment ask for that row instead of reading the whole share.

**S1, `6820e56`.** `MEDIA_CONCURRENCY` slots in the pump, defaulting to cores
minus two, each claiming its next job on completion. Exports get their own
slot. The worker holds a status read open until its job settles. A still is
probed and rendered in one call. `POST /projects/:id/uploads/direct` takes a
small file whole; the browser uploads four at a time and lands them through
`POST /projects/:id/assets/batch`, one project event per batch. The resume
ledger is bounded.

**S2, `7a0e413`.** `assets.stack_key` (migration 0029) plus the normalizer in
`packages/core/src/stack-key.ts`, which strips version tokens and never strips
a bare trailing number. `POST /projects/:id/versions/match` is a dry run that
refuses to guess on a tie; `POST /projects/:id/versions/batch` commits with one
event and one notification. The uploader shows the offer as one line and one
button and holds only the landing, not the transfer, while it is open.

**S3, `dcfcb84`.** Next and previous in the review room over the folder's own
order, with the next picture prefetched; A/X/U/R decide, S shortlists, `[` and
`]` move. Selects are a column (migration 0031), filterable in the grid and
exportable as a plain list. Deliveries are POSTed manifests downloaded by token
(migration 0030), split into whole-file parts. `GET /versions/:id/still-full`
answers with the original where a browser can decode it and renders a
full-size rung once where it cannot.

### Left out of the first pass, built after it

- **Compare**: the wipe and the blink were already there, and both already
  ride the picture's own transform, so a comparison at 400% compares the same
  400% of both versions. What was missing was onion skin, which is now the
  third mode; see the end of this document.
- **RAW, HEIC and PSB**: built, see "The rest of the formats" below.

## Measured on the built stack (2026-07-29)

An isolated compose project with both images rebuilt, MEDIA_CONCURRENCY=2, on
nyx's four shared cores. Sources are 1600x1067 across the four formats.

| | |
|---|---|
| 300 stills, upload | 3.8 s (direct path, 4 concurrent) |
| 300 stills, ingest | 259.6 s for 312 versions and 312 jobs, 0 failed |
| per still | 865 ms, with the harness polling the list on the same cores |
| assets with no poster | 0 |
| orientation 6 fixture | renders 1067x1600 portrait, `rotated: true` |
| still-full, jpg and png | the original, no rendition made |
| still-full, tif and psd | rendered once, on request |
| second pass, 12 files | 12 matched, 0 ambiguous, landed as v2 in one call |
| delivery | 445.6 MB as 7 parts; part 1's bytes matched its declared length |

The run is what found the bug fixed in `4e22d09`: a targeted on-demand
rendition job was running the full completion path and marking a perfectly
good version failed. No test in the suite could see it.

## The rest of the formats

Three formats were left out of the first pass because nothing in the worker
image could decode them. All three are in now.

**RAW** goes through libraw's own `dcraw_emu` (`libraw-bin`): a half-size
demosaic, which is plenty for a 2048 review still and several times faster
than a full one, with the white balance the photographer set in camera rather
than a guess. Twenty-three extensions, from `cr2` and `cr3` to `iiq` and
`3fr`. The decoder writes netpbm rather than TIFF, and the result is read by
`packages/worker/src/netpbm.ts`: libvips opens a sharp-written 16-bit TIFF
perfectly and refuses dcraw's, which is a fight with someone else's tag layout
that nobody needs to have. netpbm has no tags at all.

**HEIC and HEIF** go through `heif-dec` (`libheif-examples`), which is the only
decoder here that opens them. This is what every iPhone since 2017 hands over,
so a phone shooting alongside a camera now lands in the same folder.

**PSB** is read directly, by `packages/worker/src/psd-image.ts`. ffmpeg's PSD
decoder refuses any container whose version is not 1, and PSB is version 2;
the two formats are otherwise the same file with three fields widened. The
reader takes both, so a PSD now has two independent paths: read directly, and
ffmpeg if that fails on some file it cannot make sense of. What it reads is
the composite, which is the picture Photoshop writes for software that is not
Photoshop; a file saved without maximise compatibility has none, and the
reader says so rather than guessing.

Both new decoders are decoders only. The ladder is still rendered by sharp, so
orientation, colour and the rungs behave the same whatever opened the file.

Fixtures are synthesized in the tests, because a camera file cannot be
committed: the DNG is written from the format's own documentation (a Bayer
mosaic plus the tags libraw needs), and the HEIC is encoded by libheif and
decoded back. Writing that DNG turned up the trap worth knowing: a TIFF value
of four bytes or fewer lives in the entry itself, and writing an offset there
instead makes libraw read the offset as the CFA pattern and demosaic a
two-colour sensor.

## Compare, finished

The still viewer already wiped and blinked, and both already rode the
picture's own transform: the comparison lives inside the same plate as the
current version, so a wipe at 400% is comparing the same 400% of both. What it
could not do was lay one version over the other.

Onion skin is the third mode, on `O`, with an opacity slider that defaults to
half. Half is the useful default because at half anything that moved reads as
a double edge and anything that did not reads as one, which is the question a
retouch round actually asks. The three modes answer three different questions:
the wipe is the honest side-by-side, the blink catches a small shift that is
invisible side by side, and the onion catches alignment.

## What the review found

Reading the whole campaign back (`6475488`, `259e8fd`) turned up nine
defects that no test could see, which is the argument for reading it:

- The media concurrency cap could be overshot, because the slot was counted
  after the claim rather than before it and two callers reach that gate at
  once whenever a job finishes while the tick is also looking for work.
- The re-kind sweep could never see past its first batch: rows that are not
  stills stay files, so the same two hundred were read every pass.
- sharp was opening files with its pixel limit disabled, which turns a
  decompression bomb into a dead worker. Uploads reach it from transfer
  links, so that bound is a security property.
- Two jobs can legitimately render the same version at once and shared a
  decode temp path, so one could delete the intermediate the other was
  reading.
- A file dropped while an attach batch was landing could be stranded.
- The stack key backfill drained too slowly to be safe: batch versioning
  matches against that column, and an upload arriving first silently matched
  nothing.
- A filename of ".." named the directory above the upload rather than a file
  in it.
- Stepping through a folder threw the sibling list away and re-paged it at
  every asset, so the next button got slower the further into a shoot you
  went.
- A newly landed upload was spliced into the grid even when the grid was
  filtered to the shortlist.

The test for the re-kind sweep is worth singling out: the first version of
it passed against the broken code, because the rows it looked for happened
to be inserted first. It now inserts two hundred and fifty plain files ahead
of them, and fails without the fix.

## Matching by what a file is, not what it is called

Name matching covers the ordinary case and misses the one that hurts: a
retoucher renames everything, and `DSC_1234.NEF` comes back as
`Smith_Wedding_047_final.tif`. Two further identities close that gap, and they
are trusted very differently. Both work for clips as well as frames.

**Capture identity is exact.** A photograph carries the instant it was taken to
the sub-second plus the body that took it; a clip carries its creation time,
its camera tags and its source timecode. A re-export from Lightroom or Resolve
keeps them, and two frames a second apart differ in the field itself, so this
cannot slide onto the neighbouring frame. It decides on its own. A key two
assets share is a conflict, like any other tie. It is nearly free: sharp
already hands us the EXIF block on every still we decode, and ffprobe already
gives us the format tags on every clip.

A creation time on its own is not enough to pair on, and the code says so: a
batch export stamps a hundred files with the same second, so the key needs a
sub-second, a body or a timecode beside it or there is no key.

**The picture itself only ever narrows.** A 64 bit difference hash, measured on
this machine:

| pair | distance |
|---|---|
| a frame against its own retouch | 1 |
| a frame against the next frame of the same burst | 3 |
| a frame against a different set-up | 35 |

That is the whole argument for how it is used. Against unrelated content the
signal is enormous; against the frame beside it in a sequence, 1 versus 3 is
noise, and a shoot is nothing but sequences. So a threshold alone would pair a
burst with itself, which is the same catastrophe as stripping a trailing
number. The winner must beat the runner up by a clear margin, and if it does
not, the answer is ambiguous with its candidates rather than a guess.

A clip is signed at sixteen points along its own length rather than once,
because two takes of the same set-up share an opening frame and diverge later,
and because sixteen samples are enough to be a shot list rather than a
signature (see below). Each point is a seek; a flat sample (black, a fade, a
white card) is dropped, because otherwise every clip with a fade in it looks
like every other.

The first version took those points out of the sprite the pipeline already
builds, for free. That was wrong and the arithmetic says so: the sprite's tiles
sit at fixed fractions of the duration that only coincide with the sampling
positions when the tile count happens to line up. It was deleted rather than
patched.

Uploads are fingerprinted by a worker job in batches while their bytes are
already on their way, so the offer in the uploader improves under the reader
rather than making them wait: the name tier answers before a byte moves, and
the other two arrive a moment later. A bounded sweep does the same for a
library that predates any of this.

### Proved on a running stack

An original frame, the frame beside it in the burst, and a clip, all landed as
assets. Then a second pass under names sharing nothing with them:

```
Smith_Wedding_047_final.jpg -> DSC_1234.jpg   [capture-time]
no-metadata-at-all.png      -> (no match)     [ambiguous] distance 1
Reel1_graded_v2.mp4         -> A001C001.mp4   [capture-time]
```

The renamed retouch found its original with no help from its filename, and so
did the re-graded clip. The third is the safety property doing its job: with
its metadata stripped, that same retouch sits one bit from the right frame and
three from the frame beside it, so the matcher refuses to choose and hands back
both. Before the clips were given a creation time, the same run matched the
video perceptually at distance 1, so both tiers are proved for both kinds.

Two bugs came out of running it rather than reading it. The pump read the
worker's answer from the top level when everything the worker returns is
nested under `result`, so every fingerprint job died three times and went dead;
there is now a test that drives the real pump against a stand-in worker over
HTTP, and it fails without the fix. And the first version fingerprinted stills
with sharp directly, which cannot open a PSD, a RAW or a HEIC: the formats most
likely to arrive as a renamed second pass were the only ones with no identity
at all. It routes through the same decoder as the ladder now.

## Post production, where none of the above is true

Everything above assumes a camera. Post does not have one. A timeline export
carries no body, no lens and no capture instant: what it carries is the moment
somebody hit render. Four spots cut for the same campaign are all fifteen
seconds, all start at `01:00:00:00`, and were all exported the same afternoon,
so length, timecode and creation time say the same thing about all four. The
first version of the matcher would have paired them confidently and at random.

Four changes make the post case work.

**The name tier learned the convention.** Files are commonly named
`DATE_TIME_TIMELINE NAME`, as in `20260729_1515_jonmusicvideo.mov`, and the
stamp is the one part guaranteed to change between v1 and v2. A leading
date-time stamp is now dropped before the key is taken, and so are inner
version tokens including point releases, so `20260729_1515_jonmusic.mov`,
`20260801_0902_jonmusic.mov` and `jonmusic_v5.58.mov` share a key. Everybody
has a variation on the convention, so the stamp matcher is deliberately loose
about separators and takes the time part only if it is there. A bare trailing
number is still never stripped: `spot_01` and `spot_02` are two spots, and that
rule has not moved.

**Capture identity now demands a camera.** A rendered timeline is given no
identity at all unless something in the tags names a body, and the generic
start timecodes (`00:00:00:00`, `01:00:00:00`, `10:00:00:00` and their
drop-frame spellings) are treated as saying nothing. This is a deletion, not an
addition: the tier used to answer on a render time alone, which is precisely
the answer that pairs four spots at random. It now stays quiet and lets a lower
tier speak.

**Sound identifies a grade.** A colour pass rewrites every pixel and does not
touch one sample of the audio. So a loudness contour, sixty-five windows of RMS
taken over the whole clip and hashed the same way a picture is, is identical
across a re-grade and different across two cuts. It sits above the picture
tiers for exactly that reason, and it refuses when more than one asset shares
the track, because a music video is nothing but cuts of one song. Silence
yields no hash: a slate with no audio must not match every other silent clip.

**Shared footage identifies a re-edit.** When the positions no longer line up
at all, which is what a re-edit does to a clip's signature, the question stops
being *where* the frames sit and becomes *how many of them appear anywhere in
the other cut*. Sixteen samples give a shot list; the fraction of the incoming
list found within eight bits of anything in the candidate is the overlap. The
bar is high (60% shared, and a 20 point margin over the runner up) because this
is the tier operating where the pictures genuinely differ. Only clips reach it:
a single frame has no shot list, only a position, which the tier above already
judged.

So the order, strongest first, is: name, capture identity with a camera behind
it, audio, picture in position, shared footage. Reading that list as a story
about a job: the name answers when the convention held, the camera answers for
originals, the sound answers a grade, the position answers a retouch, and the
overlap answers a re-cut.

### What each tier costs

The audio contour is one ffmpeg pass with `astats` over a mono 8 kHz
downmix, no decode of the picture at all. `astats`'s `reset` counts frames
rather than seconds, so the window count is normalised in JS afterwards rather
than trusted from the filter. Sixteen seeks replace four; on the clips measured
here that is the difference between a fingerprint being free and it costing a
second or two, which is paid once per upload in a worker job.

### Proved on real media

A clip re-graded through `eq=brightness` matches its original's audio hash
inside the threshold, while a clip carrying a different soundtrack does not.
Silence yields null. A re-edit of the same material shows a positional
`contentDistance` far past the picture threshold and a `contentOverlap` at or
above 0.6 in the same pair, which is the exact shape the two tiers are there to
tell apart.

### Measured on the real library

Deployed, the backfill re-signed the library and the four spots that started
this are the proof. `BILLS_CC.mov`, `CARDINALS_CC.mov` and `EAGLES_CC.mov` are
all the same length, all start at `01:00:00:00`, and were all exported the same
afternoon. After the deploy their capture keys are null, correctly, and their
audio hashes are 28, 31 and 35 bits apart against a threshold of 6. Nothing
except the sound could have told them apart, and the margin is not close.

Two things came out of watching it run rather than reading it. Signing
twenty-five clips takes longer than the sweep's own minute, and the job's
idempotency key is its lead version rather than its members, so as soon as part
of a batch landed the boundaries shifted and the same clips were offered again
under a new lead: the machine signed five of them twice. The sweep now reads
what is already in flight. And a clip with no fingerprint at all turned out to
be an asset in the trash, which the sweep skips by design.

Then the tier itself, against the real library. `BILLS_CC.mov` was re-exported
the way an NLE does it: graded picture, video re-encoded to x264, audio
re-encoded to AAC at a different bitrate and sample rate. Its contour lands one
bit from the original it came from, and 28 to 34 bits from every other clip in
the library. Its capture key is null, so the tier that used to answer wrongly
now says nothing. The audio survives the re-encode because a loudness contour
is a shape, not a waveform.

One more thing the real library shows: an asset can legitimately hold versions
with different audio. Two uploads of the same World Cup cut share a hash to the
bit, and the Spanish master filed under the same asset does not. The audio tier
answers nothing there, which is correct, and the name tier already had it.

And the five clips the sweep left with no signature at all turned out to be
41 ms single frame HDR deliveries. Sixteen seeks into one frame is fifteen
seeks past the end, and ffmpeg writes nothing rather than failing, so the whole
signature was refused. The grid now shrinks for a clip too short to space
sixteen points a quarter second apart, down to a single point at the start when
there is one frame to sample. The count is part of the signature, so a short
clip is only ever compared positionally with another of the same count, which
is right: it is a still that happens to be in a container. Only in the shrunk
regime is a missing tail sample tolerated, because that is where the reported
duration and the last frame disagree; a clip long enough for the full grid
still samples all sixteen or none.

One consequence worth writing down: a version that got no signature is still a
candidate, but the job that failed to sign it left its key behind, and the key
is what stops the sweep offering the same work forever. So the scheme version in
that key has to move whenever the sampler changes, including when the change is
"it now signs clips it used to refuse". Deployed without the bump, the four one
frame clips stayed unsigned and the sweep was right to leave them: it had
already asked.

## The colour pass with no sound

The audio tier answers a grade because a grade cannot touch the audio. It
cannot answer the grade that arrives with no audio at all, which is common:
picture-only deliveries are normal in post. So what happens to such a file
today, and is the picture enough on its own?

Measured, thirty seconds of a real spot, sixteen samples, against grades of
increasing violence:

| what arrived | position | overlap | motion |
|---|---|---|---|
| mild lift | 0 | 1.00 | 2 |
| heavy contrast + saturation | 3 | 0.94 | 3 |
| s-curve | 4 | 1.00 | 3 |
| log to 709 | 1 | 1.00 | 3 |
| hue rotate 40 degrees | 1 | 1.00 | 3 |
| black and white | 2 | 1.00 | 1 |
| crushed blacks | 10 | 0.44 | 1 |
| **day for night** | **18** | **0.00** | **3** |
| reframed 5% | 10 | 0.31 | 4 |
| half resolution | 1 | 1.00 | 2 |
| re-edit of the same footage | 23 | 0.81 | 35 |
| trimmed 10 frames at the head | 2 | 0.94 | 23 |
| a different spot | 23 | 0.06 | 39 |

The difference hash is far more grade-robust than it looks like it should be,
and the reason is structural: each bit asks whether one pixel is brighter than
the next, so any tone curve that preserves order preserves the bit. Lifts,
gammas, s-curves, hue rotations and a black and white conversion all move it by
four bits or less out of sixty-four.

What breaks it is a grade that stops being monotonic in luma: **day for night**,
which pushes red down and blue up and then crushes the whole thing, moves the
picture 18 bits, past the threshold, and leaves not one sample within the
overlap tier's per-sample bar either. Nothing answered it. That is the case
this section exists for, and the thresholds cannot be relaxed to cover it: a
re-edit of the same footage and a different spot entirely both sit at 23.

### The motion contour

So add the signal a grade cannot touch: how much the picture changes from frame
to frame, over the whole clip. One number per frame, the mean absolute
difference at 160x90 greyscale, resampled to 65 windows and hashed the same way
the loudness contour is, each bit comparing one window with the next. Cuts are
spikes, camera moves are plateaus, a locked-off shot is a floor. That shape is
the edit.

The right hand column is the measurement. Every grade, including day for night,
moves it by **at most 4 bits**. The nearest thing that is not the same timeline
is **23**. The threshold sits at 10, with 13 bits of daylight on both sides.

It is deliberately a different question from the positional hash, and the two
cover each other:

- A trim of ten frames at the head is the same colour and a different timing:
  position says 2 bits (matches), motion says 23 (declines).
- Day for night is the same timing and a different colour: position says 18
  (declines), motion says 3 (matches).

Neither tier vetoes the other. Evidence is only ever recorded when it is within
its own threshold, so a conform change is answered by the picture and a
creative grade is answered by the cut.

Two guards keep it honest. A clip with fewer frames than windows has nothing to
contour. And a contour with no shape is worse than none at all: the hash asks
"is this window above the next", so a locked-off shot answers with whatever the
encoder's noise did, and two unrelated static clips can then agree by accident.
The spread between the high and low deciles must clear 8% of the contour's own
mean, relative because absolute motion units mean nothing across resolutions.
A grey card clip is refused, which is the same rule silence gets.

It costs one decode pass: 5.1 s for a thirty second 1080p clip on nyx, against
6.5 s for the sixteen seeks the positional signature already pays. It is
resolution-independent by measurement (half resolution moves it 2 bits), so it
compares across a proxy and a master.

## Solving the batch, not the file

The other half of the answer is that a delivery does not usually arrive alone.
Ten graded spots arrive for ten assets, and a pairing can be obvious when no
single distance in it is decisive. Deciding each file independently threw that
away, and worse: two files could each be told they were the new version of the
same asset, and both would stack onto it.

So the evidence tiers now solve the batch as a **stable matching**. Each file
proposes to the asset it has the best evidence for; an asset holds the best
proposal it has seen and turns the rest away; a file turned away proposes to
its next candidate. It ends with no file and asset wanting each other more than
what they each got, and with no asset holding two files.

Stable matching alone would still answer when nobody is distinguishable, so two
refusals sit on top of it. A pair is dropped if the file cannot tell its asset
from another one **that nothing else claimed**, and dropped if the asset cannot
tell its file from another one **left over**. Both are the old margin rule, now
asked of the pairing rather than the file. That keeps a renamed frame among a
burst ambiguous, exactly as before, while letting a campaign settle.

Proved in the contract suite with an instance built to be cruel: three spots
and three silent graded deliveries, each delivery one bit from its own spot and
three from the next nearest, which is the margin. Sent one at a time, every file
is refused. Sent as a batch, all three land on their own spot, and no asset
takes two. Nothing is ever taken by elimination alone: a pair still has to clear
the absolute threshold for its tier.

And nothing is a dead end any more. A file that could not be placed comes back
with the shortlist that was closest, so the answer is "pick one of these"
rather than "no match": the evidence was real, it just was not decisive.

### What it costs the box, and who pays

Watching the backfill run on prod: one fingerprint ffmpeg at 342% CPU on a four
core machine that also serves the site, at niceness 0. That is the motion pass
being a full decode of every clip in the library, and it is the wrong priority
for it: nobody waits on a fingerprint. The match endpoint is a dry run that
reports "pending" and gets asked again, and the backfill is a library being
catalogued.

So all three passes now run at niceness 19, the same as the software AV1
encode, and cap the decode at two threads. Both, because they do different
things: niceness makes the work yield the moment a request arrives, and the
thread cap stops one clip taking the machine on an otherwise idle box.

The cap is safe because the decode is deterministic: measured on the same file,
the per frame contour is bit identical at default threads, at two and at one
(checksum 1223.175175 in all three), and two threads was in fact the FASTEST of
the three on a busy box, 4.5 s against 6.9 s, because it stops fighting
itself.

### Proved against the real library

The whole case in one run. `BILLS_CC.mov`, the full 94 second spot, re-exported
with a day-for-night look, audio dropped, renamed `CLIENT_final_v3.mov`. It
carries no capture key, because it is a render, and no audio hash, because it is
silent. Then measured against every clip in the library:

```
asset                          position  overlap  motion
BILLS_CC.mov                         24     0.00       5   <- MOTION MATCHES
EAGLES_CC.mov                        32     0.00      22
CARDINALS_CC.mov                     31     0.00      35
everything else                   29-33     0.00   29-38
```

At full length the positional hash fails harder than it did on the thirty
second excerpt: 24 bits, and not one sample within the overlap tier's bar. Both
picture tiers are blind here. The motion contour answers with 5 against a
nearest rival of 22, which is 12 bits outside its own threshold. Without this
tier that delivery is a dead end; with it, it is a confident match on evidence
nothing about the file's name, time or sound could have provided.

The library also shows the guards working rather than failing: the six clips
with no contour are HDR bench fixtures of 1, 5 and 21 frames, which is fewer
frames than there are windows, plus a static colour bar chart, which has no
shape to hash.
