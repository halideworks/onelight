# API layout

`src/app.ts` assembles the API. It owns global middleware, error handling,
application-scoped operations, route registration, and legacy forwarding.

## Where changes belong

- `routes/`: HTTP handlers grouped by domain. Keep helpers used by just one
  domain beside its handlers. Registrars receive the router, platform environment,
  and named operation dependencies. Route modules do not import each other.
- `operation/`: shared workflows used across domains. `access` owns resource
  lookup and authorization; `activity` owns audit, project events, and
  notifications; `uploads` owns the common multipart and asset-attachment engine;
  `comments` owns attachments and carry-forward. `media` signs and authorizes
  media URLs; `blobs` serves streams and archives. Share access and projections,
  project projections, identity, and mail have their own cohesive modules.
- `wire.ts`: pure response projections. Public share/comment projections are
  deliberately distinct from member projections. Never return raw database rows.
- `schemas.ts`: request validation and response documentation. OpenAPI is built
  from actual registered routes in `routes/openapi.ts`, sorted for stable output.
- `contract/domains/`: behavioral API coverage. Keep cross-route workflows here;
  `app.test.ts` also checks application isolation and legacy routing.

## Rules when adding or moving a route

Register every API domain before `root.route("/api/v1", api)`: mounting copies
the routes registered so far. Keep global middleware in request ID, logging,
authentication, origin-validation order. Both routers need their error handlers.

The explicit legacy root share page returns all assets; its API counterpart is
paginated. Do not collapse these two handlers. Legacy routes must precede the
`/s/*` fallback, which forwards the runtime bindings for client-IP resolution.

Create shared operations once per application and pass that same instance to
every consumer. Event waiters, ZIP CRC cache, decoy password hash, media signing
key, and OpenAPI cache must never become module-global state. Pure projections
and constants can live at module scope. Both Node and Cloudflare use this API;
platform capabilities come from `AppEnv`, not platform-specific imports.

Run the repository's required gates before landing changes. API changes also
require `pnpm openapi:gen` and `pnpm openapi:check`; generated files are not edited
by hand. A module split must preserve authorization, wire shapes, side effects,
and error behavior, not merely the endpoint inventory.
