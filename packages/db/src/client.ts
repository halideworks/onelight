import Database from "better-sqlite3";
import { drizzle as drizzleNode } from "drizzle-orm/better-sqlite3";
import type { SQL } from "drizzle-orm";
import { compileSql, type AppDb } from "./atomic.js";
import { schema } from "./schema.js";
export type { AppDb } from "./atomic.js";
export { createD1Db } from "./cf.js";

/**
 * The database handle shared by both runtimes. better-sqlite3 instantiates
 * BaseSQLiteDatabase<"sync", RunResult, ...> and D1 instantiates
 * BaseSQLiteDatabase<"async", D1Result, ...>; widening the result kind to
 * the union and the run result to unknown gives one structural type that
 * both drivers satisfy, so callers await every terminal call (awaiting the
 * sync driver's plain values is a no-op) and never branch per driver.
 */
export const createNodeDb = (
  filename: string,
): { db: AppDb; sqlite: Database.Database } => {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  /* This file is written concurrently by the API, the worker pump,
     maintenance sweeps, backups and the webhook timer. Without busy_timeout a
     colliding write throws SQLITE_BUSY immediately instead of waiting; five
     seconds of retry turns almost every collision into a small pause rather
     than an error. synchronous=NORMAL is the documented safe pairing with WAL
     (durable across app crashes; only a power loss mid-checkpoint is at risk)
     and drops an fsync per commit. The negative cache_size is KiB (~64 MB) and
     mmap maps the file up to 256 MB, both cutting page faults on the
     read-heavy list endpoints; temp_store=MEMORY keeps sorts off disk. */
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("cache_size = -65536");
  sqlite.pragma("mmap_size = 268435456");
  sqlite.pragma("temp_store = MEMORY");
  const db = Object.assign(drizzleNode(sqlite, { schema }), {
    atomic: (statements: SQL[]) =>
      Promise.resolve().then(() => {
        const queries = statements.map(compileSql);
        // Never await inside a synchronous better-sqlite3 transaction.
        return sqlite.transaction(() =>
          queries.map(({ sql, params }) => {
            const statement = sqlite.prepare(sql);
            if (statement.reader)
              return statement.all(...params) as Record<string, unknown>[];
            statement.run(...params);
            return [];
          }),
        )();
      }),
  });
  return { db, sqlite };
};
