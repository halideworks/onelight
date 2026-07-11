# Onelight roadmap

This is the working plan: where v1 stands, what hardening remains before tagging v1.0, and the forward phases from the design doc. The design doc (section 20) remains the source of truth for phase content; this file tracks execution state. Update it whenever a milestone lands or scope moves.

## Current state (2026-07-11)

v1 scope (phases 0-3) is implemented. The build went through a full defect audit and repair pass (docs/audits/2026-07-11-v1-audit.md), then a remainder pass that added: the exhaustive two-backend contract suite, Cloudflare R2 storage and scheduled webhook delivery, the dashboard surfaces (notifications, search, sessions, admin queue, folder tree CRUD), the review-room features (timeline marker lane, rendition switching, surround control, annotation drawing, session watermark overlay), the PDF report with annotated stills, and the burned watermark rendition path.

All automated gates are green on this machine: typecheck, eslint, prettier, Node contract suite (better-sqlite3), D1 workers-pool suite, db:check, svelte-check, SPA build.

## Before tagging v1.0 (blocking)

These are the design doc acceptance items that cannot be verified on this Windows dev box and the follow-ups deliberately deferred during the remainder pass:

1. Linux media verification run (David or CI with ffmpeg): libplacebo BT.2390 tonemap initializes on lavapipe in the worker container; zscale 601 to 709 conversion output; `-write_tmcd on` produces a real tmcd track on the 23.976 ProRes fixture; pdftoppm page rendering; compose stack end to end (uid 10001 volume ownership, healthchecks, SIGTERM shutdown, worker HMAC and heartbeat under a long transcode).
2. Real NLE import round-trips of the marker exporters (Resolve EDL, Avid text, xmeml, FCPXML) against actual applications, recorded per the golden-file protocol in the design doc. The fixtures are byte-exact; the NLEs are the judges.
3. Golden-frame color QC and the WebCodecs ground-truth harness in CI (headless Chrome/Firefox/WebKit screenshot comparison; frame counter vs ffmpeg-extracted frames at random seeks across all supported rates).
4. Browser pass on the review room and share flows (keyboard map, focus order, drawing, watermark overlay) with screenshots checked against section 24 and the mockups.
5. API-side serving of burned watermarked renditions to share viewers (the worker generates and registers them; the share media route must prefer them when the share carries a watermark spec).
6. Pipeline fixture corpus in CI (design doc section 21): the curated media corpus with assertions on frame counts, timecode, color tags, duration.

## Hardening backlog (post-v1.0, rough priority)

- OpenAPI request/response schemas derived from the zod validators (paths are route-generated today; bodies are stubs) and the generated openapi-typescript client replacing the hand-written web client.
- Idempotency-Key support on mutating upload routes (specced in phase-1, not implemented).
- Incomplete-upload reaping, storage usage accounting reconciliation, and blob GC (dry-run first), per the phase-1 design doc scope.
- Email delivery (SMTP notifications, digests, self-service password reset), specced in phase-2 scope.
- Uppy-based uploader (folders, directory trees, camera cards) replacing the minimal uploader.
- Asset browser depth: thumbnail grid, sortable detail list, batch operations, drag-stacking (design doc section 24.7).
- Worker pump over signed URLs so the media worker can run against R2/S3 storage instead of a shared filesystem (unblocks full CF and split-host deployments).
- SQLite FTS5 search on Node with LIKE fallback on D1 (the spec supersession keeps LIKE everywhere until D1 FTS5 support is verified).
- Webhook signed timestamp for replay bounding; DNS-rebinding-safe webhook delivery.
- Mentions and hashtags in comments (schema supports hashtags in search; UI and parsing not built).

## Forward phases (design doc section 20)

- Phase 4, realtime collaboration: presence, watch-together, live mirrored drawing, comparison viewer. Acceptance: sync drift <= 2 frames p95 on 100ms RTT.
- Phase 5, Cloudflare target completion: R2 event notifications -> Queues -> Container transcode pipeline, DO realtime hub, deploy button, Stream adapter, CF e2e against a live staging account. Note: R2 storage, D1, scheduled webhook delivery, and SPA serving already landed in the v1 remainder pass; phase 5 is the transcode pipeline and productization.
- Phase 6, ecosystem: CLI (push/pull/sync/watch/export/import portability), Resolve Workflow Integration plugin (the flagship), Premiere UXP panel, Tauri transfer app, C2C-style device ingest.
- Phase 7, color-critical and intelligence: reference-mode proxies, WebGPU scopes, LUT preview, comment re-anchoring across versions (perceptual hash), whisper transcription, per-session burned watermarking, HLS/ABR option, EXR/DPX ingest, BRAW/R3D plugins pending licensing.
- Order of phases 4 and 5 may swap based on community pull after v1 (design doc open question 7).

## Standing rules

Every phase gets an implementation spec at the rigor of specs/phase-0.md before execution, adversarially reviewed. Acceptance checks are the task. The contract suite runs on both backends at every step. Frame accuracy and color correctness tests are never weakened to make CI pass.
