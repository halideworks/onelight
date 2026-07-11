import Database from "better-sqlite3";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleNode } from "drizzle-orm/better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { D1Database } from "@cloudflare/workers-types";
import { schema } from "./schema.js";

/**
 * The database handle shared by both runtimes. better-sqlite3 instantiates
 * BaseSQLiteDatabase<"sync", RunResult, ...> and D1 instantiates
 * BaseSQLiteDatabase<"async", D1Result, ...>; widening the result kind to
 * the union and the run result to unknown gives one structural type that
 * both drivers satisfy, so callers await every terminal call (awaiting the
 * sync driver's plain values is a no-op) and never branch per driver.
 */
export type AppDb = BaseSQLiteDatabase<
  "sync" | "async",
  unknown,
  typeof schema
>;

export const createNodeDb = (
  filename: string,
): { db: AppDb; sqlite: Database.Database } => {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { db: drizzleNode(sqlite, { schema }), sqlite };
};

export const createD1Db = (binding: D1Database): AppDb =>
  drizzleD1(binding, { schema });
