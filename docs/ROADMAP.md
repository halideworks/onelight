# Onelight roadmap

This is the working plan: where v1 stands, what hardening remains before tagging v1.0, and the forward phases from the design doc. The design doc (section 20) remains the source of truth for phase content; this file tracks execution state. Update it whenever a milestone lands or scope moves.

## Current state (2026-07-11)

v1 scope (phases 0-3) is implemented and feature-complete against the design doc. The build went through a full defect audit and repair pass (docs/audits/2026-07-11-v1-audit.md), a two-wave remainder build, and a full-gap build with three independent adversarial reviewers whose confirmed findings were all fixed. The current tree carries, on top of the audited phases:

- Contract coverage: 343 Node tests, 177 on the D1 workers pool, 114 permission matrix cells, cross-workspace isolation, OIDC flows, a folder-tree property test, and marker-exporter fuzz tests.
- Version stacking (POST /assets/:id/versions with carry-forward), the version drawer, mentions and hashtags, password reset with email, share management UI, asset browser (grid/list, hover-scrub, batch ops), directory uploader with parallel parts, review-room filmstrip and waveform lanes, live SSE updates on dashboard and review pages.
- Server maintenance: SMTP notification emails with instant/hourly/daily digests, upload-session reaping, trash purge with blob deletion, dry-run blob GC.
- Burned watermark path end to end; PDF report with annotated stills; OpenAPI with zod-derived schemas plus a committed generated client; server-side OG tags for share unfurls; public bootstrap endpoint.
- Cloudflare: R2 multipart storage (streamed parts), cron webhook delivery, SPA serving, per-isolate memoization.
- Verification harness: WebCodecs frame-accuracy ground truth across all eight rates, golden-frame color QC (Chromium and Firefox, WebKit in CI), tmcd round-trip, HDR PQ/HLG tonemap fixtures, plus a full-stack integration CI job (compose up, real upload/probe/transcode/serve/share/export/watermark/HDR round-trip, graceful-shutdown assertion).
- Hardening from the review round: TRUST_PROXY-aware client IP with rate-limit pruning, public share/comment projections (no passphrase_hash, viewer_key, or member emails on the wire), notification recipient re-authorization, bounded request arrays, escaped search wildcards, self-hosted fonts (no external CDN), and the player draw-mode and seek-verify frame-accuracy fixes.

All automated gates are green on this machine, including the qa suites executed against real ffmpeg-synthesized fixtures: typecheck, eslint, prettier, Node contract suite, D1 workers-pool suite, db:check, openapi:check, svelte-check, SPA build, qa, and the integration dry-run.

## Backups and the NLE round trip (2026-07-16)

- **Database backups.** `BACKUP_DIR` turns on periodic snapshots via SQLite's
  online backup API (`BACKUP_INTERVAL_MS`, default 6h; `BACKUP_KEEP`, default
  28), pruned oldest-first. docs/BACKUPS.md covers restore and the nyx layout
  (`/data/backups` on the fast tier, carried to the RAID hourly by the host's
  fast-replica.timer). Verified on the rig (15s interval, three snapshots,
  logged sizes) and live (first snapshot on boot).
- **The way back: marker files into comments.** `parseResolveEdl` and
  `parseMarkersCsv` in core (round-trip tested against the exporters), and
  `POST /versions/:id/comments/import` (commenter+, resolves timecodes against
  the version's own rate/start/drop, skips markers outside the duration,
  counts imported/skipped, no notification fan-out).
- **A place to export from.** `POST /projects/:id/export` is the share
  export's project-scoped twin, and the review page's notes rail grew an
  Export panel: format + timecode base, export-this-version (queues, polls,
  hands the browser the signed download), and an Import EDL/CSV picker.
  Browser-verified round trip on the rig: a marker at source 01:00:02:00
  lands as a note at 00:00:02:00 on a start-frame-86400 version, and comes
  back out in the next export.
- **Exports no longer need the media worker.** The pump used to be a no-op
  without WORKER_URL/WORKER_SECRET, which silently queued exports forever on
  worker-less installs; exports are DB-to-file work and now always run (the
  PDF already degrades to no stills).

## Identity in one place, and the settings rail (2026-07-17)

- **Avatars take any photo now.** The browser normalizes the picture to a
  512 px cover-cropped square JPEG (orientation baked in) before upload, so
  the server's byte cap stops being the user's problem; the e2e suite
  uploads a deliberately oversized photo as the regression net. Removing
  the picture is a plainly labeled button, and the avatar column holds the
  right side of the identity card. The topbar's bell and avatar now anchor
  the frame's right edge instead of trailing the width-capped search field.
- **The profile page is the identity page**: name, picture, the sign-in
  address (changing it takes the current password; `PATCH /users/me` grew a
  password-confirmed `email` field), the password (UI for the existing
  endpoint; other sessions die), two-factor, and deactivation
  (`DELETE /users/me`: password plus a code when two-factor is on, refuses
  the last active admin, kills sessions and API tokens, keeps notes
  attributed, admin can re-enable). Both endpoints contract-tested on both
  legs and browser-verified end to end, including the wrong-password paths
  staying in the form instead of bouncing to sign-in.
- **Settings is one room now**: a persistent left rail (grouped You /
  Workspace / System, admin-gated), the index redirects into Profile, the
  per-page breadcrumbs and oversized landing titles are gone, and every
  section renders inside the same frame.

## Operational security (2026-07-16)

- **TOTP two-factor** end to end: RFC 6238 in core over WebCrypto (tested
  against the RFC vectors, so both legs run it), migration 0013 on users,
  enrolment/verify/disable endpoints (session-auth only -- an API token
  must not rotate a second factor), a five-minute single-purpose mfa_token
  between the password and the code at login, eight hashed burn-on-use
  backup codes, the profile page enrolment flow, and the login page's code
  step. Contract-tested on both legs and browser-verified on the rig:
  enrol, gate, wrong-code refusal, code sign-in, backup-code sign-in,
  disable.
- **Response hardening**: nosniff, same-origin referrers (share slugs stay
  out of outbound links), SAMEORIGIN framing, on every response.
- Already in place from earlier hardening: login/reset/share rate limits,
  audit trail, HttpOnly SameSite=Lax sessions, same-origin mutation checks.
  docs/OPERATIONS.md now carries the posture in one place. Still open,
  post-v1: WebAuthn keys, admin-enforced 2FA policy.

## Re-anchoring (2026-07-16)

