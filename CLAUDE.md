# Onelight: working rules for AI-assisted development

Onelight is an AGPL-3.0 self-hosted frame.io replacement (async media review for post-production). This file is the entry point for any model or contributor working on the project. Read it before touching anything.

## Document map

| Document | Purpose |
|---|---|
| `onelight_design_doc.md` | The product and architecture source of truth: every locked decision, data model, media pipeline, player design, phases with acceptance criteria, UI design language (section 24) |
| `specs/phase-0.md` | Implementation-grade spec for Phase 0. Execute it exactly; it is written to require no product decisions |
| `docs/research/` | The three deep-research reports (2026-07) the design doc is built on: frame.io feature inventory and competitive landscape, browser playback and transcode pipeline, Cloudflare platform feasibility. Verified facts, URLs, licensing landmines. Consult before re-deriving anything |
| `mockups/` | Living visual reference (open index.html in a browser). `tokens.css` is the design-token source; it ports into `packages/web` verbatim at Phase 0 T19 |
| `gradients/PALETTES.md` | The Japanese gradient palette catalog with hex codes; the identity/theming color source |

## Hard rules (from David, non-negotiable)

- No emojis and no em or en dashes, anywhere: prose, UI copy, code comments, commit messages, docs. Use plain hyphens, commas, colons, or separate sentences. No decorative arrows in prose (ASCII `->` in technical diagrams is fine).
- UI anti-slop list: no Inter, no gradient border highlights, no glassmorphism, no glow shadows, no decorative monospace labels, no random italics, no uppercase-tracked microcopy.
- Two visual worlds with a hard boundary: review room (player, comparison, anything near footage) is strictly neutral grey, R=G=B, zero gradients. Everywhere else: dark ink + Japanese gradient washes, one grammar (vertical, dark top, light bottom).
- Borders are exceptional; separate with value steps and space. Empty space must be intentional or informational, never leftover.
- Type: Space Grotesk for display, Switzer for working UI, tabular-nums on all timecode. Nav/secondary text no smaller than 13px.
- Positions in data are integer frames + rational frame rate, never seconds.
- The REST API is a public contract: OpenAPI generated from routes, no breaking changes without versioning.

## Process

1. One implementation spec per phase, written at the rigor of `specs/phase-0.md` (full DDL deltas, endpoint contracts, dependency-ordered tasks with acceptance checks), authored at phase start from the design doc + research, reviewed adversarially before execution (have independent reviewers attack it for missing decisions, then fix).
2. Execute tasks in spec order; each task lands with its acceptance checks green. The contract test suite must pass on BOTH better-sqlite3 (Node) and D1 (workers pool) at every step.
3. The design doc is updated whenever a spec supersedes it (mark the supersession explicitly, as specs/phase-0.md section 4 does).
4. Verify visually: render UI changes (headless Chrome screenshots are fine) and check against section 24 and the mockups before considering UI work done.
5. Frame accuracy and color correctness are the two credibility-critical domains; their tests (timecode property tests, golden-frame color QC, WebCodecs ground truth) are never skipped or weakened to make CI pass.

## Context worth knowing

- David (halideworks) is building open tools to replace rent-extracting post-production vendors. Sibling project Chromatic (Go + SvelteKit, live review sessions) shares the family look; Onelight is TypeScript everywhere specifically because of the Cloudflare Workers target.
- v1 = design doc Phases 0-3. Resolve integration leads the NLE roadmap (Adobe vacated it). The differentiators to protect: text-preserving Resolve marker EDL, comments carried across versions, color-critical playback, seat-free economics.
- Naming register for future features/products: photochemical and film-workflow terms (Onelight = one-light dailies).
