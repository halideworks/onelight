# Configuration

Generated from `packages/core/src/config-manifest.ts` by `pnpm config:gen`.
Edit the manifest, not this file.

Every variable below is passed to the container by `deploy/docker-compose.yml`,
or is noted as deliberately not passed. A setting that reaches neither is a CI
failure: `pnpm config:check` compares this manifest against the compose files.

Values are validated at startup. A malformed number or an unknown enum value
stops the server with a message naming the variable, rather than falling back
to a default nobody asked for.

## Core

| Variable | Container | Default | Notes |
|---|---|---|---|
| `PUBLIC_URL` | server | required | Public origin users reach the app at. Drives absolute URLs and the COOKIE_SECURE default. |
| `SECRET_KEY` | server | required | Session and signing key. At least 32 random characters. Credential: never shown in the admin view. |
| `DATABASE_PATH` | server | `/data/onelight.db` | SQLite database file. Absolute in production. Relative paths resolve against the working directory and move when it does. In docker this must live on the volume the worker also mounts. |
| `BLOB_ROOT` | server | a "blobs" directory beside DATABASE_PATH | Blob storage root for originals, renditions, and exports. DATABASE_PATH and BLOB_ROOT must resolve to the same filesystem the worker mounts, or the worker cannot read sources and write renditions. |

## Network and proxying

| Variable | Container | Default | Notes |
|---|---|---|---|
| `PORT` | server, worker | `3000` | Listen port. The worker defaults to 8080. |
| `HOST` | server | `0.0.0.0` | Listen address. Not passed by compose: the container must listen on all interfaces; binding it elsewhere only makes the service unreachable from the port mapping. |
| `COOKIE_SECURE` | server | true when PUBLIC_URL is https, false otherwise | Force the secure flag on session cookies. |
| `TRUST_PROXY` | server | `false` | Take client IPs from X-Forwarded-For. Set this behind a reverse proxy. With this off, every request behind a proxy carries the proxy's address, so per-IP rate limits collapse into one bucket for the whole internet. |
| `ONELIGHT_ALLOWED_ORIGINS` | server | unset | Extra origins the CSRF check accepts, comma separated. PUBLIC_URL's own origin is always allowed. Cookie-carried mutations (login included) are rejected unless the request's Origin matches, so reaching a deployment by any name PUBLIC_URL does not carry -- the LAN address while public DNS is still pending, a tailnet host, a second domain -- fails with "The request origin is not allowed." and looks like a broken login rather than a configuration problem. This widens the CSRF rule and nothing else: list exact origins you trust, never a wildcard. An unparseable entry fails at startup, not at request time. |

## First run

Startup fails: ONELIGHT_ADMIN_EMAIL and ONELIGHT_ADMIN_PASSWORD must be set together, or first-run setup creates no admin.

| Variable | Container | Default | Notes |
|---|---|---|---|
| `ONELIGHT_WORKSPACE_NAME` | server | `Onelight` | Name given to the workspace created on first run. |
| `ONELIGHT_ADMIN_EMAIL` | server | unset | Headless first-run admin address. When this and ONELIGHT_ADMIN_PASSWORD are both set and the database has no users, this admin account and workspace are created at startup. On Workers, /setup is the only path. |
| `ONELIGHT_ADMIN_PASSWORD` | server | unset | Headless first-run admin password. Never printed. Credential: never shown in the admin view. |

## Single sign-on

Startup fails: OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must be set together.

| Variable | Container | Default | Notes |
|---|---|---|---|
| `OIDC_ISSUER` | server | unset | OIDC provider issuer URL. |
| `OIDC_CLIENT_ID` | server | unset | OIDC client id. |
| `OIDC_CLIENT_SECRET` | server | unset | OIDC client secret. Credential: never shown in the admin view. |
| `OIDC_AUTO_PROVISION` | server | `false` | Create users on their first OIDC login. |
| `OIDC_ALLOWED_DOMAINS` | server | unset | Email domains permitted to provision, comma separated. Empty means any. |

## Media worker

Startup fails: WORKER_URL and WORKER_SECRET must be set together, or media processing stays disabled and probe/transcode jobs sit queued.

| Variable | Container | Default | Notes |
|---|---|---|---|
| `WORKER_URL` | server | unset, which disables media processing | Where the media worker listens. This and WORKER_SECRET must both be set or media processing is disabled and probe/transcode jobs stay queued. |
| `WORKER_SECRET` | server, worker | unset | Signs the job protocol in both directions. Credential: never shown in the admin view. |
| `WORKER_JOB_TIMEOUT_MS` | server | `21600000` | Ceiling for one worker job (probe or transcode). The pump heartbeats the job lease while it waits, so long encodes do not expire mid-run. |
| `WORK_ROOT` | worker | `/data/work` | Scratch directory for in-flight jobs. Not passed by compose: the image pins its own scratch directory; P0-5 moves this to a bounded tmpfs. |

## Media queue

| Variable | Container | Default | Notes |
|---|---|---|---|
| `MEDIA_CONCURRENCY` | server | the CPU count minus 2, at least 1 | How many media jobs the pump runs at once. Encodes are the heaviest thing the box does and the site shares its cores, so the default leaves two alone. A dedicated worker box can raise it; 1 restores serial behaviour. |
| `WATERMARK_SWEEP_LIMIT` | server | `8` | Burned-watermark jobs enqueued per reconciliation sweep. The pump scans every 30 seconds for shares whose watermark spec lacks a rendition. The sweep is bounded so a large backlog drains across passes instead of stalling the queue. |

