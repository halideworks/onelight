# Onelight

Onelight is a self-hosted, open-source media review and approval tool for post-production. It is a frame.io alternative built for studios that want to own their footage, their notes, and their economics: no per-seat fees, no vendor lock-in, and no footage sitting on someone else's servers.

You upload originals, Onelight makes color-correct review proxies, collaborators leave frame-accurate notes with drawings, and those notes export back into the edit as markers with their text intact.

## Why it exists

Onelight is part of halideworks, a set of open tools that replace rent-extracting post-production vendors. The pieces that matter, and that most alternatives get wrong:

- Frame accuracy. Positions are stored as integer frames against a rational frame rate, never seconds. The player derives frame identity from `requestVideoFrameCallback`, not `currentTime`, and drop-frame timecode math is property-tested for a full 24 hours at every supported rate.
- Color correctness. Proxies carry explicit color tags, HDR sources are tonemapped through libplacebo, and the review room is a strictly neutral grey environment with no gradients or tinted chrome near the footage.
- Notes that survive the edit. Comments carry forward across versions with provenance, and export to Resolve marker EDL, Avid, Premiere xmeml, and FCPXML with the comment text preserved.
- Seat-free self-hosting. Run it on one box with Docker, or on Cloudflare Workers with D1 and R2.

## Status

This is a v1 in active development, covering the first four phases of the design (foundations, ingest and media pipeline, player and comments, sharing and exports). The full plan and current state are in `docs/ROADMAP.md`; the architecture and every locked decision are in `onelight_design_doc.md`.

The automated test suite is extensive: an API contract suite that runs on both SQLite (Node) and D1 (Cloudflare Workers), timecode property tests, byte-exact golden fixtures for every NLE export format, a WebCodecs frame-accuracy harness, golden-frame color QC, and a full-stack integration run. Some final acceptance steps require a Linux host with ffmpeg and real NLE applications; those are enumerated in the roadmap.

## Quick start with Docker

```sh
cp .env.example .env
# set SECRET_KEY to at least 32 random characters, and WORKER_SECRET
docker compose -f deploy/docker-compose.yml up --build
```

Browse to the configured `PUBLIC_URL`, complete first-run setup, create a project, and invite a member. `deploy/Caddyfile.example` shows a TLS-terminating reverse proxy. Production deployments must set an explicit `SECRET_KEY`; compose refuses to start without it.

## Development

Requirements: Node 22 or newer and pnpm 9.

```sh
pnpm install
pnpm dev            # API plus the web app at http://localhost:3000
```

Set `SECRET_KEY` to at least 32 characters before starting. Gates, all of which run in CI:

```sh
pnpm typecheck
pnpm lint
pnpm format
pnpm test           # Node / better-sqlite3 contract and unit suites
pnpm test:workers   # the same contract suite on the D1 workers pool
pnpm db:check       # migration D1-safety and foreign-key check
pnpm openapi:check  # committed OpenAPI document and generated client are current
pnpm web:check      # svelte-check
pnpm qa             # media verification harness (skips where ffmpeg is absent)
```

## Layout

Onelight is a pnpm monorepo, TypeScript throughout for the Cloudflare Workers target.

| Path | Purpose |
|---|---|
| `packages/core` | Runtime-agnostic domain: ids, time, timecode, markers, permissions, ports |
| `packages/db` | Drizzle schema, migrations, and the migration runners for both backends |
| `packages/api` | The Hono application, routes, and the contract test suite |
| `packages/player` | The frame-accurate video player, timeline, and annotation overlay |
| `packages/web` | The SvelteKit single-page app |
| `packages/worker` | The media pipeline: probe, proxy ladder, sidecars, watermarks, PDF reports |
| `apps/server` | The Node entry point: API, static app, media worker pump, maintenance sweeps |
| `apps/worker` | The Linux Docker media worker |
| `apps/cf` | The Cloudflare Workers entry point with D1 and R2 |
| `qa` | Media verification harness (WebCodecs ground truth, color QC, tmcd) |
| `deploy` | docker-compose and reverse-proxy examples |

The REST API is a public contract. The OpenAPI document is generated from the routes and committed at `packages/api/openapi.json`.

## License

Onelight is free software licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See `LICENSE`.

The AGPL is deliberate. If you run a modified Onelight as a network service, you must offer your users the corresponding source of your modified version. That keeps the tool and its improvements open for everyone.

Copyright (C) 2026 David Torcivia and Onelight contributors.
