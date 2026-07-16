# Onelight: working rules for AI-assisted development

Onelight is an AGPL-3.0 self-hosted frame.io replacement (async media review for post-production). This file is the entry point for any model or contributor working on the project. Read it before touching anything.

CLAUDE.md and AGENTS.md are identical by policy (two agent families work in this repo). Any edit to one must be applied to both.

## Document map

| Document | Purpose |
|---|---|
| `onelight_design_doc.md` | The product and architecture source of truth: every locked decision, data model, media pipeline, player design, phases with acceptance criteria, UI design language (section 24) |
| `specs/phase-0.md` .. `specs/phase-3.md` | Implementation-grade specs per phase. Execute exactly; where the implementation legitimately diverged, an explicit supersession note is recorded in the spec (search "Supersession") |
| `docs/ROADMAP.md` | Execution state: what is built, what blocks the v1.0 tag, the hardening backlog, and the forward phases. Update it when milestones land or scope moves |
| `docs/audits/2026-07-11-v1-audit.md` | Full audit of the v1 build: every defect found and fixed, spec supersessions, and the same-day remainder-build addendum |
| `qa/` | Media verification harness: WebCodecs frame-accuracy ground truth, golden-frame color QC, tmcd round-trip. Fixtures are synthesized at test time. See qa/README.md for the seed-reproduction workflow |
| `docs/research/` | The three deep-research reports (2026-07) the design doc is built on: frame.io feature inventory and competitive landscape, browser playback and transcode pipeline, Cloudflare platform feasibility. Verified facts, URLs, licensing landmines. Consult before re-deriving anything |
| `mockups/` | Living visual reference (open index.html in a browser). `mockups/tokens.css` is the design-token source; `packages/web/src/lib/tokens.css` is its byte-identical port (prettier-ignored; keep them identical) |
| `gradients/PALETTES.md` | The Japanese gradient palette catalog with hex codes; the identity/theming color source |

## Hard rules (from David, non-negotiable)

- No emojis and no em or en dashes, anywhere: prose, UI copy, code comments, commit messages, docs. Use plain hyphens, commas, colons, or separate sentences. No decorative arrows in prose (ASCII `->` in technical diagrams is fine).
- UI anti-slop list: no Inter, no gradient border highlights, no glassmorphism, no glow shadows, no decorative monospace labels, no random italics, no uppercase-tracked microcopy. No soft-3D surfaces: panels and cards are flat value steps, never gradient fills with inset highlights and drop shadows. Dropdown selects wear no focus outline; focus is a value step.
- Two visual worlds with a hard boundary: the REVIEW player (the full instrument: internal review pages and shares using the Review player) is strictly neutral grey, R=G=B, zero gradients. Everywhere else, dark ink + Japanese gradient washes, one grammar (vertical, dark top, light bottom). PRESENTATION mode is explicitly the washed world, on any share kind: it exists to be beautiful for clients, and the neutrality rule never applies to it (David has said this explicitly, more than once).
- Borders are exceptional; separate with value steps and space. Empty space must be intentional or informational, never leftover.
- Type: Space Grotesk for display, Switzer for working UI, tabular-nums on all timecode. Nav/secondary text no smaller than 13px.
- Positions in data are integer frames + rational frame rate, never seconds. `currentTime` never determines frame identity in the player.
- The REST API is a public contract: snake_case wire format through wire mappers (never serialize raw ORM rows), OpenAPI derived from the registered routes (never a hand-maintained path list), no breaking changes without versioning.

## Verification gates

All of these must be green before any change lands. Do not pipe test commands through `tail`/`head` in a way that masks exit codes.

```
pnpm typecheck      # tsc -b across all packages (also builds the composite dist test:workers needs)
pnpm lint           # eslint, no warnings
pnpm format         # prettier --check
pnpm test           # Node/better-sqlite3 suite (contract, property, golden tests)
pnpm test:workers   # the same contract suite on D1 via @cloudflare/vitest-pool-workers
pnpm db:check       # migration D1-safety and FK check
pnpm openapi:check  # committed openapi.json and generated client are not stale
pnpm web:check      # svelte-check
pnpm qa             # media verification harness (skips cleanly where ffmpeg/browsers are missing)
```

