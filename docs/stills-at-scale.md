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