Carried-forward notes now follow the picture across a recut instead of the
arithmetic. The sprite sheet every version already has is a per-second
visual index; `packages/worker/reanchor.ts` dHashes its tiles, matches them
between versions with an ambiguity margin (a near-tie is not evidence), and
a consensus pass keeps only matches that agree with the field's median
shift -- similar-looking but unrelated footage produces individually
plausible matches that scatter, and the first rig run proved exactly that
failure before the margin and consensus went in. The Node server exposes
the mapping to the API as the optional `frameMatcher` env hook (absent on
Workers, where carry-forward keeps frames as-is), and every failure path
means "keep the original frame". Verified live both ways: unrelated
footage left a note at frame 24 untouched; a two-second head shift carried
it to exactly frame 72.

## Metadata intelligence (2026-07-16)

The review page grew an Info drawer that renders the version's full probe
record the way a post professional reads it: Picture (codec and profile,
frame size, aspect, pixel format, scan), Color (primaries, transfer, matrix,
range, with a "Not Rec.709" flag when the pipeline is anything else), Motion
(exact rational frame rate, duration in timecode and frames, start timecode),
Sound (per-track codec, layout, sample rate), and File (container, size,
bitrate, encoder, created). All of it is automatic from the stored ffprobe
record; nothing new is collected. Hooks fill in what the file cannot say --
captions already, more to come.

## Player and share parity (2026-07-16)

- **Hover scrub on the share landing**, the way the app's own browser has it:
  the share assets wire gained `sprite_url`/`sprite_vtt_url` (same one-query,
  watermark-neutral sidecar policy as the poster), and the landing tiles map
  mouse X onto the sprite's cue list, geometry loading lazily on first hover.
- **Captions, as the first deployment hook.** New `caption_tracks` table
  (migration 0012, both legs): a WebVTT per language, uploaded with
  `PUT /versions/:id/captions?language=..&label=..` (editor+, raw text/vtt,
  replace-on-put, 1 MB cap, WEBVTT header enforced), removed with DELETE.
  Tracks ride the internal renditions listing and the share asset detail's
  sidecars; the player grew a CC toggle that appears wherever a track exists,
  in the review room and on shares alike. GC counts caption blobs as
  referenced. docs/OPERATIONS.md shows the curl -- pipe your own ASR in.
- **Share analytics**: the viewer roster (name, email, last seen) was already
  surfaced on the share page; deeper per-asset view analytics needs event
  data the server does not yet record, noted below as open.

## The comparison viewer (2026-07-16)

`/projects/:id/assets/:assetId/compare` puts two versions of an asset against
each other: side by side or a draggable wipe, with one transport driving both.
Version A owns the clock (rate, drop-frame, timeline length); frame stepping
is the accuracy contract (mid-frame seeks on both, pause re-lands the exact
frame), while play keeps sync by correction, pulling B back whenever it drifts
past half a frame. Space plays, arrows step, shift-arrows step ten. The review
page topbar offers Compare whenever an asset has two versions. Verified in
Firefox on the rig: pixel decode on both panes, lockstep after stepping and
after pause, clip-path wipe follows the pointer.

## The system page (2026-07-16)

`GET /admin/system` and Settings > System put the operational picture on one
page: version and uptime, database size, backup snapshot state (with a stale
warning past a day and a call-out when backups are off), media volume
capacity, and per-status depths for media jobs, exports, and webhook
deliveries, workspace-scoped and refreshed every 15 seconds. Host-only facts
come through `env.systemInfo` and are null on Workers. docs/OPERATIONS.md
carries the monitoring guidance (healthz, logs, what runs without the media
worker). Browser-verified on the rig against real snapshots and queues.

## The share room (2026-07-16)

The share room (`/s/:slug`) is what a client sees, and it was the least finished
surface in the build. This pass, verified against real footage on nyx in Firefox
and Chromium:

- **Share assets carry `poster_url`** on both the bootstrap and the assets list,
  from one rendition query per listing. A share viewer cannot reach the internal
  versions/renditions endpoints the app's own grid uses, and a reel should not
  cost a request per tile. Poster pixels follow the sidecar policy: a watermarked
  share exposes them, as it already does for its sprite.
- **Grid, list and reel draw pictures**, one tile whose frame the layout sizes;
  reel is one 16:9 frame per row at up to 1000px. A missing poster falls back to
  the app's generated cover (wash, monogram, hashed light) rather than a hole,
  and `ProjectCover` now falls back the same way when a cover URL fails to
  decode instead of leaving a broken image.
- **Notes moved to a rail beside the picture**, the way the review page has
  always had them; they used to sit under the fold, so reading a note meant
  scrolling away from the footage it was about.
- **The landing takes `pageWashFor`** like every other page outside the review
  room. It drew the full-length wash, which ends on its light stop, so tiles and
  their names sat on dirty cream (washes.ts documents the effect).
- **`presentation` now means something.** It was in the model since phase 3 and
  did nothing but change one eyebrow word. Per design doc section 11 it is the
  curated client kind, so it drops the reviewer's tools: no frame readout, no
  frame link, no drawing, a simple player chrome, a clean timeline, and a
  carousel of the rest of the share. It respects `allow_comments` rather than
  overruling it: comments off is the clean client room, comments on keeps the
  rail. What it still lacks is branding and an approval action (both below).
  Superseded in part 2026-07-17 (David, after the browser pass): the frame
  readout and the note composer's drawing stay in the presentation room. A
  client saying "this frame" is the product working, not a reviewer's tool;
  what presentation still drops is the instrument chrome (marks, loops,
  lanes, scopes, quality) and the marking keys.
- **`Player` takes `chrome: 'full' | 'simple'`** (default `full`, so the review
  room is unchanged). `simple` hides the in/out marks and their readout, the
  lane toggles, the surround field and the quality ladder, and takes the marking
  keys (I/O/P/X) with them so a client cannot set an invisible mark or start an
  unexplained loop. Playback and frame accuracy are identical in both.
- **404s are a styled page** (`+error.svelte`) on the same wash family, not the
  framework's default.
- **The share download 404 is fixed.** It was never the endpoint: the server
  handed the SPA shell to *any* `/s/` path whose request said
  `Accept: text/html`, and a top-level navigation (which is what a download is)
  says exactly that. The router had no route for the media path, so the viewer
  got a 404 while the same file played fine in the player, because a video
  element and fetch send a wildcard Accept and reach the API. The shell now
  matches the landing path's shape (`apps/server/src/share-shell.ts`, unit
  tested). This is why a rig that fetches a download URL cannot reproduce it.

