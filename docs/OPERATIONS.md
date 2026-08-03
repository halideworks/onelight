# Operating an install

## Watching it

- **Liveness**: `GET /healthz` returns `{"status":"ok","version":...}` with no
  auth. Point uptime monitors here.
- **The system page**: Settings > System (admin) shows version, uptime,
  database size, backup snapshot state, media volume capacity, and the depth
  of every queue (media jobs, exports, webhook deliveries), refreshed every
  15 seconds. Failed or dead rows mark the card. The same numbers are at
  `GET /api/v1/admin/system` for scripts.
- **Logs** go to stdout: backups, blob GC reports, worker pump failures, and
  webhook delivery problems are all one `docker logs` away.
- **Playback diagnostics** are automatic. Search stdout for
  `[onelight-playback-diagnostic]` when a reviewer reports silent L shuttle.
  Each JSON record identifies the project version or share asset, browser and
  platform, requested rate, main and sidecar media states, volume and mute
  state, page visibility, and the exact fallback reason. Both successful
  sidecar startup and clock advance are recorded, so the last successful stage
  is visible remotely. Comment text, email addresses, cookies, and signed media
  URLs are never included. Reports are limited to 12 per reviewer and media
  item per five minutes.

## What it needs to run whole

- **The media worker** (`WORKER_URL` + `WORKER_SECRET`): probe, transcode,
  filmstrips, waveforms, watermarking, PDF frame stills. Without it uploads
  stay queued and the log says so once at boot. Comment exports run either
  way; they are database-to-file work.
- **Email** (`SMTP_URL` or `SMTP_HOST` + `MAIL_FROM`): password resets and
  notification digests. Off means those emails silently do not exist, not a
  broken install.
- **Backups** (`BACKUP_DIR`, optional `BACKUP_INTERVAL_MS`, `BACKUP_KEEP`):
  consistent database snapshots. Restore steps are in docs/BACKUPS.md. The
  system page warns when backups are off and calls a newest snapshot older
  than a day stale.

## Hardware encoding

The review ladder, burned watermarks, supported source decoding, and 10-bit HDR
rails use the selected hardware backend where that vendor exposes the required
format. The portable base stack uses `ONELIGHT_HWACCEL=auto` and falls back to
libx264 only when no probe succeeds. Set an explicit backend in production so
a missing driver or inaccessible device stops the worker instead of quietly
consuming CPU.

Intel integrated graphics and Intel Arc use the same Quick Sync media engine
through VAAPI on Linux:

```sh
export ONELIGHT_RENDER_GID="$(getent group render | cut -d: -f3)"
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.gpu-intel.yml up -d --build
```

NVIDIA requires the host driver and NVIDIA Container Toolkit:

```sh
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.gpu-nvidia.yml up -d --build
```

AMD on Linux uses the VAAPI override and Mesa driver:

```sh
export ONELIGHT_RENDER_GID="$(getent group render | cut -d: -f3)"
docker compose -f deploy/docker-compose.yml \
  -f deploy/docker-compose.gpu-amd.yml up -d --build
```

For a native Windows worker, use `ONELIGHT_HWACCEL=nvenc` for NVIDIA or
`ONELIGHT_HWACCEL=amf` for AMD. `auto` tries both in that order. Verify the
active selection without reading local logs:

```sh
curl http://127.0.0.1:8080/healthz
```

The `hardware_acceleration` field identifies the backend and device. Intel
probing tries QVBR first, then the driver-supported VBR or CQP fallback. A
failure after startup retries that individual rendition in software so a
driver reset does not lose the entire asset. VAAPI and NVENC encode AV1 and
HEVC Main10 HDR rails when the GPU supports them. AMF's current 8-bit-only HDR
inputs stay on the software recipe to preserve correctness.

Where the GPU cannot encode AV1 — everything before Intel Arc and NVIDIA Ada —
the AV1 HDR rendition is encoded in software rather than skipped, at a cheap
preset and at the lowest scheduling priority. The priority is what protects a
box that also serves the site: capping encoder parallelism does not bound the
process, since the decode and filter threads are not the encoder's to cap
(measured on a 4K HDR master, `lp=2` still averaged 3.3 of four cores), while
niceness costs nothing on an idle machine and yields immediately on a busy
one. Nothing waits on this rendition — the asset is ready and playing off its
proxies long before it finishes. It is not a compression
optimisation: Chrome decodes HEVC only in hardware, hardware decoders return
frames whose planes cannot be read back, and AV1 is the only HDR codec Chrome
will decode in software. Without this rendition an asset simply has no HDR
that reference playback can open in Chrome. `ONELIGHT_SOFTWARE_AV1=0` trades
that feature back for the cores.

## Hooks