## Hardware encoding

| Variable | Container | Default | Notes |
|---|---|---|---|
| `ONELIGHT_HWACCEL` | worker | `auto` | Hardware encoding backend. auto probes usable backends and falls back to libx264. vaapi covers Intel Quick Sync, Intel Arc, and AMD on Linux; nvenc covers NVIDIA; amf covers AMD on Windows; software is libx264. Explicit GPU modes are strict. The worker performs a real one-frame encode before listening and refuses to start if the requested device, driver, or rate-control mode is unusable, so production cannot silently fall to CPU. One of: auto, vaapi, nvenc, amf, software, none. |
| `ONELIGHT_VAAPI_DEVICE` | worker | unset | VAAPI render node. |
| `ONELIGHT_VAAPI_LOW_POWER` | worker | `true` | Use the VAAPI low-power encode path. |
| `ONELIGHT_NVENC_DEVICE` | worker | `0` | NVENC device index. |
| `ONELIGHT_SOFTWARE_AV1` | worker | `true` | Encode the AV1 HDR rendition in software where the GPU cannot. It runs at the lowest priority so it yields to anything the site is doing. Turning it off trades cores for a feature: AV1 is the only HDR codec Chrome decodes in software, and only a software decoder returns frames the reference renderer can read, so without this rendition reference HDR is unavailable in Chrome no matter what else is present. |

## Outgoing email

Note: Set MAIL_FROM together with either SMTP_URL or SMTP_HOST, or email stays disabled.

| Variable | Container | Default | Notes |
|---|---|---|---|
| `SMTP_URL` | server | unset | Single-string SMTP connection, the alternative to the discrete settings. Email is disabled unless SMTP_URL or SMTP_HOST is set together with MAIL_FROM. Admin mail settings, where present, take precedence over all of these. Credential: never shown in the admin view. |
| `SMTP_HOST` | server | unset | SMTP server hostname. |
| `SMTP_PORT` | server | `587` | SMTP server port. |
| `SMTP_USER` | server | unset | SMTP username. |
| `SMTP_PASS` | server | unset | SMTP password. Credential: never shown in the admin view. |
| `SMTP_SECURE` | server | true on port 465, false otherwise | Connect with implicit TLS. |
| `MAIL_FROM` | server | unset | From address on outgoing mail. |

## Backups

Startup fails: BACKUP_INTERVAL_MS and BACKUP_KEEP do nothing without BACKUP_DIR: backups are off.

| Variable | Container | Default | Notes |
|---|---|---|---|
| `BACKUP_DIR` | server | unset | Where periodic database snapshots are written. Backups are off when unset. A filesystem copy of a live SQLite file can catch a write mid-flight; the engine's online backup API cannot. Each snapshot carries a manifest of the blob keys it references, which is also what stops the blob GC deleting a blob a retained snapshot still needs. See docs/BACKUPS.md for restore. |
| `BACKUP_INTERVAL_MS` | server | `21600000` | How often a snapshot is taken. |
| `BACKUP_KEEP` | server | `28` | Snapshots retained before the oldest is pruned. |

## Retention and cleanup

| Variable | Container | Default | Notes |
|---|---|---|---|
| `UPLOAD_REAP_AFTER_MS` | server | `604800000` | Age at which a stale upload session is reaped. Pending, uploading, quarantined and aborted sessions age from creation; completed sessions age from completion. Multipart state is aborted, part rows and the session are deleted, and partial blobs are removed. |
| `TRASH_PURGE_AFTER_MS` | server | `2592000000` | Age at which soft-deleted assets and versions are purged for good. Blobs deleted, rows removed, one audit row per purge. |
| `ONELIGHT_GC_DELETE` | server | `false` | Let the blob GC delete orphans instead of only reporting them. Without this the server only ever REPORTS orphaned objects: every thumbnail, proxy and watermarked render belonging to a deleted asset, share or project stays on disk forever. Even with it on, only orphans older than 24 hours are deleted. |
| `GC_INTERVAL_MS` | server | `86400000` | Minimum time between blob GC reconciliation passes. |

## External tools

| Variable | Container | Default | Notes |
|---|---|---|---|
| `FFMPEG_PATH` | worker | `ffmpeg` | ffmpeg binary. Not passed by compose: the image ships its own toolchain on PATH. |
| `FFPROBE_PATH` | worker | `ffprobe` | ffprobe binary. Not passed by compose: the image ships its own toolchain on PATH. |
| `PDFTOPPM_PATH` | worker | `pdftoppm` | Poppler pdftoppm binary, for PDF page rasterisation. Not passed by compose: the image ships its own toolchain on PATH. |
| `DCRAW_PATH` | worker | `dcraw_emu` | LibRaw dcraw_emu binary, for camera raw stills. Not passed by compose: the image ships its own toolchain on PATH. |
| `HEIF_DEC_PATH` | worker | `heif-dec` | libheif decoder binary, for HEIC/HEIF stills. Not passed by compose: the image ships its own toolchain on PATH. |
| `HEIF_ENC_PATH` | worker | `heif-enc` | libheif encoder binary. Not passed by compose: the image ships its own toolchain on PATH. |

## Checking what is actually in effect

An administrator can read the resolved configuration at
`GET /api/v1/admin/system/config`, or on the admin system page. It reports each
subsystem as active or inactive with the reason, and each variable as set or
defaulted. Secrets report only whether they are set.
