// Schema drift and D1-safety check, run by "pnpm db:check" from the repo
// root. Applies every migration file to a throwaway better-sqlite3 database,
// verifies foreign key integrity, and asserts that every statement is safe
// to execute on D1 (no PRAGMA other than defer_foreign_keys, no ATTACH),
// since the same files are applied there by wrangler and, via the embedded
// copies in d1-migrations.ts, by the worker itself.
import Database from "better-sqlite3";
import {
  applyNodeMigrations,
  migrationFiles,
  normalizeSqlStatement,
  readMigrationFile,
  splitSqlStatements,
} from "./migrations.js";
import { d1Migrations } from "./d1-migrations.js";

const failures: string[] = [];

const checkStatement = (source: string, statement: string): void => {
  const normalized = normalizeSqlStatement(statement);
  const upper = normalized.toUpperCase();
  if (
    upper.startsWith("PRAGMA") &&
    !/^PRAGMA\s+DEFER_FOREIGN_KEYS\b/.test(upper)
  )
    failures.push(
      `${source}: PRAGMA other than defer_foreign_keys is not allowed on D1: ${normalized}`,
    );
  if (upper.startsWith("ATTACH"))
    failures.push(`${source}: ATTACH is not allowed on D1: ${normalized}`);
};

for (const file of migrationFiles) {
  for (const statement of splitSqlStatements(readMigrationFile(file)))
    checkStatement(file, statement);
}
for (const migration of d1Migrations) {
  for (const statement of migration.statements)
    checkStatement(`embedded ${migration.name}`, statement);
}

const sqlite = new Database(":memory:");
try {
  applyNodeMigrations(sqlite);
  const fkViolations = sqlite.pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0)
    failures.push(
      `foreign_key_check reported ${String(fkViolations.length)} violations after applying all migrations`,
    );
} catch (error) {
  failures.push(`applying migrations failed: ${String(error)}`);
} finally {
  sqlite.close();
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("ok");
