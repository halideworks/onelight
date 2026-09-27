import type { SQL } from "drizzle-orm";
import {
  SQLiteSyncDialect,
  type BaseSQLiteDatabase,
} from "drizzle-orm/sqlite-core";
import type { schema } from "./schema.js";

export type AppDb = BaseSQLiteDatabase<
  "sync" | "async",
  unknown,
  typeof schema
> & {
  /** All statements commit together, or none do. Rows are in statement order. */
  atomic(statements: SQL[]): Promise<Record<string, unknown>[][]>;
};

const dialect = new SQLiteSyncDialect();
export const compileSql = (statement: SQL) => dialect.sqlToQuery(statement);
