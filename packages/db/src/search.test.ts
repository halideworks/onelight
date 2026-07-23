import { describe, expect, it } from "vitest";
import {
  applyNodeMigrations,
  configureNodeSearch,
  createNodeDb,
} from "./index.js";

describe("Node FTS5 search index", () => {
  it("backfills existing rows and follows inserts, updates, soft deletes, and deletes", () => {
    const { sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('w1', 'Workspace', 1);
      INSERT INTO users (id, workspace_id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'w1', 'ava@example.com', 'Ava', 'admin', 1, 1);
      INSERT INTO projects (id, workspace_id, name, palette, created_by, created_at, updated_at)
      VALUES ('p1', 'w1', 'Moonrise', 'kuwanomi', 'u1', 1, 1);
      INSERT INTO assets (id, project_id, name, kind, created_at, updated_at)
      VALUES ('a1', 'p1', 'Alpha Camera', 'video', 1, 1);
    `);

    expect(configureNodeSearch(sqlite)).toBe("fts5");
    const hits = (query: string) =>
      sqlite
        .prepare(
          `SELECT kind, entity_id FROM onelight_search
           WHERE onelight_search MATCH ? ORDER BY kind, entity_id`,
        )
        .all(`"${query}"`);

    expect(hits("pha")).toContainEqual({ kind: "asset", entity_id: "a1" });
    expect(hits("onr")).toContainEqual({ kind: "project", entity_id: "p1" });

    sqlite
      .prepare("UPDATE assets SET name = 'Omega Camera' WHERE id = 'a1'")
      .run();
    expect(hits("pha")).not.toContainEqual({
      kind: "asset",
      entity_id: "a1",
    });
    expect(hits("meg")).toContainEqual({ kind: "asset", entity_id: "a1" });

    sqlite.prepare("UPDATE assets SET deleted_at = 2 WHERE id = 'a1'").run();
    expect(hits("meg")).not.toContainEqual({
      kind: "asset",
      entity_id: "a1",
    });

    sqlite
      .prepare(
        "INSERT INTO shares (id, project_id, slug, kind, title, layout, allow_download, allow_comments, show_all_versions, created_by, created_at) VALUES ('s1', 'p1', 'share-one', 'review', 'Director Review', 'grid', 'none', 1, 0, 'u1', 1)",
      )
      .run();
    expect(hits("rect")).toContainEqual({ kind: "share", entity_id: "s1" });
    sqlite.prepare("DELETE FROM shares WHERE id = 's1'").run();
    expect(hits("rect")).not.toContainEqual({
      kind: "share",
      entity_id: "s1",
    });

    expect(configureNodeSearch(sqlite)).toBe("fts5");
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS count FROM onelight_search WHERE kind = 'project' AND entity_id = 'p1'",
        )
        .get(),
    ).toEqual({ count: 1 });
    sqlite.close();
  });
});
