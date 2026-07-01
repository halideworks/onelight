# Research: frame.io V4 spec baseline, competitors, and the open-source gap (2025-2026)

Deep-research report, 2026-07-01. One of three reports underpinning `onelight_design_doc.md`. Compiled from ~240 tool calls across parallel research agents plus targeted verification against frame.io/pricing and help.frame.io.

## 1. Frame.io V4 - exhaustive feature inventory (spec baseline)

V4 GA'd Oct 14, 2024 at Adobe MAX ([Adobe blog](https://blog.adobe.com/en/publish/2024/10/14/frameio-v4-the-fully-reimagined-platform-is-now-available-for-all)); retail V3 users force-migrated in waves Sept 2025 to Jan 31, 2026 (some enterprise/API accounts March 24, 2026); legacy V2 API dies Dec 1, 2026 ([migration guide](https://developer.adobe.com/frameio/guides/Migration/)).

### 1.1 Uploads
- Any file type accepted for storage/download/share; viewer support for: video - MOV (H.264/H.265/MJPEG/ProRes), MP4, MXF (DNxHD/JPEG2000/ProRes), MKV, AVI, WebM (VP8), WMV, FLV, 3GPP; audio - AAC/AIFF/FLAC/M4A/MP3/OGG/WAV/WMA; images - BMP/GIF/HEIC/JPG/PNG/TIFF/WebP/TGA/EXR; camera RAW stills - ARW, CR2/CR3, NEF, RAF, RW2, etc.; design/docs - PSD, AI, INDD, DWG, PDF, Office; interactive HTML ZIPs; 3D assets ([Supported File Types](https://help.frame.io/en/articles/9436564-supported-file-types-on-frame-io)).
- Limits: 5TB/asset; 500GB cap for videos needing proxies. Web uploader: 500 assets + 250 folders/session, 10-deep folder trees, structure preserved, immediate hover-scrub previews ([Uploading](https://help.frame.io/en/articles/9101026-uploading-your-media)). Watch folders via desktop Transfer app.

### 1.2 Camera to Cloud (C2C)
- On all plans incl. Free, no device-count limit ([C2C FAQ](https://help.frame.io/en/articles/4887091-c2c-frame-io-camera-to-cloud-faqs)). Devices pair to a Project via 6-digit code/QR; uploads auto-organize into `Cloud_Devices/{date}/{type}/{device}`.
- Native cameras (originals or in-camera proxies): RED KOMODO/V-RAPTOR (8K R3D), Fujifilm (X-H2 line, GFX100 II), Panasonic LUMIX, Canon (C80/C400/C50), Nikon (Z6III/Z8/Z9/ZR), Leica SL3. Encoders: Teradek Serv/Prism/Cube, Atomos Connect, Accsoon. Audio: Sound Devices 888/Scorpio. Apps: Filmic Pro, Mavis, LiveGrade, ZoeLog ([compatibility guide](https://support.frame.io/en/articles/4886030-c2c-camera-to-cloud-camera-compatibility-guide)).
- Key semantic: C2C proxies must match camera-original filename + timecode so they conform/relink in the NLE ([proxy workflow guide](https://help.frame.io/en/articles/6079079-c2c-complete-proxy-workflow-guide)). Offline record + sync-on-reconnect supported.

### 1.3 Transcode pipeline
- MP4 renditions at 2160/1080/720/540/360p; H.264 (H.265 for HDR); ~14 Mbps 4K / 4 Mbps HD / 2.2 Mbps SD; source fps preserved; deinterlace for web; color space preserved (709/2020/2100/P3) ([conversion doc](https://support.frame.io/en/articles/13321-what-are-my-assets-converted-to-when-it-s-uploaded)).
- HDR: PQ + HLG, 10-bit playback on paid plans, tone-mapped for SDR devices; no Dolby Vision/HDR10+ ([HDR overview](https://help.frame.io/en/articles/4305435-hdr-overview)).
- Audio to AAC 128kbps stereo downmix; up to 7.1 playable if single-track; more than 8ch is download-only. Stills/docs to PNG/JPEG previews. Originals always stored and downloadable; proxies don't count against quota. 4K UHD playback gates at Team plan (verified against frame.io/pricing). [UNVERIFIED whether delivery is true HLS adaptive vs discrete rendition switching.]

### 1.4 Player
- J/K/L transport with 2x/4x/8x shuttle both directions; rate slider 0.25x-1.75x (0.05 steps); arrow keys +/- 1 frame, Shift +/- 10; I/O range marking + R (drives range comments); loop toggle; zoom to 100%/fill/marquee/magnify; frame guides with masking; set-frame-as-thumbnail; download still of current frame; quality selector; transcript panel + CC ([player features](https://help.frame.io/en/articles/9105311-player-page-features), [shortcuts](https://help.frame.io/en/articles/9105337-keyboard-shortcuts)).
- No 360/VR spherical playback; no documented source-vs-record-run timecode toggle [UNVERIFIED]; audio waveform display unclear in V4 docs.

### 1.5 Comments (the heart of the product)
- Timecode-anchored (`C`) + range comments (in/out); spatially anchored pins on the frame (V4-new); annotations (`P`): arrow, line, box, freehand, multi-color, undo/redo; text markup tools (2025); threaded replies; @mentions; emoji + reactions; hashtags for filtering; attachments (6 files/comment, Pro+); per-comment "Mark As Complete"; internal comments (Team+, lock icon, never visible on shares); deep link to comment/timestamp ([commenting](https://help.frame.io/en/articles/9105251-commenting-on-your-media)).
- Anonymous share reviewers prompted for name+email after first comment (no account required).
- Sort by timecode/newest/commenter/completed; filter by annotations/attachments/unread/hashtag/user. Export: CSV, XML, plain text, FIOJSON, Print-to-PDF with annotated thumbnails ([export doc](https://help.frame.io/en/articles/9105309-comment-printing-and-comment-exporting)). NLE round-trip: Premiere panel to timeline markers; Resolve only via EDL (and the EDL famously drops comment text - [support doc](https://support.frame.io/en/articles/4128691-import-comments-into-resolve-with-edl)).

### 1.6 Versions and comparison
- Drag-to-stack version stacks (any file types mixable); reorderable; comments are per-version; shares can "show all versions" ([version stacking](https://help.frame.io/en/articles/9101068-version-stacking)).
- Comparison Viewer (V4): any 2 assets cross-type, linked/unlinked zoom, comment on either side; image overlay slider + pixel-diff mode ([comparison viewer](https://help.frame.io/en/articles/9952618-comparison-viewer)).

### 1.7 Organization and metadata
- Hierarchy: Account > Workspaces > Projects > Folders; restricted (invite-only) projects and folders break inheritance (Team+); request-access flow ([roles doc](https://help.frame.io/en/articles/9875389-user-roles-and-permissions)).
- Collections (V4 flagship): metadata-driven smart views with stacked filters, grouping, sorting; assets are references; Team vs Private; shareable with filter state preserved ([collections](https://help.frame.io/en/articles/9101042-collections-overview)).
- Metadata: 32 built-in fields (read-only technical + editable workflow); custom fields with ~10 types (text, select, multi-select, date, toggle, rating, assignee, keywords, status); account-wide field library; `metadata.value.updated` webhook. No built-in embedded-metadata extraction to custom fields (API-only) ([metadata overview](https://help.frame.io/en/articles/9101037-metadata-overview)).
- Search: "Media Intelligence" NLP/semantic + visual search across filenames/metadata/comments/transcripts (Team/Enterprise, late 2025) ([search article](https://help.frame.io/en/articles/9101079-enhanced-search-with-media-intelligence)).
- Lifecycle: archival storage killed Oct 2024, replaced by Active/Inactive projects; Enterprise auto-delete Asset Lifecycle Management.

### 1.8 Sharing
- Single "Shares" model replaced V3 review links + presentation links (legacy links frozen read-only). Layouts: Grid, List, Reel; per-share toggles: comments, downloads, show-all-versions, captions ([shares](https://help.frame.io/en/articles/9105232-shares-in-frame-io)).
- Security ladder: passphrase + expiry (Pro+); Secure Sharing invite-only w/ sign-in (Enterprise Prime); session watermarking - burns name/email/IP/date, positionable, applies to streams AND downloads (Prime); forensic watermarking (NAGRA, GA Sept 2025, Prime) - invisible per-session IDs in proxies ([FWM doc](https://help.frame.io/en/articles/12091837-forensic-watermarking)); DRM - Widevine/FairPlay/PlayReady (Prime); static watermark: 1 template on Pro/Team.
- Custom branding (icon/header/colors/templates, Pro+); share analytics (opened/viewed/commented/downloaded, view counters, `share.viewed` webhook).

### 1.9 Desktop, apps, API
- Transfer app (Mac/Win): bulk up/down preserving structure, priority queue, EDL/FCPXML exchange-list export, DRM/watermarked downloads ([Transfer](https://help.frame.io/en/articles/3978929-frame-io-transfer-download-and-upload-files-folders-and-projects-on-your-desktop)).
- Frame.io Drive (NAB April 2026): mounts projects as streaming on-demand local drive; Premiere Productions lock files propagate under 1s; separate "Mounted Storage" quota ([launch post](https://blog.frame.io/2026/04/15/introducing-frame-io-drive-access-your-media-anywhere-instantly/)).
- NLE integrations: Premiere panel native in 25.6+ plus sequence-aware Comments panel (markers on timeline); AE panel beta, "full by July 2026"; **DaVinci Resolve: NOT supported in V4** (BMD built on old API, no rebuild committed); FCP share-destination degraded ([enterprise V4 guide](https://help.frame.io/en/articles/9893008-what-to-expect-when-updating-to-v4-a-comprehensive-guide-for-enterprise-customers)). Dropped in V4: Vimeo, Dropbox, Capture One, new Slack connections.
- API v4: REST at `api.frame.io/v4/` (OpenAPI spec published), OAuth via Adobe IMS only, cursor pagination, rate-limited; resources for files/folders/projects/comments/shares/metadata/version-stacks/collections/webhooks/custom-actions; webhooks with HMAC-SHA256 signatures, 5 retries w/ backoff; TS + Python SDKs ([dev docs](https://next.developer.frame.io/platform/docs/getting-started)).
- Apps: iOS/iPadOS (full review parity), Apple TV 4K HDR (all plans, DRM client), no Android, no Vision Pro.
- Extras: transcription 27 languages w/ Speaker ID + SRT/VTT/TXT export (all plans; verified); Content Credentials (C2PA) preserved; Storage Connect BYO-S3 (Prime); LucidLink integration; Firefly AI actions (Reframe, Dub, Remove BG).

### 1.10 Roles/permissions
Account Owner > Content Admin > Member (paid seat) > Guest (free, 1 project at a time; 1 on Free, 3 on Pro) > Reviewer (free, share-link only, no account). Resource-level grants at workspace/project/folder: `full_access`, `editor`, `edit_only` (no share/download), `commenter`, `viewer` ([permissions guide](https://next.developer.frame.io/platform/docs/guides/managing-user-permissions)).

### 1.11 Pricing (verified 2026-07)

| | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| Price | $0 | $15/member/mo | $25/member/mo | Custom (Select / Prime) |
| Members | 2 | up to 5 | up to 15 | Custom |
| Storage | 2GB | 2TB + 2TB/added member | 3TB + 2TB/member | Custom |
| Gates | C2C, transcription, 1080p | branding, passphrase/expiry, attachments, 1 watermark | 4K playback, restricted projects, internal comments, semantic search | SSO, multi-workspace; Prime: BYO-S3, Secure Shares, session+forensic WM, DRM |

CC bundle: All Apps / Premiere / AE subs get Frame.io free - 100GB, 2 users, 5 projects, C2C ([Adobe FAQ](https://helpx.adobe.com/x-productkb/multi/frameio-creative-cloud-faq.html)). Storage add-ons in 250GB increments. The billing trap: unlimited reviewers are free, but member #6 forces Pro to Team, repricing every seat to $25.

### 1.12 Documented pain points
- **Seat pricing** - the universal complaint: review clients accidentally converted to $15-25 seats; "data is what costs money, not how many people use it" ([r/editors alternatives megathread](https://reddit.com/r/editors/comments/1jvvvm8/i_tested_8_frameio_alternatives_for_media_review/)); accidental-invite $800 billing shocks.
- **Storage**: archival tier killed Oct 2024; exceeding quota can suspend accounts and break existing share links; legacy add-on ~$60/TB/mo.
- **V4 migration**: launched missing transcription/text review/granular controls (shipped through 2025); Resolve integration permanently gone; Premiere panel regressions (markers deleted, undo broken, throttled uploads); email reply-notifications broken; version compare missing on external shares initially; offline mode removed; API breakage "bricks our production pipeline" ([Frame forum](https://forum.frame.io/t/forced-migration-to-frameio-v4-will-break-my-entire-companys-pipeline/3190)); no downgrade path.
- **Adobe-ification**: mandatory Adobe IMS identity, auth loops in AE/Premiere, ~2 incidents/month ([status history](https://isdown.app/status/frame-io)); LGG thread "[Does Frame.io suck for you now too](http://www.liftgammagain.com/forum/index.php?threads/does-frame-io-suck-for-you-now-too.16912/)" documents broken storage accounting and support decay. Colorists also fight gamma shift (Rec709-A tagging) on the player.

## 2. Competitors - differentiators at a glance

| Product | One-liner differentiator | Pricing signal |
|---|---|---|
| [Dropbox Replay](https://www.dropbox.com/replay) | The price disruptor: $10/user/mo on existing Dropbox; widest cheap-tier NLE set (Premiere, AE, FCP, Resolve, Pro Tools, LumaFusion); patented live synced review; 150GB files. UI widely panned | $120/yr add-on |
| [Vimeo Review](https://vimeo.com/blog/post/vimeo-review-tools) | Review bundled with hosting you already pay for; relaunched Nov 2025 (version stacks, password/expiry links); clients find it simplest | $12-65/seat/mo |
| [SyncSketch](https://syncsketch.com) (Unity) | Best-in-class drawing: pressure-sensitive/custom brushes, Wacom-grade sketch-over; reviews video, images, PDFs and interactive 3D models; live synced browser sessions | Free-$19/seat |
| [cineSync 5](https://www.cinesync.online) / ftrack Review (Backlight) | Media never uploaded - encrypted frame-sync commands only; local EXR/DPX playback, OCIO/LUTs, SDI out. The MPA-security choice | Play free; $19-50/user/mo |
| [MediaSilo](https://www.mediasilo.com) (EditShare) | SafeStream visible + forensic watermarking from the $25 tier - what Frame.io locks behind Enterprise Prime; screener/dailies heritage; Resolve + CC integrations | $15-25/user/mo |
| [Sony Ci](https://www.cimediacloud.com/pricing/) | Storage-based pricing, unlimited members from $49/mo - demolishes per-seat math; live synced VideoReview; the most-endorsed V4-refugee destination | $49-249/mo flat |
| [Kollaborate](https://www.kollaborate.tv) | Only mainstream self-hosted option (Server: one-time $159-$1,899 + maintenance); NLE marker round-trip via Cut Notes ecosystem; storage-based cloud tiers; dated LAMP/IonCube stack but 2026-active | $7/mo cloud; $159+ server |
| [Krock.io](https://krock.io) | Cheap animation-pipeline review: storyboard/animatic tool, drawing annotations, unlimited free reviewers, Adobe marker sync | Free; ~$10/user |
| [ReviewStudio](https://reviewstudio.com) | Agency proofing across 100+ formats; range comments, synced side-by-side compare, task-style approvals | $15-25/user |
| [Wipster](https://www.wipster.io) | Alive but fragile (2025 multi-day domain-loss outage); simple marketing-team UX, Premiere panel | ~$20-40/user |
| [Evercast](https://www.evercast.us) | "Zoom for post": live 4K60 streaming of your running NLE/DAW + annotation; no uploads. Complements async tools | ~$549-849/mo/room |
| [Autodesk Flow Capture](https://www.autodesk.com/products/flow-capture) (ex-Moxion/PIX) | Studio dailies: on-set capture to cloud, HDR, per-viewer watermarks, Avid panel; episodic/exec tier | Quote-only |
| Also-rans/adjacent | ftrack Review ($15), Assemble (PM+review), Pomfort ShotHub (DIT side), Filestage/Ziflow/PageProof (agency proofing), Louper (colorist live rooms, rising), Notism (stagnant). Screenlight shut down July 2024 ([notice](https://screenlight.tv/screenlight-video-review-and-approval-shutdown)) | |

## 3. Open-source / self-hosted landscape - the field was empty until ~2024

Headline finding: demand has existed since 2016 (near-annual r/selfhosted threads), but real OSS entrants only appeared in the last ~18 months, all under 300 stars. Nobody has NLE integrations, C2C, or watermarking.

| Project | Stack | Status | Notable |
|---|---|---|---|
| [Clapshot](https://github.com/elonen/clapshot) | Rust + Svelte, SQLite, FFmpeg | 253 stars, v0.12.0 Jun 2026, most mature | Real-time synced playback + mirrored drawings (SyncSketch-like), 7-color annotations, version sets, EDL import, Slack bot, plugin system. Gaps: SQLite-only, no approval workflow, spartan UI, single maintainer. GPLv2 |
| [FreeFrame](https://github.com/Techiebutler/freeframe) | Next.js + FastAPI, Postgres, Celery/Redis, S3, HLS | 100 stars, v1.1.4 Apr 2026, active | Most Frame.io-shaped architecture: frame-accurate range comments, canvas drawings, per-reviewer approvals, side-by-side compare, expiring guest links, SSE. MIT. Young; agency-backed |
| [ViTransfer](https://github.com/MansiVisuals/ViTransfer) | Next.js/Prisma, TUS uploads, FFmpeg | 67 stars, v1.1.3 Jun 2026, "feature-complete" maintenance mode | Solo-freelancer shape: password/OTP share links, approval + project sign-off, version slider. AGPL. Active fork: [FrameComment](https://github.com/DragosOnisei/FrameComment) |
| [shumai](https://github.com/shumaiOne/shumai) | TS/Bun, Postgres+pgvector, Temporal transcode workers | 129 stars, v0.1.4 Jul 2026, pre-1.0 | Ambitious: distributed transcoding, RBAC, custom metadata, semantic search. Watch item. MIT |
| [OpenFrame](https://github.com/yusufipk/OpenFrame) | Next.js 16/Prisma/MinIO | 84 stars, active | Voice-note comments, CSV/PDF export, Telegram notify - but Fair Source, not OSS |
| [OpenVidReview](https://github.com/davidguva/OpenVidReview) | Node/Express/SQLite | 131 stars, 14 commits, stalled | Only OSS project with EDL export to Resolve; author warns "use at your own risk." Stars = demand signal, not maturity |
| [Kitsu/Zou](https://github.com/cgwire/kitsu) (CGWire) | Vue + Python, AGPL | 653 stars, v1.0.48 Jun 2026 | The mature OSS review experience (frame annotations, version compare, statuses) - but shaped as an animation/VFX production tracker, not client share links |
| [OpenRV](https://github.com/AcademySoftwareFoundation/OpenRV) / [xSTUDIO](https://github.com/AcademySoftwareFoundation/xstudio) (ASWF) | C++ | 742/754 stars, active | Hollywood-grade desktop review players with annotations - no web layer, no shares, no hosting |
| Adjacent, not-it | [MediaCMS](https://github.com/mediacms-io/mediacms) (timestamped comments but YouTube-style portal), PeerTube (open issue only), CVAT/Label Studio/Tator (ML labeling), ResourceSpace (DAM). Nextcloud/WordPress: nothing. [MyFrame](https://github.com/KyleTryon/MyFrame) archived 2021 | | |

Why they stall: transcoding infra + frame-accurate player + real-time sync is too much surface area for solo maintainers; the good ones drift to Fair Source/SaaS or maintenance mode. Universal gaps vs Frame.io: NLE panels/marker round-trip, C2C, mobile, watermarking, transcription, multi-tenant scale.

## 4. What practitioners actually want (forum synthesis, 2023-2026)

Dominant narrative arc: "V3 was elegant", then Adobe enshittification, then forced V4 broke integrations, then leak to Replay/Vimeo/Sony Ci/Kollaborate - while conceding "there is no true alternative to frame that's equally as good."

Must-haves ranked by forum frequency:
1. **Comments to NLE markers round-trip** (Resolve especially, since V4 killed it): "Literally just need ability to upload exports, reviewer leave timestamp feedback that syncs back down to NLE, and compare side by side. At a fair price." ([megathread](https://reddit.com/r/editors/comments/1jvvvm8/i_tested_8_frameio_alternatives_for_media_review/))
2. **No forced client accounts** - reviewers comment with just name+email; the #1 reason tools get rejected (MediaSilo, BMD Presentations dinged for logins).
3. **Storage-based, not seat-based pricing** - "seats cost another $15 and not just $3 when it's just using the same storage... basically robbery."
4. **Client-proof simplicity** - proxy-download traps ("clients download the proxy and upload a 4k deliverable in 480p"), approve-button ambiguity, notification control (V4 broke reply emails).
5. **Playback fidelity** - gamma-shift correctness (Rec709-A), 10-bit HDR, fast uploads (Frame's remaining crown), speed range beyond 1.75x.
6. **Watermarking below enterprise price** - explicit asks on [r/videography](https://reddit.com/r/videography/comments/1j89qg1/video_review_platform_with_watermark_option/); Replay/MediaSilo win switchers here.
7. **Self-hosting demand is real and decade-old**: r/selfhosted threads 2016-2023, a 2024 "[I made a self-hosted frame.io clone](https://reddit.com/r/selfhosted/comments/1djmhbk/i_made_a_self_hosted_frameio_clone/)" post ("how hard can it be? ...pretty pretty hard"), motivated by per-user share pricing + retention control.

## 5. Implications for the build

- The moat to copy is the comment model (frame/range/anchored-pin/drawing + statuses + export) plus a boringly reliable transcode-to-multi-rendition pipeline. The moat nobody OSS has crossed is NLE marker round-trip (Premiere panel, Resolve via OTIO/EDL-with-text - fixing Frame's known dropped-comment-text EDL bug would be an instant differentiator) - and Resolve integration is a vacated niche: Adobe abandoned it in V4 and colorists are vocal about it.
- Pricing wedge: seat-free reviewers + storage-you-own is precisely the complaint self-hosting answers; Sony Ci and Kollaborate prove the demand for non-seat economics.
- Table stakes from the V4 spec: share links w/ passphrase+expiry+download toggle, version stacks + compare, anonymous commenting, PDF/CSV comment export, J/K/L + frame-step player with I/O ranges, original-file downloads, HMAC-signed webhooks + clean REST API (V4's API-breakage saga shows how much users value API stability).
- Deferrable: C2C, DRM, forensic watermarking, mobile apps, semantic search. Cheap wins: session-based burned-in watermark (users want it at Pro prices), transcription via Whisper, EDL/OTIO export.
- Competitive slot is open: Clapshot is the only proven OSS incumbent and it's one Rust dev with SQLite; FreeFrame validates the Next.js+FFmpeg+HLS+S3 shape but is unproven. Nothing occupies "production-grade, self-hosted, NLE-integrated review" - the exact thing forums have asked for since 2016.
