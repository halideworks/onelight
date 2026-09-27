import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createNodeDb } from "./client.js";

it("atomic writes chain success, stop on a stale guard, and roll back a late failure", async () => {
  const { db, sqlite } = createNodeDb(":memory:");
  try {
    sqlite.exec(
      "CREATE TABLE atomic_check (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
    );
    const write = (expected: number) =>
      db.atomic([
        sql`INSERT INTO atomic_check SELECT 1, 10 WHERE ${expected} = 1 RETURNING id`,
        sql`INSERT INTO atomic_check SELECT 2, 20 WHERE changes() = 1 RETURNING id`,
        sql`UPDATE atomic_check SET value = 30 WHERE id = 1 AND changes() = 1 RETURNING value`,
      ]);
    expect(await write(0)).toEqual([[], [], []]);
    expect(await write(1)).toEqual([[{ id: 1 }], [{ id: 2 }], [{ value: 30 }]]);
    await expect(
      db.atomic([
        sql`UPDATE atomic_check SET value = 99 WHERE id = 1 RETURNING value`,
        sql`INSERT INTO atomic_check VALUES (2, 50)`,
      ]),
    ).rejects.toThrow();
    expect(
      sqlite.prepare("SELECT value FROM atomic_check WHERE id = 1").get(),
    ).toEqual({ value: 30 });
    expect(await db.atomic([])).toEqual([]);
  } finally {
    sqlite.close();
  }
});
