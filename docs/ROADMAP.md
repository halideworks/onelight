# Onelight roadmap

This is the working plan: where v1 stands, what hardening remains before tagging v1.0, and the forward phases from the design doc. The design doc (section 20) remains the source of truth for phase content; this file tracks execution state. Update it whenever a milestone lands or scope moves.

## Current state (2026-07-11)

v1 scope (phases 0-3) is implemented. The build went through a full defect audit and repair pass (docs/audits/2026-07-11-v1-audit.md), then a remainder build in two waves that added: the exhaustive two-backend contract suite (263 Node tests, 155 on the D1 workers pool, 114 permission matrix cells, which surfaced and fixed nine further product bugs), Cloudflare R2 storage and cron webhook delivery, the dashboard surfaces (notifications with server-side generation, server-scoped search, sessions, admin queue, folder tree CRUD), the review-room features (timeline marker lane, rendition switching, surround control, annotation drawing, session watermark overlay), the PDF report with annotated stills, the burned watermark path end to end (generation, reconciliation sweep, watermark-only serving with 202-while-pending, download enforcement), OpenAPI with real zod-derived schemas plus a committed generated client, the public bootstrap endpoint, Idempotency-Key upload replay, and the qa/ media verification harness (WebCodecs frame-accuracy ground truth across all eight supported rates, golden-frame color QC in Chromium and Firefox, tmcd round-trip), wired as a CI job.

All automated gates are green on this machine, including the qa suites executed against real ffmpeg-synthesized fixtures: typecheck, eslint, prettier, Node contract suite, D1 workers-pool suite, db:check, openapi:check, svelte-check, SPA build, qa.

## Before tagging v1.0 (blocking)

1. Linux verification run (David or CI): libplacebo BT.2390 tonemap initializes on lavapipe in the worker container; zscale 601 to 709 conversion output on real footage; the 23.976 ProRes tmcd fixture; pdftoppm page rendering; compose stack end to end (uid 10001 volume ownership, healthchecks, SIGTERM shutdown, worker HMAC and heartbeat under a long transcode); first green run of the media-qc CI job including real Safari/WebKit.
2. Real NLE import round-trips of the marker exporters (Resolve EDL, Avid text, xmeml, FCPXML) against actual applications, recorded per the golden-file protocol in the design doc. The fixtures are byte-exact; the NLEs are the judges.
3. Browser pass on the review room and share flows (keyboard map, focus order, drawing, watermark overlay) with screenshots checked against section 24 and the mockups. The player transport and timeline were screenshot-verified against mockups/player.html during the build; the full-app pass remains.
4. HDR pipeline fixtures (PQ and HLG) through the qa harness or the manual run; the curated real-camera corpus of design doc section 21 (ProRes/DNx/XAVC, VFR phone clip, 8ch MXF, broken files) as CI fixtures where licensing allows.

## Hardening backlog (post-v1.0, rough priority)

- Incomplete-upload reaping, storage usage accounting reconciliation, and blob GC (dry-run first), per the phase-1 design doc scope.
- Email delivery (SMTP notifications, digests honoring the instant/hourly/daily preference, self-service password reset), specced in phase-2 scope.
- Uppy-based uploader (folders, directory trees, camera cards) replacing the minimal uploader.
- Asset browser depth: thumbnail grid, sortable detail list, batch operations, drag-stacking (design doc section 24.7); filmstrip and waveform timeline lanes (sidecar URLs are now exposed on share details; the review page has renditions available).
- Worker pump over signed URLs so the media worker can run against R2/S3 storage instead of a shared filesystem (unblocks full CF transcode and split-host deployments; design sketch in apps/cf/src/index.ts).
- General Idempotency-Key response-replay store (the current implementation replays upload creation; see the phase-1 supersession note).
- SQLite FTS5 search on Node with LIKE fallback on D1 (the spec supersession keeps LIKE everywhere until D1 FTS5 support is verified).
- Webhook signed timestamp for replay bounding; DNS-rebinding-safe webhook delivery.
- Mentions and hashtags in comments (schema supports hashtags in search; UI and parsing not built).
- Reel-specific share layout treatment; a true tiled watermark grid (v1 approximates with three diagonal placements).
- True Media Composer marker XML once a captured real MC export exists (avid_xml currently emits the MC text format; see the phase-3 supersession note).

## Forward phases (design doc section 20)

- Phase 4, realtime collaboration: presence, watch-together, live mirrored drawing, comparison viewer. Acceptance: sync drift <= 2 frames p95 on 100ms RTT.
- Phase 5, Cloudflare target completion: R2 event notifications -> Queues -> Container transcode pipeline, DO realtime hub, deploy button, Stream adapter, CF e2e against a live staging account. Note: R2 storage, D1, scheduled webhook delivery, and SPA serving already landed in the v1 remainder pass; phase 5 is the transcode pipeline and productization.
- Phase 6, ecosystem: CLI (push/pull/sync/watch/export/import portability), Resolve Workflow Integration plugin (the flagship), Premiere UXP panel, Tauri transfer app, C2C-style device ingest.
- Phase 7, color-critical and intelligence: reference-mode proxies, WebGPU scopes, LUT preview, comment re-anchoring across versions (perceptual hash), whisper transcription, per-session burned watermarking, HLS/ABR option, EXR/DPX ingest, BRAW/R3D plugins pending licensing.
- Order of phases 4 and 5 may swap based on community pull after v1 (design doc open question 7).

## Standing rules

Every phase gets an implementation spec at the rigor of specs/phase-0.md before execution, adversarially reviewed. Acceptance checks are the task. The contract suite runs on both backends at every step. Frame accuracy and color correctness tests are never weakened to make CI pass.
