import { drizzle } from "drizzle-orm/d1";
import type { SQL } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { compileSql, type AppDb } from "./atomic.js";
import { schema } from "./schema.js";
export { applyD1Migrations, d1Migrations } from "./d1-migrations.js";
export type { AppDb } from "./atomic.js";

export const createD1Db = (binding: D1Database): AppDb =>
  Object.assign(drizzle(binding, { schema }), {
    atomic: async (statements: SQL[]) => {
      if (!statements.length) return [];
      const prepared = statements.map((statement) => {
        const { sql, params } = compileSql(statement);
        return binding.prepare(sql).bind(...params);
      });
      const results = await binding.batch<Record<string, unknown>>(prepared);
      return results.map((result) => result.results);
    },
  });
