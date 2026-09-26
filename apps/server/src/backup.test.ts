import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyNodeMigrations,
  createNodeDb,
  users,
  workspaces,
} from "@onelight/db";
import { loadConfig } from "@onelight/core";
import { backupConfigFromConfig, backupOnce } from "./backup.js";
import type { AppDb } from "@onelight/db";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onelight-backup-"));

afterEach(() => {
  for (const name of fs.readdirSync(tmp))
    fs.rmSync(path.join(tmp, name), { force: true, recursive: true });
});

/* A migrated in-memory DB with one blob-bearing row (an avatar), so the
   manifest has something to list. */
const seededDb = async (
  file: string,
): Promise<{ db: AppDb; sqlite: Database.Database }> => {
  const { db, sqlite } = createNodeDb(file);
  applyNodeMigrations(sqlite);
  await db
    .insert(workspaces)
    .values({ id: "ws-1", name: "Studio", createdAt: 1_000 })
    .run();
  await db
    .insert(users)
    .values({
      id: "user-1",
      workspaceId: "ws-1",
      email: "a@example.com",
      name: "A",
      role: "admin",
      avatarKey: "avatars/user-1.jpg",
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    .run();
  return { db, sqlite };
};

describe("backups", () => {
  it("is off without BACKUP_DIR and reads the knobs when set", () => {
    const env = {
      PUBLIC_URL: "https://x.test",
      SECRET_KEY: "0123456789abcdef0123456789abcdef",
    };
    expect(backupConfigFromConfig(loadConfig(env))).toBeNull();
    expect(
      backupConfigFromConfig(
        loadConfig({
          ...env,
          BACKUP_DIR: "/b",
          BACKUP_INTERVAL_MS: "60000",
          BACKUP_KEEP: "3",
        }),
      ),
    ).toEqual({ dir: "/b", intervalMs: 60000, keep: 3 });
  });

  /* An interval or retention count without a directory is a backup schedule
     that never runs, which is the failure mode nobody notices until they need
     a restore. */
  it("refuses backup knobs set without a directory", () => {
    expect(() =>
      loadConfig({
        PUBLIC_URL: "https://x.test",
        SECRET_KEY: "0123456789abcdef0123456789abcdef",
        BACKUP_KEEP: "3",
      }),
    ).toThrow(/BACKUP_DIR/);
  });

  it("writes a consistent snapshot and a manifest of its referenced blobs", async () => {
    const { sqlite } = await seededDb(path.join(tmp, "live.db"));
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
      const result = await backup(...args);
      sqlite.exec("UPDATE users SET avatar_key = NULL");
      return result;
    });
    const out = path.join(tmp, "out");
    const file = await backupOnce(
      sqlite,
      { dir: out, intervalMs: 1, keep: 5 },
      new Date(2026, 6, 16, 12, 0, 0),
    );
    sqlite.close();
    // The restore path is the point of a backup: the copy opens and reads.
    const copy = new Database(file, { readonly: true });
    const row = copy.prepare("SELECT avatar_key FROM users").get() as {
      avatar_key: string;
    };
    copy.close();
    expect(row.avatar_key).toBe("avatars/user-1.jpg");
    expect(path.basename(file)).toBe("onelight-20260716-120000.db");
    // The manifest lists exactly the blobs the snapshot references, so a
    // restore can verify they still exist and the GC can protect them.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(out, "onelight-20260716-120000.manifest.json"),
        "utf8",
      ),
    ) as { blob_keys: string[] };
    expect(manifest.blob_keys).toContain("avatars/user-1.jpg");
  });

  it("prunes the oldest beyond keep, db and manifest as a pair", async () => {
    const { sqlite } = await seededDb(path.join(tmp, "live2.db"));
    const dir = path.join(tmp, "retain");
    for (let hour = 0; hour < 5; hour += 1)
      await backupOnce(
        sqlite,
        { dir, intervalMs: 1, keep: 2 },
        new Date(2026, 6, 16, hour, 0, 0),
      );
    sqlite.close();
    const kept = fs.readdirSync(dir).sort();
    expect(kept).toEqual([
      "onelight-20260716-030000.db",
      "onelight-20260716-030000.manifest.json",
      "onelight-20260716-040000.db",
      "onelight-20260716-040000.manifest.json",
    ]);
  });

  it("keeps the premigrate series separate from the timed one", async () => {
    const { sqlite } = await seededDb(path.join(tmp, "live3.db"));
    const dir = path.join(tmp, "mixed");
    await backupOnce(
      sqlite,
      { dir, intervalMs: 1, keep: 2 },
      new Date(2026, 6, 16, 1, 0, 0),
    );
    await backupOnce(
      sqlite,
      { dir, intervalMs: 1, keep: 2 },
      new Date(2026, 6, 16, 2, 0, 0),
      { label: "premigrate", keep: 5 },
    );
    sqlite.close();
    const names = fs.readdirSync(dir).sort();
    // The premigrate snapshot does not count against the timed keep, and vice
    // versa: both survive.
    expect(names).toContain("onelight-20260716-010000.db");
    expect(names).toContain("onelight-premigrate-20260716-020000.db");
  });

  it("backs up fresh and old schemas before migrations exist", async () => {
    const sqlite = new Database(path.join(tmp, "legacy.db"));
    const config = {
      dir: path.join(tmp, "legacy-backups"),
      intervalMs: 1,
      keep: 5,
    };
    try {
      await backupOnce(sqlite, config, new Date(2026, 6, 16, 1));
      sqlite.exec(
        "CREATE TABLE asset_versions (original_blob_key TEXT); INSERT INTO asset_versions VALUES ('originals/legacy.mov')",
      );
      const file = await backupOnce(sqlite, config, new Date(2026, 6, 16, 2));
      const manifest = JSON.parse(
        fs.readFileSync(file.replace(/\.db$/, ".manifest.json"), "utf8"),
      ) as { blob_keys: string[] };
      expect(manifest.blob_keys).toEqual(["originals/legacy.mov"]);
    } finally {
      sqlite.close();
    }
  });
});
