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

## Housekeeping that runs itself

- Upload-session reaping, trash purge, and rate-limit pruning run on the
  maintenance timer.
- Blob GC reports orphans daily as a dry run; set `ONELIGHT_GC_DELETE=true`
  to delete orphans older than 24 hours.
