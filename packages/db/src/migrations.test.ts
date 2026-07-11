import { describe, expect, it } from "vitest";
import {
  applyNodeMigrations,
  createNodeDb,
  migrationFiles,
  normalizeSqlStatement,
  readMigrationFile,
  splitSqlStatements,
} from "./index.js";
import { d1Migrations } from "./d1-migrations.js";

describe("migration parity", () => {
  it("embeds every migration file under its file name", () => {
    expect(d1Migrations.map((migration) => migration.name)).toEqual(
      migrationFiles,
    );
  });

  it("embedded D1 statements match the migration files after normalization", () => {
    for (const migration of d1Migrations) {
      const fileStatements = splitSqlStatements(
        readMigrationFile(migration.name),
      ).map(normalizeSqlStatement);
      const embedded = migration.statements.map(normalizeSqlStatement);
      expect(embedded, migration.name).toEqual(fileStatements);
    }
  });

  it("keeps migration statements D1 safe", () => {
    for (const file of migrationFiles) {
      for (const statement of splitSqlStatements(readMigrationFile(file))) {
        const upper = normalizeSqlStatement(statement).toUpperCase();
        if (upper.startsWith("PRAGMA"))
          expect(upper, file).toMatch(/^PRAGMA DEFER_FOREIGN_KEYS\b/);
        expect(upper.startsWith("ATTACH"), file).toBe(false);
      }
    }
  });
});

describe("splitSqlStatements", () => {
  it("does not split on semicolons inside string literals or comments", () => {
    const statements = splitSqlStatements(
      [
        "CREATE TABLE t (v TEXT NOT NULL DEFAULT 'a;b');",
        "-- comment; with a semicolon",
        "INSERT INTO t (v) VALUES ('x''y;z');",
        "/* block; comment */ DELETE FROM t;",
      ].join("\n"),
    );
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("'a;b'");
    expect(statements[1]).toContain("'x''y;z'");
    expect(normalizeSqlStatement(statements[2] ?? "")).toBe("DELETE FROM t");
  });

  it("prefers drizzle statement breakpoints when present", () => {
    const statements = splitSqlStatements(
      "CREATE TABLE a (id TEXT);--> statement-breakpoint\nCREATE TABLE b (id TEXT);",
    );
    expect(statements).toEqual([
      "CREATE TABLE a (id TEXT)",
      "CREATE TABLE b (id TEXT)",
    ]);
  });
});

describe("0004 comments rebuild", () => {
  it("restores self referencing foreign keys and preserves child rows", () => {
    const { sqlite } = createNodeDb(":memory:");
    // Apply everything up to 0003, seed a comment thread, then apply 0004.
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS __onelight_migrations (id TEXT PRIMARY KEY)",
    );
    sqlite
      .prepare(
        "INSERT INTO __onelight_migrations (id) VALUES ('0004_comments_fks.sql')",
      )
      .run();
    applyNodeMigrations(sqlite);
    sqlite
      .prepare("DELETE FROM __onelight_migrations WHERE id = ?")
      .run("0004_comments_fks.sql");
    const seed = [
      "INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', 1)",
      "INSERT INTO users (id, workspace_id, email, name, role, created_at, updated_at) VALUES ('u1', 'w1', 'a@example.com', 'A', 'admin', 1, 1)",
      "INSERT INTO projects (id, workspace_id, name, palette, created_by, created_at, updated_at) VALUES ('p1', 'w1', 'P', 'kuwanomi', 'u1', 1, 1)",
      "INSERT INTO assets (id, project_id, name, kind, created_at, updated_at) VALUES ('a1', 'p1', 'A', 'video', 1, 1)",
      "INSERT INTO upload_sessions (id, workspace_id, project_id, created_by, client_filename, relative_path, size, blob_key, status, created_at) VALUES ('up1', 'w1', 'p1', 'u1', 'f.mov', 'f.mov', 1, 'k', 'completed', 1)",
      "INSERT INTO asset_versions (id, asset_id, upload_session_id, version_no, original_blob_key, original_filename, size, checksum_crc32c, uploaded_by, created_at) VALUES ('v1', 'a1', 'up1', 1, 'k', 'f.mov', 1, 'c', 'u1', 1)",
      "INSERT INTO comments (id, version_id, body_text, created_at) VALUES ('c1', 'v1', 'parent', 1)",
      "INSERT INTO comments (id, version_id, parent_id, body_text, created_at) VALUES ('c2', 'v1', 'c1', 'reply', 2)",
      "INSERT INTO comment_reactions (comment_id, user_id, code, created_at) VALUES ('c2', 'u1', 'thumbs_up', 2)",
      "INSERT INTO comment_reads (comment_id, user_id, read_at) VALUES ('c1', 'u1', 3)",
      "INSERT INTO comment_attachments (id, comment_id, blob_key, filename, size) VALUES ('at1', 'c1', 'bk', 'a.png', 1)",
    ];
    for (const statement of seed) sqlite.prepare(statement).run();
    applyNodeMigrations(sqlite);
    // Child rows survive the rebuild.
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM comment_attachments").get(),
    ).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM comment_reads").get(),
    ).toEqual({ n: 1 });
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM comment_reactions").get(),
    ).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM comments").get()).toEqual({
      n: 2,
    });
    // The self FKs are live: deleting the parent cascades to the reply.
    sqlite.prepare("DELETE FROM comments WHERE id = 'c1'").run();
    expect(sqlite.prepare("SELECT count(*) AS n FROM comments").get()).toEqual({
      n: 0,
    });
    // And a dangling parent_id is rejected.
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO comments (id, version_id, parent_id, body_text, created_at) VALUES ('c3', 'v1', 'missing', 'x', 3)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    sqlite.close();
  });
});