- The contract suite must pass on BOTH better-sqlite3 (Node) and D1 (workers pool) at every step. Every new endpoint or contract change lands with contract tests in packages/api/src/contract/ (both legs run the same suite).
- OpenAPI is generated: request/response schemas come from the shared zod objects in packages/api/src/schemas.ts (one source of truth with the validators), paths from the registered routes. After API changes run `pnpm openapi:gen` and commit the regenerated openapi.json and api-types.gen.ts; openapi:check fails CI otherwise.
- Frame accuracy and color correctness are the two credibility-critical domains; their tests (timecode property tests, marker golden fixtures, golden-frame color QC, WebCodecs ground truth) are never skipped or weakened to make CI pass.
- NLE export formats (Resolve EDL, Avid, xmeml, FCPXML) are byte-exact golden-fixture tested. Never write an export format from memory: capture a real export from the target NLE or use the formats documented in docs/research, and round-trip before shipping.
- Hand-duplicated artifacts (the embedded D1 migration copies, the tokens.css port) have parity tests; if you add another duplication, add its parity test in the same change.

## Environment traps (Windows dev box)

- Node here is 25.x; better-sqlite3 must stay >= 12 for prebuilds. If tests fail with NODE_MODULE_VERSION errors, the native module does not match the running Node.
- pnpm is pinned via packageManager (9.15.5). A node_modules created by a different pnpm major triggers a reinstall-from-scratch prompt that hangs non-interactive shells; `rm -rf node_modules && CI=true pnpm install`.
- Never redirect command output to `NUL` from scripts; under this shell it creates a literal `NUL/` directory (gitignored, but do not create it).
- `wrangler.jsonc` `compatibility_date` must not exceed what the installed workerd supports (the workers pool warns and falls back; keep the pinned date honest).

## Process

1. One implementation spec per phase, written at the rigor of `specs/phase-0.md` (full DDL deltas, endpoint contracts, dependency-ordered tasks with acceptance checks), authored at phase start from the design doc + research, reviewed adversarially before execution (have independent reviewers attack it for missing decisions, then fix).
2. Execute tasks in spec order; each task lands with its acceptance checks green. Acceptance checks are the task: a task whose tests are smoke-level stand-ins is not done.
3. The design doc and specs are updated whenever the implementation supersedes them (mark the supersession explicitly with a dated note, as the phase specs now do).
4. Verify visually: render UI changes (headless Chrome screenshots are fine) and check against section 24 and the mockups before considering UI work done.
5. When auditing or reviewing, distrust green CI until you have checked what the tests actually assert. The v1 build passed CI while the Resolve EDL, the HDR pipeline, J/K/L, and the D1 migration path were all broken; the audit report documents the pattern.

## CI jobs

CI runs four jobs (.github/workflows): `node` (lint, typecheck, format, openapi:check, test, test:workers), `docker` (both image builds), `media-qc` (the qa harness: WebCodecs frame accuracy, color QC in Chromium/Firefox/WebKit, tmcd, HDR tonemap), and `integration` (compose up, a real upload/probe/transcode/serve/share/export/watermark/HDR round-trip via scripts/integration-e2e.mjs, plus a graceful-shutdown assertion). The integration and media-qc jobs need a Linux runner with ffmpeg and Docker; they are where the ffmpeg-dependent behavior is actually confirmed.

## Deployment and privacy notes

- Client IP for rate limiting and session records is resolved through a TRUST_PROXY-aware helper: with TRUST_PROXY unset or false (default), the socket address is used and proxy headers are ignored. Self-hosters behind a reverse proxy MUST set TRUST_PROXY=true or per-IP limits collapse to one bucket.
- Fonts (Space Grotesk, Switzer) are self-hosted under packages/web/src/lib/fonts and loaded via lib/fonts.css. Do not reintroduce the Fontshare CDN import; a self-hosted product must not phone home, and the review room must not block on an external fetch.
- The API is a public contract: never serialize raw ORM rows to share viewers. Public share and comment projections deliberately omit passphrase_hash, watermark_spec_hash, viewer_key, and member emails.

## State of v1 (2026-07-11)

Phases 0-3 are implemented, audited, repaired, and feature-completed through a two-wave remainder build plus a full-gap build with three adversarial reviewers whose findings were all fixed; all gates above are green, including the qa harness and integration dry-run executed on this machine. What blocks the v1.0 tag is enumerated in docs/ROADMAP.md and is now Linux-only or human-judgement: the first green integration and media-qc CI runs (which automate most of the former manual Linux checks), real-NLE import round-trips, and the full-app browser pass against section 24. David manually validates NLE imports, HDR behavior, and browser color.

## Context worth knowing

- David (halideworks) is building open tools to replace rent-extracting post-production vendors. Sibling project Chromatic (Go + SvelteKit, live review sessions) shares the family look; Onelight is TypeScript everywhere specifically because of the Cloudflare Workers target.
- v1 = design doc Phases 0-3. Resolve integration leads the NLE roadmap (Adobe vacated it). The differentiators to protect: text-preserving Resolve marker EDL, comments carried across versions, color-critical playback, seat-free economics.
- Naming register for future features/products: photochemical and film-workflow terms (Onelight = one-light dailies).
