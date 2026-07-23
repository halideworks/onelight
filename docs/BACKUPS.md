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

**Blob manifest.** Beside every snapshot the server writes
`onelight-YYYYMMDD-HHMMSS.manifest.json`, listing every blob key that snapshot
references. The blobs are *not* copied into the backup (they are large and
carried separately, below) but the manifest makes a restore verifiable - you
can check the blob tree still holds everything the database needs - and the
blob GC reads these manifests so it never deletes a blob any retained snapshot
still references. So the automated sweep can never delete media out from under
a snapshot you might restore.

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
that is gone, and those versions will need re-uploading. Read the snapshot's
`.manifest.json` to see exactly which blob keys it needs, and check them
against the blob tree before you cut over - a missing key there is a version
that will not play.

Do **not** run the destructive GC (`ONELIGHT_GC_DELETE=true`) against a
freshly restored *older* database while a *newer* blob tree is present: from
the old database's point of view the newer blobs are orphans, and it would
delete them. Let the state settle (or restore a matching blob tree) first.

## Rolling back a deploy that changed the schema

SQLite migrations that rebuild a table or backfill data cannot be reversed by a
down-migration, so the rollback path is the snapshot. When a deploy has pending
migrations and `BACKUP_DIR` is set, the server takes a labelled snapshot
(`onelight-premigrate-YYYYMMDD-HHMMSS.db`, kept 10 deep, pruned separately from
the timed series) *before* it applies them. To roll back:

1. Stop the server.
2. Copy the `onelight-premigrate-*.db` taken just before the bad deploy over
   `DATABASE_PATH` (delete the `-wal`/`-shm` beside it).
3. Redeploy the *previous* image - an older binary must not run against a
   newer schema, and vice versa.
4. Start it. The pre-migration snapshot matches the old binary's schema, so it
   comes up clean.

## The nyx install

`BACKUP_DIR=/data/backups` (set in `deploy/docker-compose.nyx.yml`) puts
snapshots on the fast tier next to the live database; the host's
`fast-replica.timer` carries all of `@data` to `/mnt/raid/snapshots` hourly,
which is what puts the snapshots on the redundant tier. Blobs already live on
the RAID (`/mnt/raid/media/onelight`). Off-box copies (B2/R2) are the
operator's step above.
