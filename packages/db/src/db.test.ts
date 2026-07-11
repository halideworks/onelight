import { describe, expect, it } from "vitest";
import {
  applyNodeMigrations,
  createNodeDb,
  folders,
  projects,
  users,
  workspaces,
} from "./index.js";

describe("SQLite schema", () => {
  it("applies the Phase 0 DDL with foreign keys enabled", () => {
    const { sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    const names = sqlite
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as Array<{ name: string }>;
    expect(names.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "workspaces",
        "users",
        "projects",
        "folders",
        "audit_log",
        "upload_sessions",
        "upload_parts",
        "assets",
        "asset_versions",
        "renditions",
        "jobs",
        "project_events",
        "comments",
        "comment_attachments",
        "comment_reads",
        "comment_reactions",
        "notifications",
        "notification_preferences",
        "shares",
        "share_assets",
        "share_viewers",
        "webhooks",
        "webhook_deliveries",
        "export_jobs",
      ]),
    );
    sqlite.close();
  });

  it("enforces sibling uniqueness and workspace foreign keys", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    await db
      .insert(workspaces)
      .values({
        id: "01J00000000000000000000000",
        name: "Test",
        settingsJson: "{}",
        createdAt: 1,
      })
      .run();
    await db
      .insert(users)
      .values({
        id: "01J00000000000000000000001",
        workspaceId: "01J00000000000000000000000",
        email: "a@example.com",
        name: "A",
        role: "admin",
        passwordHash: null,
        disabledAt: null,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(projects)
      .values({
        id: "01J00000000000000000000002",
        workspaceId: "01J00000000000000000000000",
        name: "P",
        status: "active",
        palette: "kuwanomi",
        restricted: false,
        settingsJson: "{}",
        createdBy: "01J00000000000000000000001",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    await db
      .insert(folders)
      .values({
        id: "01J00000000000000000000003",
        projectId: "01J00000000000000000000002",
        parentId: null,
        name: "Rushes",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    expect(() =>
      db
        .insert(folders)
        .values({
          id: "01J00000000000000000000004",
          projectId: "01J00000000000000000000002",
          parentId: null,
          name: "Rushes",
          createdAt: 1,
          updatedAt: 1,
        })
        .run(),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          "insert into users (id, workspace_id, email, name, role, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "01J00000000000000000000005",
          "01J00000000000000000000099",
          "b@example.com",
          "B",
          "member",
          1,
          1,
        ),
    ).toThrow();
    sqlite.close();
  });
});
