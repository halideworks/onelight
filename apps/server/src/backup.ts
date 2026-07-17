/* Consistent database snapshots on a timer.
 *
 * A filesystem copy of a live SQLite file can catch a write mid-flight; the
 * engine's online backup API cannot. This writes point-in-time copies into
 * BACKUP_DIR and prunes the oldest beyond BACKUP_KEEP, so whatever carries
 * that directory off the box (a replica timer, rclone to B2/R2, anything)
 * always has a consistent file to carry. See docs/BACKUPS.md for restore.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

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

/* One snapshot plus retention. Exported on its own so a test (or an operator
   with a REPL) can take a backup without waiting for the timer. */
export const backupOnce = async (
  sqlite: Database.Database,
  config: BackupConfig,
  now: Date,
): Promise<string> => {
  fs.mkdirSync(config.dir, { recursive: true });
  const file = path.join(config.dir, `onelight-${stamp(now)}.db`);
  await sqlite.backup(file);
  const entries = fs
    .readdirSync(config.dir)
    .filter((name) => /^onelight-\d{8}-\d{6}\.db$/.test(name))
    .sort();
  for (const name of entries.slice(
    0,
    Math.max(0, entries.length - config.keep),
  ))
    fs.rmSync(path.join(config.dir, name), { force: true });
  return file;
};

export const startBackups = (
  sqlite: Database.Database,
  config: BackupConfig,
): (() => void) => {
  let active = false;
  const tick = async (): Promise<void> => {
    if (active) return;
    active = true;
    try {
      const file = await backupOnce(sqlite, config, new Date());
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
