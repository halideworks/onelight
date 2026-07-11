# Onelight

Onelight is a self-hosted, open-source media review and approval tool for post-production.
It stores originals, creates review proxies, collects frame-accurate notes, and exports those notes back to the NLE.

The v1 implementation covers Phases 0 through 3 in `onelight_design_doc.md`.
Phase 0 is specified in `specs/phase-0.md` and is executed in task order.

## Development

Requirements: Node 22 or newer and pnpm 9.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm dev
```

The local development server uses `http://localhost:3000`.
Set `SECRET_KEY` to a random value of at least 32 characters before starting the server.

## Docker

```sh
docker compose -f deploy/docker-compose.yml up --build
```

Compose supplies a development-only secret when one is not provided.
Production deployments must set an explicit `SECRET_KEY` and terminate TLS at a reverse proxy.

## License

Onelight is licensed under AGPL-3.0-only.
