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
  and burn on use.
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