Onelight generates what it can from the media itself and leaves the rest as
open endpoints for a deployment to fill. **Captioning** is the first such
hook: pipe a version through whatever ASR you run and PUT the WebVTT back,
one track per language, replace on re-put:

```
curl -X PUT "$BASE/api/v1/versions/$VERSION/captions?language=en&label=English" \
  -H "content-type: text/vtt" \
  -H "authorization: Bearer $TOKEN" \
  --data-binary @captions.vtt
```

The player grows a captions toggle wherever a track exists, in the review
room and on shares alike. `DELETE /versions/:id/captions/:language` removes
a track.

## Security posture

- **Two-factor sign-in** is per-user TOTP (RFC 6238): turn it on under
  Settings > Profile, prove a code, save the eight single-use backup codes.
  With it on, the password earns a five-minute challenge instead of a
  session; enrolment and disabling are session-auth only, so an API token
  can never rotate an account's second factor. Secrets sit inactive until a
  code proves the authenticator has them; backup codes are stored hashed
  and burn on use. TOTP gates the password path only: an SSO sign-in
  (OIDC) trusts the identity provider, which is where that account's MFA
  policy belongs. Password reset never issues a session, so recovering a
  password does not skip the second factor.
- **Rate limits** cover login (per email and per IP), the TOTP step, share
  access attempts, and password resets. Failures land in the audit log
  (`user.login_failed`, `user.login_totp_failed`).
- **Response headers**: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin` (share slugs never leak through outbound
  links), `X-Frame-Options: SAMEORIGIN`.
- **TLS** is the reverse proxy's job; put one in front for anything beyond
  a LAN test install. Session cookies are HttpOnly and SameSite=Lax;
  mutations require a same-origin Origin header.

## Housekeeping that runs itself

- Upload-session reaping, trash purge, and rate-limit pruning run on the
  maintenance timer.
- Blob GC reports orphans daily as a dry run; set `ONELIGHT_GC_DELETE=true`
  to delete orphans older than 24 hours.

## Getting files off the disk

Originals live in blob storage under content-addressed paths that are not
meant to be browsed. To move a project's files onto a NAS, DAS, or archive
volume, use the bundled offload command inside the server container, with
the destination bind-mounted:

```
docker compose -p onelight exec onelight \
  node apps/server/dist/cli.js offload --project "Spot 30s" --dest /mnt/archive
```

It rebuilds the project's folder tree with original filenames, copies every
live version, verifies each copy against the stored CRC32C, and writes an
onelight-manifest.json beside the files. Re-running skips files already
present and verified, so an interrupted offload resumes. Add
`--transfer <slug>` to offload only what one request link received.

On the Workers deployment the equivalent is rclone against the R2 bucket;
the database maps blob keys to filenames, but bulk archive from R2 is a
bucket-level concern and rclone owns it well.

## The media worker's sandbox

The worker opens files nobody vetted: every asset an outside reviewer uploads
is parsed by ffmpeg, Poppler, LibRaw and libheif. The base compose file runs it
with a read-only root filesystem, every Linux capability dropped,
`no-new-privileges`, a bounded tmpfs for scratch, and caps on memory, processes
and open files. Core dumps are disabled, so a crash on a stranger's file cannot
write that file's decoded contents to disk.

Two of those are worth knowing about before something surprises you:

- `mem_limit` (default 6g, override `ONELIGHT_WORKER_MEMORY`). An encode that
  exceeds it is killed and the job fails; the host is unaffected. Large HDR or
  4K work is the case that may need it raised.
- `pids_limit` (default 512, override `ONELIGHT_WORKER_PIDS`). ffmpeg is
  thread-hungry, and a very high `MEDIA_CONCURRENCY` on a large box can
  approach it.

`/data` stays writable: it is a volume, and the renditions the server reads are
written there. Only the image itself is read-only.

### GPU encoding under the sandbox

A read-only root filesystem is the part most likely to bother a GPU driver,
because Mesa keeps a shader cache. Intel VAAPI was tested against a real render
node with the whole sandbox applied, in the strict mode that refuses to start
unless a genuine one-frame hardware encode succeeds. It reported
`vaapi:/dev/dri/renderD128:QVBR:low-power`, so hardware encoding works with the
image read-only, every capability dropped, and no new privileges. Device access
comes from `group_add`, which is a group membership rather than a capability,
so dropping capabilities does not touch it.

NVIDIA has NOT been tested this way: there is no NVIDIA hardware on the machine
these changes were made on. The nvenc path has no reason to need capabilities
either, but if `ONELIGHT_HWACCEL=nvenc` refuses to start after an upgrade,
`read_only: true` on the worker is the first thing to try removing, and please
report it.
