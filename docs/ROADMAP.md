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

## Before tagging v1.0 (blocking, all require Linux or human judgement)

1. First green run of the integration and media-qc CI jobs on Linux: this exercises compose end to end, the HDR libplacebo tonemap on lavapipe (the new -init_hw_device vulkan flag), the zscale 601-to-709 conversion on partially-tagged sources, tmcd write, pdftoppm, watermark burn, range serving, and graceful shutdown against real ffmpeg. Most of what used to be manual is now automated here; it just needs to run on a Linux runner with Docker.
2. Real NLE import round-trips of the marker exporters (Resolve EDL, Avid text, xmeml, FCPXML) against actual applications, recorded per the golden-file protocol in the design doc. Fixtures are byte-exact and fuzz-hardened; the NLEs are the judges.
3. Full-app browser pass on the review room and share flows (keyboard map, focus order, drawing, watermark overlay, modal a11y) with screenshots checked against section 24 and the mockups.
4. The curated real-camera corpus of design doc section 21 (ProRes/DNx/XAVC, VFR phone clip, 8ch MXF, broken files) as CI fixtures where licensing allows; synthetic PQ/HLG fixtures already run.

## Hardening backlog (post-v1.0, rough priority)

- Worker pump over signed URLs so the media worker can run against R2/S3 storage instead of a shared filesystem (unblocks full CF transcode and split-host deployments; design sketch in apps/cf/src/index.ts). This is the largest remaining architectural item.
- Storage usage accounting reconciliation surfaced in the UI (the GC reconciliation and reaping sweeps exist server-side).
- A separate export pump so a long export does not head-of-line-block transcode on the single pump.
- Uppy-based uploader if the directory uploader proves insufficient for camera-card ingest at scale.
- General Idempotency-Key response-replay store (the current implementation replays upload creation; see the phase-1 supersession note).
- SQLite FTS5 search on Node with LIKE fallback on D1 (the spec supersession keeps LIKE everywhere until D1 FTS5 support is verified).
- Webhook signed timestamp for replay bounding; DNS-rebinding-safe webhook delivery.
- Reel-specific share layout treatment; a true tiled watermark grid (v1 approximates with three diagonal placements); watermarked sprite sidecars (the scrubber filmstrip on a watermarked share currently shows clean low-res frames).
- True Media Composer marker XML once a captured real MC export exists (avid_xml currently emits the MC text format; see the phase-3 supersession note).
- A public unfurl-image route so share OG tags can carry og:image (all media URLs are signed today, so no image is emitted).

## Forward phases (design doc section 20)

- Phase 4, realtime collaboration: presence, watch-together, live mirrored drawing, comparison viewer. Acceptance: sync drift <= 2 frames p95 on 100ms RTT.
- Phase 5, Cloudflare target completion: R2 event notifications -> Queues -> Container transcode pipeline, DO realtime hub, deploy button, Stream adapter, CF e2e against a live staging account. Note: R2 storage, D1, scheduled webhook delivery, and SPA serving already landed in the v1 remainder pass; phase 5 is the transcode pipeline and productization.
- Phase 6, ecosystem: CLI (push/pull/sync/watch/export/import portability), Resolve Workflow Integration plugin (the flagship), Premiere UXP panel, Tauri transfer app, C2C-style device ingest.
- Phase 7, color-critical and intelligence: reference-mode proxies, WebGPU scopes, LUT preview, comment re-anchoring across versions (perceptual hash), whisper transcription, per-session burned watermarking, HLS/ABR option, EXR/DPX ingest, BRAW/R3D plugins pending licensing.
- Order of phases 4 and 5 may swap based on community pull after v1 (design doc open question 7).

## Standing rules

Every phase gets an implementation spec at the rigor of specs/phase-0.md before execution, adversarially reviewed. Acceptance checks are the task. The contract suite runs on both backends at every step. Frame accuracy and color correctness tests are never weakened to make CI pass.
