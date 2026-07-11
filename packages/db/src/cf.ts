import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { D1Database } from "@cloudflare/workers-types";
import { schema } from "./schema.js";
export { applyD1Migrations } from "./d1-migrations.js";

// Keep in sync with AppDb in client.ts. This entry point must not import
// client.ts because that module loads better-sqlite3 at runtime, which does
// not exist in Workers.
export type AppDb = BaseSQLiteDatabase<
  "sync" | "async",
  unknown,
  typeof schema
>;

export const createD1Db = (binding: D1Database): AppDb =>
  drizzle(binding, { schema });
