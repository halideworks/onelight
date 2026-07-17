# Backups and restore

## What gets backed up, and how

Two things hold everything: the SQLite database (all metadata, comments,
shares, users) and the blob tree (originals, renditions, exports, avatars,
logos, attachments).

**Database.** Set `BACKUP_DIR` and the server writes a consistent snapshot
there every `BACKUP_INTERVAL_MS` (default 6 hours), keeping the newest
`BACKUP_KEEP` (default 28). Snapshots use SQLite's online backup API, so they
are point-in-time consistent even under writes - which a plain file copy of a
live database is not. Files are named `onelight-YYYYMMDD-HHMMSS.db`.

**Blobs.** The blob tree is ordinary files, safe to copy live: objects are
written once and never modified in place. Carry it with whatever you trust -
`rsync` to another host, `rclone sync` to B2/R2, a filesystem replica.

```
rclone sync /path/to/blobs remote:onelight-blobs
rclone sync /path/to/backups remote:onelight-db-backups
```

## Restore

1. Stop the server.
2. Copy the chosen snapshot over `DATABASE_PATH` (and delete any `-wal` and
   `-shm` files sitting next to it).
3. Restore the blob tree to `BLOB_ROOT`.
4. Start the server. Migrations re-apply idempotently; a blob GC report will
   note anything the database references that the blob restore missed.

The database and blobs should be restored from the same point in time where
possible. A newer blob tree against an older database is safe (unreferenced
objects are reported by GC); the reverse means the database references media
that is gone, and those versions will need re-uploading.

## The nyx install

`BACKUP_DIR=/data/backups` (set in `deploy/docker-compose.nyx.yml`) puts
snapshots on the fast tier next to the live database; the host's
`fast-replica.timer` carries all of `@data` to `/mnt/raid/snapshots` hourly,
which is what puts the snapshots on the redundant tier. Blobs already live on
the RAID (`/mnt/raid/media/onelight`). Off-box copies (B2/R2) are the
operator's step above.