The same day, the manager's side of shares was rebuilt around one idea: a share
is a page, not a row in a dialog.

- **Every share has its own page**, `/projects/:id/shares/:shareId`: the link
  as the headline with the one accent Copy button on the page, the title
  renamed in place, each setting in a panel that saves as it changes (the
  watermark keeps an explicit Apply, because applying re-renders every clip),
  the contents as posters, the viewer roster, and revoke at the bottom.
- **The shares list is an index of doors**: each card opens the share's page;
  copying the link is the one action that stays on the card. The old page put
  every setting of every share behind one twenty-field Edit dialog.
- **The rail navigates**: clicking a share opens its page (its contents used to
  be browsed in the project grid, a worse copy of the same information), and
  right-click works on the rail's own rows -- folders get New folder inside,
  Rename, Delete; shares get Copy link, Share settings, Open as a viewer,
  Revoke; the Shares heading gets New folder. `selectedShare` and the grid's
  share browsing went away with it.
- **Project settings got recomposed**: identity is one panel -- cover at
  poster size, the name renamed in place at display size, the palette as the
  identity moment -- with Access and People beside each other under it. The
  uppercase-tracked panel headings (anti-slop list) are gone, the per-row role
  sentence collapsed into one legend, and Remove is quiet until pointed at.
- **A passphrase-less share now prompts for the viewer's name** (no passphrase
  field). It used to render the tiles with no viewer issued, and every asset
  failed to open; the access form appears whenever there is no viewer, and
  asks only for what the share actually requires.

A third pass the same day, on the room's design and the admin surfaces:

- **Shares carry a brand** (`brand_json`, now structured on the wire: a
  library palette or two custom hexes, plus a player choice). The share page's
  Appearance panel sets it with a live wash preview; the share room wears it,
  run through the same resolve-into-ink grammar as every library wash
  (`pageWashFromStops`), so a client-designed room still reads as this app.
  `PATCH /shares/:id` accepts `brand`, junk shapes are rejected at the schema,
  and the public bootstrap has always carried it. Contract-tested both legs.
- **A review share can choose the simple player** (`brand.player`), for
  clients who should read and leave notes without the colorist's deck in
  their hands. A presentation is always simple. Simple chrome also stops
  drawing the filmstrip and waveform lanes it offers no way to put away.
- **The share room is centered**, the "Review room" eyebrow is gone, and the
  landing column sits at `min(1120px, 100%)` in the middle of any window.
- **`GET /workspace/usage`** (admin): originals and renditions bytes, asset
  and version counts, per project and total, summed from the DB's own size
  columns -- no blob walk. Contract-tested both legs, including the 403.
- **Workspace settings grew up**: the index is grouped (you / workspace /
  system), and admins get a Storage page (per-project weights with bars,
  largest first) and an Audit log page (filter by action, cursor-paged,
  actor ids resolved to names).
- **Width, everywhere**: the share page flows to 1720px with balanced panel
  rows, project settings to 1600px, and the projects index grid fills the
  window with covers that scale (16:9) instead of clamping at one height.

A ninth pass closed the loop on the client workflow and the admin surfaces:

- **Clients decide from the room.** Approve and Request changes sit in the
  bar of both rooms, calling the approval endpoint that had been dark; one
  click records on the asset and notifies the team, the other click takes it
  back. Viewers also see Edit and Remove on their own notes (`mine` on the
  share comment wire, computed server-side from the viewer key; a freshly
  posted note is marked mine locally, which the e2e suite caught).
- **Shares are curated.** `PATCH /shares/:id/assets` reorders (the body names
  the exact set), `DELETE /shares/:id/assets/:assetId` removes; the share
  page's contents drag to reorder and shed on hover.
- **The brand carries a logo** (`PUT/DELETE /shares/:id/logo`, served
  publicly at `GET /s/:slug/logo` since it fronts the access prompt). It
  survives colour edits (the logo key is server-managed inside brand_json),
  and the room and access page wear it.
- **Links unfurl with a picture**: `GET /s/:slug/unfurl.png` serves the first
  asset's poster publicly, and og.ts points crawlers at it -- except behind a
  passphrase, where unfurls stay pictureless on purpose.
- **Admins get Trash and Webhooks pages** (`GET /trash` is new; webhooks CRUD
  existed) plus the settings index links.
- **The share room works on a phone**: the preview bar wraps instead of
  pushing the room sideways (found by the mobile checks; 0px overflow at
  390px now). Deeper phone polish -- the transport density, the proscenium
  padding at small widths -- is still open.
- **The browser e2e suite is committed** (`e2e/`): self-seeding, env-driven
  specs for the share flows and the manager surfaces, run from the Playwright
  container against a live instance. Wired into CI 2026-07-17: the
  Integration job runs it against the project its own exercise transcodes,
  on the runner's LAN address so the browser origin is non-localhost
  (admitted through ONELIGHT_ALLOWED_ORIGINS, which this exercises too).

A fourth pass, on David's design notes:

- **The presentation room is the client moment.** A presentation share opens
  straight into the first clip (deep links still win), wearing the share's
  brand wash as the walls: display-type title, the picture inset with a
  proscenium, and the whole reel as a centered thumbnail carousel with the
  current clip ringed. The review preview stays strictly neutral; the design
  doc has always listed presentation pages in the washed world. The player
  option in Appearance is named Presentation (wire value stays `simple`).
  Superseded 2026-07-17 (David, after the browser pass): a presentation
  share opens on its layout landing (grid, list, or reel) like every other
  share, not straight into the first clip; the room is what a tile opens.
- **Comments off means no comments furniture at all**: the rail exists only
  when the share allows comments, in both rooms.
- **Flat surfaces**: the gradient-fill-plus-inset-highlight-plus-drop-shadow
  panel treatment is gone everywhere it existed (project settings, shares
  list, share page). Panels are one value step off the page; hover is a
  second step. Dropdown selects wear no focus outline; focus is the value
  step too.
- **Share list layout rows are cards**: 176px frames on a quiet surface,
  instead of a bare filename floating beside an icon-sized thumbnail.
- **`GET /workspace/usage` reports the media volume's capacity** where the
  host can know it (Node server statfs on the blob root; null on object
  storage, where the number means nothing). The storage page shows free of
  total with a fill bar, and its copy was rewritten plainly.

And a fifth, finishing the presentation and the details around it:

