import type Database from "better-sqlite3";

export type SearchBackend = "fts5" | "like";

const SEARCH_SCHEMA_VERSION = 1;
const SEARCH_TABLE = "onelight_search";
const FEATURE_TABLE = "__onelight_features";

interface SearchEntity {
  kind: "asset" | "comment" | "project" | "person" | "share";
  table: string;
  id: string;
  body: string;
  active?: string;
  updateColumns: string[];
}

const entities: readonly SearchEntity[] = [
  {
    kind: "asset",
    table: "assets",
    id: "id",
    body: "name",
    active: "deleted_at IS NULL",
    updateColumns: ["name", "deleted_at"],
  },
  {
    kind: "comment",
    table: "comments",
    id: "id",
    body: "body_text",
    active: "deleted_at IS NULL",
    updateColumns: ["body_text", "deleted_at"],
  },
  {
    kind: "project",
    table: "projects",
    id: "id",
    body: "name",
    updateColumns: ["name"],
  },
  {
    kind: "person",
    table: "users",
    id: "id",
    body: "name || ' ' || email",
    active: "disabled_at IS NULL",
    updateColumns: ["name", "email", "disabled_at"],
  },
  {
    kind: "share",
    table: "shares",
    id: "id",
    body: "title",
    active: "revoked_at IS NULL",
    updateColumns: ["title", "revoked_at"],
  },
] as const;

const triggerName = (
  entity: SearchEntity,
  operation: "insert" | "update" | "delete",
): string => `onelight_search_${entity.table}_${operation}`;

const insertSelect = (entity: SearchEntity, row: string): string => {
  const prefix = row === "new" ? "new." : "";
  const qualify = (expression: string): string => {
    if (!prefix) return expression;
    return expression.replace(
      /\b(name|email|title|body_text|deleted_at|disabled_at|revoked_at)\b/g,
      `${prefix}$1`,
    );
  };
  const where = entity.active ? ` WHERE ${qualify(entity.active)}` : "";
  const from = row === "new" ? "" : ` FROM ${entity.table}`;
  return `INSERT INTO ${SEARCH_TABLE} (kind, entity_id, body) SELECT '${entity.kind}', ${prefix}${entity.id}, COALESCE(${qualify(entity.body)}, '')${from}${where}`;
};

const installTriggers = (
  sqlite: Database.Database,
  entity: SearchEntity,
): void => {
  const insert = triggerName(entity, "insert");
  const update = triggerName(entity, "update");
  const remove = triggerName(entity, "delete");
  sqlite.exec(`
    CREATE TRIGGER ${insert}
    AFTER INSERT ON ${entity.table}
    BEGIN
      ${insertSelect(entity, "new")};
    END;

    CREATE TRIGGER ${update}
    AFTER UPDATE OF ${entity.updateColumns.join(", ")} ON ${entity.table}
    BEGIN
      DELETE FROM ${SEARCH_TABLE}
      WHERE kind = '${entity.kind}' AND entity_id = old.${entity.id};
      ${insertSelect(entity, "new")};
    END;

    CREATE TRIGGER ${remove}
    AFTER DELETE ON ${entity.table}
    BEGIN
      DELETE FROM ${SEARCH_TABLE}
      WHERE kind = '${entity.kind}' AND entity_id = old.${entity.id};
    END;
  `);
};

/**
 * Installs the native Node search accelerator outside the portable migration
 * stream. D1 cannot create virtual tables, so schema migrations remain byte
 * identical on both backends and the API selects this capability explicitly.
 *
 * The trigram tokenizer accelerates the substring contract already exposed by
 * GET /search. The API retains its literal LIKE predicate as the final
 * correctness check and uses LIKE alone for queries shorter than three
 * characters.
 */
export const configureNodeSearch = (
  sqlite: Database.Database,
): SearchBackend => {
  const fts5 = sqlite
    .prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled")
    .get() as { enabled: number };
  if (fts5.enabled !== 1) return "like";

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${FEATURE_TABLE} (name TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
  );
  const installed = sqlite
    .prepare(`SELECT version FROM ${FEATURE_TABLE} WHERE name = 'search'`)
    .get() as { version: number } | undefined;
  if (installed?.version === SEARCH_SCHEMA_VERSION) return "fts5";

  const install = sqlite.transaction(() => {
    for (const entity of entities) {
      sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName(entity, "insert")}`);
      sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName(entity, "update")}`);
      sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName(entity, "delete")}`);
    }
    sqlite.exec(`DROP TABLE IF EXISTS ${SEARCH_TABLE}`);
    sqlite.exec(
      `CREATE VIRTUAL TABLE ${SEARCH_TABLE} USING fts5(kind UNINDEXED, entity_id UNINDEXED, body, tokenize='trigram')`,
    );
    for (const entity of entities) {
      sqlite.exec(insertSelect(entity, entity.table));
      installTriggers(sqlite, entity);
    }
    sqlite
      .prepare(
        `INSERT INTO ${FEATURE_TABLE} (name, version) VALUES ('search', ?)
         ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
      )
      .run(SEARCH_SCHEMA_VERSION);
  });
  install();
  return "fts5";
};
