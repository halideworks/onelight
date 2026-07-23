/* Consistent database snapshots on a timer.
 *
 * A filesystem copy of a live SQLite file can catch a write mid-flight; the
 * engine's online backup API cannot. This writes point-in-time copies into
 * BACKUP_DIR and prunes the oldest beyond BACKUP_KEEP, so whatever carries
 * that directory off the box (a replica timer, rclone to B2/R2, anything)
 * always has a consistent file to carry. See docs/BACKUPS.md for restore.
 *
 * Beside every .db snapshot it writes a .manifest.json listing the blob keys
 * that snapshot references. The blobs themselves are NOT copied here -- they
 * are large and the operator carries the blob directory off-box on its own
 * timer -- but the manifest makes a restore verifiable (does the blob tree
 * still hold everything this DB needs?) and lets the blob GC protect any blob a
 * retained backup still references, so the background sweep can never delete a
 * blob out from under a snapshot you might restore.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AppDb } from "@onelight/db";
import { referencedBlobKeys } from "./maintenance.js";
import type { BackupManifest } from "./maintenance.js";

export interface BackupConfig {
  dir: string;
  intervalMs: number;
  keep: number;
}

export const backupConfigFromEnv = (
  env: Record<string, string | undefined>,
): BackupConfig | null => {
  const dir = (env.BACKUP_DIR ?? "").trim();
  if (!dir) return null;
  const positive = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    dir,
    intervalMs: positive(env.BACKUP_INTERVAL_MS, 6 * 60 * 60_000),
    keep: positive(env.BACKUP_KEEP, 28),
  };
};

const stamp = (at: Date): string =>
  [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
    "-",
    String(at.getHours()).padStart(2, "0"),
    String(at.getMinutes()).padStart(2, "0"),
    String(at.getSeconds()).padStart(2, "0"),
  ].join("");

/* The stem shared by a snapshot and its manifest, so the two travel and prune
   together. A label (e.g. "premigrate") tags snapshots taken for a reason
   other than the timer; timed snapshots use none. */
const snapshotStem = (label: string | undefined, at: Date): string =>
  label ? `onelight-${label}-${stamp(at)}` : `onelight-${stamp(at)}`;

/* One snapshot plus retention. Exported on its own so a test (or an operator
   with a REPL) can take a backup without waiting for the timer. Returns the
   .db path. `label`/`keep` let the pre-migration snapshot use its own prefix
   and retention without disturbing the timed series. */
export const backupOnce = async (
  sqlite: Database.Database,
  db: AppDb,
  config: BackupConfig,
  now: Date,
  options: { label?: string; keep?: number } = {},
): Promise<string> => {
  fs.mkdirSync(config.dir, { recursive: true });
  const stem = snapshotStem(options.label, now);
  const file = path.join(config.dir, `${stem}.db`);
  await sqlite.backup(file);
  /* The manifest is written AFTER the DB snapshot from the SAME live db. A blob
     referenced by the snapshot but created between the two reads is at worst
     over-protected (listed though the snapshot's DB may not name it) -- never
     under-protected, which is the direction that loses data. */
  const referenced = [...(await referencedBlobKeys(db))].sort();
  const manifest: BackupManifest = {
    created_at: now.toISOString(),
    blob_keys: referenced,
  };
  fs.writeFileSync(
    path.join(config.dir, `${stem}.manifest.json`),
    JSON.stringify(manifest),
  );
  /* Prune the oldest of THIS series, db + manifest as a pair. The premigrate
     series (its own prefix) prunes independently of the timed one, so a burst
     of deploys never evicts the day's ordinary snapshots. */
  const pattern = options.label
    ? new RegExp(`^onelight-${options.label}-\\d{8}-\\d{6}\\.db$`)
    : /^onelight-\d{8}-\d{6}\.db$/;
  const keep = options.keep ?? config.keep;
  const snapshots = fs
    .readdirSync(config.dir)
    .filter((name) => pattern.test(name))
    .sort();
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    fs.rmSync(path.join(config.dir, name), { force: true });
    fs.rmSync(path.join(config.dir, name.replace(/\.db$/, ".manifest.json")), {
      force: true,
    });
  }
  return file;
};

export const startBackups = (
  sqlite: Database.Database,
  db: AppDb,
  config: BackupConfig,
): (() => void) => {
  let active = false;
  const tick = async (): Promise<void> => {
    if (active) return;
    active = true;
    try {
      const file = await backupOnce(sqlite, db, config, new Date());
      const size = fs.statSync(file).size;
      console.log(`[onelight] backup: ${file} (${String(size)} bytes)`);
    } catch (error) {
      console.warn(
        `[onelight] backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, config.intervalMs);
  void tick();
  return () => clearInterval(timer);
};
