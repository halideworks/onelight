import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupConfigFromEnv, backupOnce } from "./backup.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onelight-backup-"));

afterEach(() => {
  for (const name of fs.readdirSync(tmp))
    fs.rmSync(path.join(tmp, name), { force: true, recursive: true });
});

describe("backups", () => {
  it("is off without BACKUP_DIR and reads the knobs when set", () => {
    expect(backupConfigFromEnv({})).toBeNull();
    expect(
      backupConfigFromEnv({
        BACKUP_DIR: "/b",
        BACKUP_INTERVAL_MS: "60000",
        BACKUP_KEEP: "3",
      }),
    ).toEqual({ dir: "/b", intervalMs: 60000, keep: 3 });
  });

  it("writes a consistent, openable snapshot", async () => {
    const source = new Database(path.join(tmp, "live.db"));
    source.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    source.prepare("INSERT INTO notes (body) VALUES (?)").run("keep me");
    const file = await backupOnce(
      source,
      { dir: path.join(tmp, "out"), intervalMs: 1, keep: 5 },
      new Date(2026, 6, 16, 12, 0, 0),
    );
    source.close();
    const copy = new Database(file, { readonly: true });
    const row = copy.prepare("SELECT body FROM notes").get() as {
      body: string;
    };
    copy.close();
    // The restore path is the point of a backup: the copy opens and reads.
    expect(row.body).toBe("keep me");
    expect(path.basename(file)).toBe("onelight-20260716-120000.db");
  });

  it("prunes the oldest beyond keep", async () => {
    const source = new Database(path.join(tmp, "live2.db"));
    source.exec("CREATE TABLE t (x)");
    const dir = path.join(tmp, "retain");
    for (let hour = 0; hour < 5; hour += 1)
      await backupOnce(
        source,
        { dir, intervalMs: 1, keep: 2 },
        new Date(2026, 6, 16, hour, 0, 0),
      );
    source.close();
    const kept = fs.readdirSync(dir).sort();
    expect(kept).toEqual([
      "onelight-20260716-030000.db",
      "onelight-20260716-040000.db",
    ]);
  });
});