- **The presentation player sheds the NLE grey.** The player paints itself
  entirely in the neutral token scale, so the presentation room re-maps that
  scale in its container: the slabs go transparent, the picture floats on the
  brand wash, controls and timecode turn cream on translucent ink, and the
  scrub track reads in cream. Review rooms never enter the branch.
- **Comments off silences the timeline too**: the share room no longer loads
  comments at all when the share disallows them, so markers and annotations
  cannot appear on the seek bar. The poll stops with it.
- **Share assets carry `duration_seconds`** (from the current version's
  probe, camelCase or snake), and the landing captions show a clock. List
  rows are cards.
- **Select focus outlines are dead globally**: one rule in the layout kills
  select:focus and select:focus-visible everywhere; pages style focus as a
  background value step.

A sixth pass: identity and addresses.

- **People have faces.** `Avatar.svelte` generates a deterministic avatar --
  the initial on a wash hashed from who they are -- and users can upload
  their own (PNG/JPEG/WebP, 512 KB cap) from the new `/settings/profile`
  page, which also renames in place. `users.avatar_key` (migration 0011,
  D1 copy in parity), `PUT/DELETE /users/me/avatar`,
  `GET /users/:id/avatar` (workspace-scoped), `avatar_url` on every user
  wire. Avatars appear on review notes, share-room notes (generated from the
  viewer's name; the public wire still never carries user ids), People lists,
  workspace members, and the topbar. Contract-tested both legs.
- **Links read like what they open.** New share slugs are the kebab-cased
  title plus 14 base62 chars (~83 bits; the design doc records the
  supersession), and app URLs carry a readable tail after the id --
  `/projects/{ulid}-fanatics/assets/{ulid}-eagles-cc-mov` -- parsed by
  `$lib/ids.ts`, so renames never break a copied link and old bare-id URLs
  still work.
- **The presentation scrub grew up**: the handle is always present (bright
  dot, dark ring, grows under the pointer), the track is taller with the
  played side bright, so it reads as a seek bar before anyone touches it.

A seventh pass: notes become a working surface everywhere.

- **Comment attachments are live across the board.** The internal trio
  (POST/GET/DELETE, built earlier for the report path) now reaches the wire:
  comment lists carry `attachments`, and share viewers get their own routes
  (`POST /s/:slug/comments/:commentId/attachments`, ownership-gated like
  editing; `GET .../attachments/:attachmentId`, visible-comment-gated,
  share-scoped signed URLs). Both composers attach files (25 MB, chips with
  remove before posting), both threads show them as chips that resolve
  short-lived signed URLs. Contract-tested both legs, verified in the
  browser both rooms.
- **The scrub drags like glass**: the handle rides the pointer while seeks
  coalesce to one per animation frame, and the preview holds after release
  until the video catches up, so nothing snaps back.
- **The showtime composer speaks client**: anchors read as timecode, the
  button says Post note, and the rail hosts the drawing controls (draw
  toggle plus pen/arrow/box) through the player's new setDraw API -- the
  full instrument keeps its own controls, simple chrome never shows them.
- Viewer-side attachment deletion has no endpoint.

An eighth pass: pictures inline, timecode everywhere, words on the frame.

- **Image attachments render inline** (`AttachmentImage`, min-bounded thumbs
  that resolve their signed URL on mount and refresh it once if it expires)
  and open in a **lightbox** (`Lightbox`: veil, Escape or click closes), in
  both rooms. Non-images stay chips.
- **Timecode, always.** The share room's bar readout, note chips, anchor
  labels and aria labels all read timecode now; frames stay in the data.
- **A text tool joins the drawing tools.** `AnnotationStroke` grew
  `tool: "text"` with a `text` field (points[0] anchors, width keeps the
  frame-diagonal convention as the type size). The overlay renders type with
  a dark halo so it reads on any footage; a click in text mode floats a bare
  input at the spot, Enter commits. The PDF report renderer draws the same
  text, escaped and length-capped, with tests.
- **Inks are personal.** `ANNOTATION_INKS` are bright siblings of the
  timeline's ten marker inks under the same author hash, so the colour a
  person draws in matches the colour their markers wear. The ink palette
  (player settings row and the share rail) leads with the author's own
  colour as the default; picking another sticks. White and black round out
  the palette.
- **Pending text is a live object.** Until the note posts, text renders as
  DOM rather than canvas: grab to move, tools to resize (frame-diagonal
  steps, clamped) or remove, a still click reopens the words, Enter
  recommits, emptying deletes. Posting hands the words back to the canvas
  as a committed stroke. Committed annotations on existing notes are still
  immutable; editing those means editing the comment, which is a separate
  decision.

## The pro-tool push (2026-07-17, direction from David)

The goal is stated plainly: full feature parity with the commercial review
tools (frame.io, Krock) so teams have a real open-source alternative, a
full pro tool. Standing decisions from this direction:

- **NLE integration ships as an official plugin, not a script.** Nobody
  runs a random Python file against their Resolve; the deliverable is the
  phase 6 Workflow Integration panel (Studio, Workspace > Workflow
  Integrations, the same API Krock/EditShare/ShareBrowser use and the
  niche frame.io v4 vacated). The marker EDL stays as the manual fallback
  and its Export panel copy must name Resolve's actual import path
  (Timelines > Import > Timeline Markers from EDL), because the obvious
  import conforms cuts. The scripting facts that make the plugin the right
  bet: Timeline.AddMarker carries full unicode text, exact colors, ranged
  durations, and a customData field invisible to the UI that makes sync
  idempotent and two-way (GetMarkerByCustomData and friends).
- **Email is a first-class subsystem, not an env footnote.** The compose
  file did not pass SMTP_URL or MAIL_FROM through (the exact silent-.env
  trap its own comment warns about), so no compose deployment could ever
  send mail; fixed 2026-07-17, all SMTP_* settings now flow. The admin
  System page shows the mail posture (ready, disabled, or present-but-
  broken with the parse error) and sends a test email to the pressing
  admin through POST /admin/system/test-email, contract-tested both legs.
- **The member model grows a guest tier (2026-07-17).** Workspace roles
  are now admin / member / guest. A guest is the account you hand
  outward: freelancers, vendors, client-side producers. Guests see
  NOTHING they are not explicitly granted, restricted or not, cannot
  create projects, cannot browse the team roster, and get only the You
  group in settings; a grant gives exactly the granted ladder role, so a
  guest granted manager runs that one project and nothing else. Invites
  carry the tier plus project grants, so onboarding a freelancer is one
  invite. Storage note: the users role column carries a CHECK from 0000
  and rebuilding users would cascade through sessions and tokens on live
  instances, so guests are stored as members plus a flag (migration
  0015, both legs) and the auth boundary derives the effective role once;
  no route consults the flag. The permission matrix runs every cell for
  the seventh role on both database legs. Deliberately not copied from
  frame.io: custom roles, per-seat billing mechanics. Still open from
  the same discussion: download/share gating has no internal surface to
  gate yet, because originals are not downloadable inside the app at all
  today (only through share links, per share allow_download); an internal
  original-download control for editors, and then its per-project
  gating, is backlog.
- **Annotation text grew down and stopped eating words.** The size floor
  dropped to 0.008 of the frame diagonal (a caption-sized aside is a
  legitimate note), and clicking the frame with words in an open text box
  now applies them; it used to spawn a fresh empty draft before the blur
  handler could commit, destroying the typed text. Enter still commits,
  Escape still discards.
- **Transfers: files move in and out without a seat (2026-07-17).** Two
  link kinds under /t/:slug, stored in migration 0016 (both legs). A
  package sends chosen assets: the visitor gives a name, gets the file
  manifest, per-file signed original downloads, and a Download everything
  streamed zip (store method, zip64, data descriptors, exact
  Content-Length precomputed; the writer lives in core over web streams
  so both runtimes serve it, round-trip tested including against
  Windows' own extractor). A request receives files: they ride the same
  multipart engine, part persistence, CRC32C verification, and
  quarantine members use (the handlers were extracted and shared, not
  copied), then land as real assets in a chosen folder, so inbound media
  is transcoding before the sender closes the tab. Receipts record who
  sent what; the creator and project managers get transfer.received
  notifications, the creator gets transfer.downloaded. Byte caps count
  in-flight bytes, passphrase/expiry/revocation mirror shares, and the
  public wire carries no project, creator, or folder identity. The
  browser engine grew per-part retry with backoff and a localStorage
  session ledger, so a page reload resumes an interrupted upload at the
  last completed part, for member uploads and transfer uploads alike.
  Packages require manager (they hand out originals), requests editor.
  For sysadmins, `cli.js offload` copies a project's originals (or one
  request link's yield) out of blob storage onto a mounted NAS/DAS path,
  rebuilding the folder tree, verifying every copy against the stored
  CRC32C, and writing a manifest; documented in OPERATIONS.md. Backlog:
  a transfers e2e flow in the integration job, and notification digest
  copy for the two new kinds.
- **Addresses read as names, not machine ids (2026-07-17, direction from
  David).** Projects, assets, and shares carry a public_id: 10 lowercase
  hex characters, random (so links neither collide nor enumerate),
  unique-indexed, backfilled in pure SQL (migration 0017, both legs).
  URLs are name-first: /projects/autumn-spot-a3f9c02b17. The ULID stays
  canonical everywhere inside: aliases resolve ONLY at the three
  bootstrap GETs (project, asset, share), so a mutation can never write
  an alias into a row, and every page resolves its route param once,
  then talks canonical. Every legacy form still parses (bare ULID, old
  ULID-first pretty links), and each entity page rewrites the address
  bar to the pretty form on load, so a ULID deep link from a
  notification lands reading like a name. Renames never break links:
  the name part is decoration, the tail id is the key.
- **The download system grew its internal half (2026-07-17).** Versions
  download inside the app at last: originals at editor (the negative),
  the review proxy at viewer, via short-lived signed URLs with
  attachment dispositions. A folder, a selection, or a whole project
  streams as one zip of originals (editor), with the folder tree as
  archive paths. Shares gained Download all: one streamed zip under the
  share's own policy (original bundles negatives, proxy bundles review
  files, watermarked refuses so clean files never leave in bulk, and a
  proxy zip with a rendition still processing refuses rather than ship
  a partial archive that reads as complete). All of it rides the core
  zip writer with exact Content-Length. Still open: per-project
  download gating on top of these roles.
- **Downloads survive interruption (2026-07-17).** Three failure modes
  closed. Signed download URLs (version, share, transfer, attachment,
  export) now live twelve hours instead of fifteen minutes, keyed off
  the attachment disposition so no call site can get it wrong: a resume
  hours into a huge pull still authorizes. serveBlob emits a strong
  ETag (blobs are immutable per key) and honors If-Range, because
  browsers restart instead of resuming without a validator. And zips
  resume: the deterministic store-method layout maps any byte position
  to a known region, so all three zip endpoints serve real 206s through
  one shared serveZip (ETag from the entry manifest, If-Range, exact
  Content-Range). The subtlety is the central directory: it repeats
  every entry's CRC at the end of the archive, so a naive resume
  re-reads every entry. A process-local CRC cache (immutable blob keys,
  warmed by the first pass) lets a resume skip completed entries
  outright and jump into the interrupted one via a ranged blob read;
  cold-cache resumes fall back to read-and-discard, slow but correct.
  Byte-exact resume equivalence is tested at every region boundary in
  core, and over HTTP in the contract suite. Alongside the zips, every
  bulk surface (share room, transfer package, project selection) gained
  "one at a time": sequential saves through the browser's own download
  manager, where an interruption costs one file, not the batch, and
  which also gives watermarked shares a bulk path since their zip
  refuses by design.

## The list, the picture and the note (2026-07-21, punch list from David)

Seven asks, plus two that arrived mid-pass, all verified in a browser against a
built server on nyx:

- **Uploading no longer waits for a button.** Choosing or dropping files starts
  them; `pump()` is the single serial driver and enqueue, resume and resume-all
  only mark work and wake it. The folder is captured at drop time (uploads run
  unattended now, so the selection will have moved on), and the "New version
  of..." pick stays live while the bytes move, since the branch is read at
  commit time.
- **The confirm dialog stopped clipping.** Its body was a `display: grid` with
  the implicit `auto` track, whose minimum is min-content: an interpolated
  filename pushed the dialog past its own box and grew a horizontal scrollbar.
  `minmax(0, 1fr)` plus `overflow-wrap: anywhere` on the title and body, and a
  phone block that stacks the buttons full width.
- **Notes copy between any two versions.** `POST /versions/:id/carry-forward`
  already took an arbitrary source; the client only ever aimed it at the
  previous version and only from the head of the stack. The version menu now
  offers "Copy notes here" on every other row, and the copier skips sources
  already carried into the target, so pressing it twice cannot double the notes.
- **An asset can be given its own picture** (migration 0019,
  `assets.thumbnail_blob_key`). The generated poster is a frame ten percent in,
  which is often a slate or a fade up. The review page can keep the frame on
  screen (captured from the player's own video element as a PNG, uploaded
  through an ordinary session) or take an uploaded image. It overrides the
  poster in the project grid, in share rooms and in link previews; clearing it
  brings the generated poster back. Not a rendition: the renditions `kind` CHECK
  cannot take a new value without rebuilding the table on D1, and the choice
  should survive a new version landing.
- **The projects page became a room.** Multi-select (hold, shift, ctrl,
  right-click) with the asset grid's gestures, a context menu, archive and an
  archive view, admin delete behind typing the project name, download, a People
  dialog over the members editor now shared with project settings
  (`ProjectMembers.svelte`), filter by name, sort by name, created or recently
  edited, and per-project notification badges that clear where they are read.
  "Recently edited" is a new `last_activity_at` on the project wire: the newest
  project event, which is what a person means, rather than `updated_at`, which
  only moves when the project's own record is edited.
- **Avatars stopped disappearing.** `referencedBlobKeys` never listed
  `users.avatarKey`, so the blob GC deleted every avatar a day after upload
  (confirmed in the production log). That list is a survival list, not a
  cleanup list; the new thumbnail column is on it too, and the avatar endpoint
  now clears a pointer whose blob is already gone instead of serving a broken
  image forever.
- **Both grids size their cards** (a persisted four-stop slider), and list mode
  reads out kind, runtime, size and format from the stored probe.

Project duplicate was asked for with a question mark and is deliberately not
built (David, 2026-07-21: "leave out the dupe"). There is no honest default:
copying the shell (name, palette, members, folders) and copying the media are
different features with different costs, and a project full of duplicated
originals is an expensive thing to create by accident. It stays out until
someone wants a specific one of the two.

Two robustness fixes the browser caught and the tests did not: `whenRelative`
and `whenAbsolute` return "" for a non-finite stamp (one absent field took the
whole projects page down with a DateTimeFormat throw), and the context menu
reads its state optionally, since closing it inside a handler nulls that state
while the block is still on screen.

## Sound and stills get instruments (2026-07-21)

Audio and image assets were kinds the pipeline knew about and the app had
nothing to show for: an audio asset planned one `audio_peaks` PNG and nothing
playable, so its review page was an empty player forever, and a still was an
`<img>` with a max-height in the share room and nothing at all in the review
room. Both are now first-class media with their own instrument, on the same
page, with the same notes rail, anchors, versions and drawings.

- **Three rendition kinds** (migration 0020, the renditions table rebuilt
  because SQLite cannot alter a CHECK): `proxy_audio` (AAC 192k, so a 24-bit
  WAV or an AIFF plays anywhere), `waveform_data` (peak data in the BBC
  audiowaveform `.dat` container, version 2, written by the worker itself from
  streamed PCM rather than by the GPL tool), and `spectrogram` (log-frequency,
  log-amplitude, rendered as luminance). Video with sound now plans
  `waveform_data` in place of the PNG; the old kind stays in the CHECK and the
  clients still read it, because versions transcoded before this carry one.
- **Audio has a nominal 60 fps timebase.** Positions in this system are integer
  frames plus a rational rate, and sound has no frames. 60/1 is the finest
  supported rate with an exact denominator: 16.67 ms per note anchor, and
  timecode that reads like everything else. `normalizeProbe` assigns it (with a
  `nominalRate` flag) only when a source has audio and no picture.
- **The audio stage**: waveform above, spectrogram below, one time axis, one
  playhead, drawn in the browser from the sidecars. Both are canvases sized to
  the lane, so the drawing is sharp at any width; the playhead and the veil
  over the not-yet-played part are transforms on their own layers, the lesson
  the timeline already learned. The spectrogram is shipped as grey and coloured
  here through a palette LUT (a gamma keeps mids dark), because the room
  decides the colour and a colour map baked into a PNG never can. David
  approved colour in the review instrument for this specific case: there is no
  picture to judge, and a frequency reading without colour is a texture.
- **The frequency axis is measured, not guessed.** ffmpeg's `fscale=log` is not
  a plain logarithm and its shape depends on the Nyquist frequency, so the
  worker resamples to 48 kHz before the filter and the player carries a table
  measured at third-octave centres against that exact filter string.
  `qa/spectrogram-axis.spec.ts` retakes the measurement and fails if an ffmpeg
  upgrade moves the tones, so the axis cannot quietly start lying.
- **The still viewer**: fit, one-to-one, 400% with nearest-neighbour above
  100%, wheel zoom about the pointer, drag pan bounded by the picture's own
  edges, keyboard (0, 1, +/-, arrows), and A/B against the previous version as
  a wipe or a blink. Drawing is the player's overlay and contract, unchanged,
  so a note on a still and a note on a frame are the same note.
- **Audio assets have a poster** (two lanes of waveform on ink, square-root
  scaled because a thumbnail of -20 dBFS material is otherwise a hairline), so
  they are no longer blank tiles in the grid, the share room and link previews.
- **Fixes found on the way**: a proxy-only share answered "not ready" forever
  for a still, because the single-file download looked for a 1080 video proxy
  regardless of kind (the zip bundle already knew better); the zip bundle
  silently shipped audio originals in a proxy-only share; and the share media
  endpoint picked its rendition by a fixed order rather than by asset kind.

Verified on nyx against a built server: a 40 second stereo WAV and a 4096x2730
still uploaded through the real pipeline, both rooms and the share room
screenshotted, the waveform and spectrogram canvases read back pixel by pixel
(not merely asserted present), playback confirmed to advance the timecode
(00:00:02:31 at 151 frames of 60), zoom and pan confirmed by the transform they
produce, and notes posted from both instruments.

## Audible forward shuttle (2026-07-23)

L shuttle could advance picture at the correct 1x, 2x and 4x rates while
producing no sound for one reviewer across Chrome and Firefox on macOS and
Windows. Space playback remained audible. Direct varispeed on the main media
element did not fix that reviewer's deployed result, so the browser's
rate-changed audio path is no longer the primary accelerated path.

Transcode now creates time-compressed AAC sidecars for 2x and 4x forward
shuttle. The picture keeps its exact accelerated rate while the matching
sidecar plays at 1x, preserving pitch without depending on a browser's
rate-change implementation. These navigation-only files use broadly compatible
AAC-LC at 64 kbps stereo and strip source metadata, about 360 KB combined per
minute of source footage. Existing ready assets are backfilled automatically.
If a sidecar is missing, rejected, fails to decode, ends early, or its clock
stalls, the player immediately unmutes the main media element and keeps direct
varispeed as the audible fallback.

The player also posts automatic diagnostics for project review and share
review. Structured stdout records show the browser, platform, requested rate,
media readiness, clock, volume and mute state, and last successful sidecar
stage. The reviewer does not need developer tools or a log-gathering step.

## NLE fidelity and preserved source metadata (2026-07-23)

- **Marker exports now carry review context, not just bodies.** NLE note fields
  retain the author, completion state, project-only internal state, and thread
  replies. Resolve colors distinguish open, completed, and internal markers.
  Avid uses its documented text colors. Share exports are server-constrained
  to assets in the share and always exclude internal comments.
- **XML timelines have real timeline semantics.** Premiere xmeml markers are
  sequence-relative while the sequence timecode stores the source origin.
  FCPXML uses exact rational seconds, source `tcStart`, and media duration, so
  a one-minute source starting at 01:00 does not become an hour-long sequence.
  Multi-version exports are one valid file per version in a ZIP instead of
  concatenated complete documents. Avid is labeled and downloaded as marker
  text; the old `avid_xml` API value remains only as a compatibility alias.
- **Manual NLE state is now explicit.** David imported the Resolve and Premiere
  outputs successfully on 2026-07-23. This pass improves their marker names,
  notes, source origins, and durations. Media Composer is unavailable and Final
  Cut has not yet been recorded, so those two remain release checks.
- **Frame rate is never rounded into another rate.** Probe rationals are
  reduced and retained exactly. Dedicated `tmcd` wins over duplicate format or
  video tags, and the selected source is recorded. The original upload remains
  byte-for-byte untouched; proxies and watermarked derivatives re-embed source
  timecode and the integration harness probes the resulting timecode track.
  A true VFR source is explicitly marked and normalized to a deterministic CFR
  proxy at its exact measured average rational. That preserves the original and
  the chosen starting label, but it does not pretend a one-rate SMPTE track can
  encode every irregular source-frame interval.
- **Color metadata is retained and conversions are explicit.** The version
  stores primaries, transfer, matrix, range, chroma location, pixel format,
  bit depth, field order, side data, and any untagged-source assumption. SDR
  transcodes numerically convert BT.601 and full-range sources to BT.709
  limited range. They do not relabel the source. HDR rails retain source color
  tags. Every rendition records both source and output color contracts.
- **Node FTS5 is complete.** Startup installs a versioned, trigger-maintained
  trigram FTS5 index over assets, comments, projects, people, and shares.
  Literal LIKE remains the correctness predicate and the fallback for D1 and
  two-character searches, preserving the public substring contract and
  visibility checks.

## Browser color plan (2026-07-23)

The deep-research decision and implementation spec are now recorded in
`docs/research/browser-color-reference-2026-07.md` and
`specs/browser-color-reference.md`.

The key boundary is raw decoded planes. A self-check can detect a bad native
path but cannot repair it. Production SDR reference mode will demux with
mediabunny, decode with WebCodecs, copy native I420 or NV12 planes, and perform
range, matrix, and transfer conversion in an audited WebGL2 shader targeting an
explicit sRGB canvas. `drawImage`, RGB `VideoFrame.copyTo`, and WebGPU external
textures remain browser-managed conversions and therefore cannot be the
reference path.

Native playback remains the universal fallback and the first HDR path. HDR
selection will require both exact Media Capabilities support and an HDR-capable
video plane. The SDR tonemapped proxy remains the default otherwise. Automatic
reference mode is blocked on cross-engine pixel, frame, memory, recovery, and
real Safari/Windows performance gates.

The first implementation slice is complete: BCR-T01 through BCR-T04. The QA
bars and product self-check now share one canonical oracle, the tiny embedded
BT.709 clip is parity-checked against independently sampled YUV planes, and
Chromium reproduces the oracle through the actual product runner. Strict
color-path diagnostics reach the existing authenticated and share endpoints
without exposing pixels or device identifiers. The neutral review instrument
shows the active rendition color contracts, measured maximum delta, and any
fallback reason at desktop, tablet, and phone widths. Reference mode is not
offered before it exists.

BCR-T05 is complete. The minified mediabunny worker is a separately loaded
302,501-byte chunk. Integer-frame mapping round-trips WebCodecs microsecond
timestamps at every supported rational rate, stale seek and playback
generations cannot publish results, decode feeding observes queue pressure,
and the retained window closes anything outside two frames behind through
three ahead. Chromium passes the real worker and transferable-plane test.
Windows Firefox reaches the next gate but exposes decoded H.264 as `BGRX`,
not I420 or NV12. The worker rejects that exact format before `copyTo`, so
there is no hidden browser RGB conversion. BCR-T06 remains open on the
cross-engine raw-plane matrix, and automatic reference mode remains blocked.

## Full application hardening audit (2026-07-23)

The v1 app was audited across authorization, public contracts, upload and
transfer accounting, streaming behavior, persistence, maintenance, dependency
health, integration fixtures and responsive review UI. The audit found and
fixed defects that green happy-path tests did not exercise:

- Attachment mutation now enforces author-or-moderator ownership on internal
  routes. Share viewers can delete their own attachments. Comment deletion
  removes attachment blobs, and storage accounting is updated on every
  attachment insert and delete.
- Attachment count and byte limits, transfer byte caps and storage increments
  are enforced transactionally in SQLite and D1. Concurrent requests can no
  longer race past a cap. Transfer requests default to a 1 TiB allowance and
  reject values above 10 TiB.
- Upload creation, multipart signing and completion share explicit backend
  limits. Completion rejects duplicate, missing, oversized, out-of-range and
  byte-mismatched parts. Local-disk parts and assembled uploads are hashed while
  streaming, so large uploads are not read into memory for validation.
- OIDC auto-linking rejects unverified email claims. Anonymous replies,
  approvals and attachment uploads are rate limited. Repeating an approval is
  idempotent and does not create duplicate notifications.
- Webhook delivery claims are atomic, timestamps are signed with the body,
  response previews are bounded and the timeout covers body consumption.
  Request logs redact share and transfer slugs.
- SSE connections remain live, wake on local publishes and heartbeat across
  isolates. Viewer presence writes are throttled. Maintenance now reaps every
  stale upload state against the correct timestamp and no longer protects dead
  upload blobs from garbage collection.
- The review room now sizes from the real header height, compacts transport by
  player width rather than viewport width, keeps the notes header within its
  rail and has no document overflow at desktop, tablet or phone sizes. Review
  chrome remains neutral and gradient-free.
- The production server resolves the bundled SPA from the server module instead
  of the launch directory. The integration dry run expects the current
  `waveform_data` rendition. Workers Vitest configuration and security-sensitive
  dependencies were upgraded; the package audit reports no known
  vulnerabilities.

Contract coverage now includes cross-user attachment mutation, public
attachment removal, database-enforced attachment quotas, concurrent transfer
caps, OIDC verification, concurrent webhook claims, multipart ordering and
boundaries, live SSE wake-up, approval idempotency and stale upload states. The
Node suite passes 517 tests, the D1 workers suite passes 22, and the media QA
suite passes 12 across Chromium and Firefox with the unavailable WebKit leg
skipping cleanly.

The 2026-07-23 media pass made the workhorse ladder hardware-first across Intel
Quick Sync and Arc, NVIDIA NVENC, and AMD AMF. Startup now performs a real
encode probe, explicit production selections fail closed, auto mode falls back
safely, and `/healthz` reports the active backend. The ladder now has
frame-rate-aware VBV caps, fixed one-second GOPs on every encoder, quality
presets appropriate to each vendor, per-rendition software retry after a
driver reset, and Compose overrides that pass through Intel, NVIDIA, or AMD
devices. Comment timeline blips now use the commenter's uploaded avatar or the
same deterministic generated avatar as the rest of the app.

## Before tagging v1.0 (blocking, all require Linux or human judgement)

1. DONE 2026-07-17: first green run of the integration and media-qc CI jobs on Linux, exercising compose end to end, the HDR libplacebo tonemap on lavapipe, the zscale conversion, tmcd write, pdftoppm, watermark burn, range serving, and graceful shutdown against real ffmpeg. Getting there surfaced and fixed: CI had never actually executed (a pnpm/action-setup version pin conflicted with packageManager and killed every run at setup); the node job was missing the web:check gate and the SPA build the workers pool needs; the qa HDR smoke run omitted the worker's VULKAN_HWDEVICE_ARGS so libplacebo refused lavapipe (the spec now mirrors the worker invocation exactly); and Playwright WebKit on Linux reads the 75 percent bars low (a GStreamer/GL decode artifact, not real Safari; the exact deviation is pinned per-engine-and-platform in the qa color spec so any decoder drift still fails, and the reference tolerances were never widened).
2. PARTIAL 2026-07-23: Resolve EDL and Premiere xmeml import successfully in real applications. Media Composer marker text and Final Cut FCPXML still need recorded imports. Fixtures are byte-exact and fuzz-hardened; the NLEs remain the judges.
3. Share-flow browser pass (focus order, drawing, watermark overlay, modal a11y) with screenshots checked against section 24 and the mockups. The authenticated review room passed the 2026-07-23 desktop, tablet and phone layout audit.
4. The curated real-camera corpus of design doc section 21 (ProRes/DNx/XAVC, VFR phone clip, 8ch MXF, broken files) as CI fixtures where licensing allows; synthetic PQ/HLG fixtures already run.

## Hardening backlog (post-v1.0, rough priority)

- Worker pump over signed URLs so the media worker can run against R2/S3 storage instead of a shared filesystem (unblocks full CF transcode and split-host deployments; design sketch in apps/cf/src/index.ts). This is the largest remaining architectural item.
- Browser color self-check and raw-plane SDR reference mode. Deep research and dependency-ordered acceptance gates are in `docs/research/browser-color-reference-2026-07.md` and `specs/browser-color-reference.md`. The baseline is WebGL2 over copied I420/NV12 planes; WebGPU is an optional accelerator after parity, not the correctness boundary.
- Storage usage accounting reconciliation surfaced in the UI (the GC reconciliation and reaping sweeps exist server-side).
- A separate export pump so a long export does not head-of-line-block transcode on the single pump.
- Uppy-based uploader if the directory uploader proves insufficient for camera-card ingest at scale.
- General Idempotency-Key response-replay store (the current implementation replays upload creation; see the phase-1 supersession note).
- DNS-rebinding-safe webhook delivery.
- A true tiled watermark grid (v1 approximates with three diagonal placements); watermarked sprite sidecars (the scrubber filmstrip on a watermarked share currently shows clean low-res frames).
- Per-asset share view analytics: the viewer roster exists, but per-asset view events are not recorded server-side.
- Phone polish in the share room beyond the wrap fix: transport density and proscenium padding at small widths.
- WebAuthn keys and an admin-enforced 2FA policy (noted in the operational-security pass).
- True Media Composer marker XML once a captured real MC export exists (avid_xml currently emits the MC text format; see the phase-3 supersession note).

## Forward phases (design doc section 20)

- Phase 4, realtime collaboration: presence, watch-together, live mirrored drawing, comparison viewer. Acceptance: sync drift <= 2 frames p95 on 100ms RTT.
- Phase 5, Cloudflare target completion: R2 event notifications -> Queues -> Container transcode pipeline, DO realtime hub, deploy button, Stream adapter, CF e2e against a live staging account. Note: R2 storage, D1, scheduled webhook delivery, and SPA serving already landed in the v1 remainder pass; phase 5 is the transcode pipeline and productization.
- Phase 6, ecosystem: CLI (push/pull/sync/watch/export/import portability), Resolve Workflow Integration plugin (the flagship), Premiere UXP panel, Tauri transfer app, C2C-style device ingest.
- Phase 7, color-critical and intelligence: reference-mode proxies (pulled forward to the hardening backlog 2026-07-17, see above), WebGPU scopes, LUT preview, comment re-anchoring across versions (perceptual hash), whisper transcription, per-session burned watermarking, HLS/ABR option, EXR/DPX ingest, BRAW/R3D plugins pending licensing.
- Order of phases 4 and 5 may swap based on community pull after v1 (design doc open question 7).

## Standing rules

Every phase gets an implementation spec at the rigor of specs/phase-0.md before execution, adversarially reviewed. Acceptance checks are the task. The contract suite runs on both backends at every step. Frame accuracy and color correctness tests are never weakened to make CI pass.
