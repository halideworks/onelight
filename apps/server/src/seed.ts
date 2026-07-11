import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  createNodeDb,
  applyNodeMigrations,
  projects,
  projectMembers,
  users,
  workspaces,
} from "@onelight/db";
import {
  loadConfig,
  PALETTES,
  UlidGenerator,
  systemClock,
} from "@onelight/core";
import { NodePasswordHasher } from "./password.js";

const config = loadConfig(process.env);
fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });
const { db, sqlite } = createNodeDb(config.DATABASE_PATH);
applyNodeMigrations(sqlite);
const ids = new UlidGenerator();
const hasher = new NodePasswordHasher();
const now = systemClock.now();

const existing = await db.select().from(users).limit(1).all();
let workspace = (await db.select().from(workspaces).limit(1).all())[0];
let admin = existing[0];
let generatedPassword: string | undefined;
if (!workspace || !admin) {
  const workspaceId = ids.ulid();
  const adminId = ids.ulid();
  const adminPassword =
    config.ONELIGHT_ADMIN_PASSWORD ??
    (generatedPassword = randomBytes(12).toString("base64url"));
  await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: config.ONELIGHT_WORKSPACE_NAME,
      settingsJson: "{}",
      createdAt: now,
    })
    .run();
  await db
    .insert(users)
    .values({
      id: adminId,
      workspaceId,
      email: config.ONELIGHT_ADMIN_EMAIL ?? "demo@onelight.local",
      name: "Demo Admin",
      role: "admin",
      passwordHash: await hasher.hash(adminPassword),
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  workspace = (
    await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .all()
  )[0];
  admin = (
    await db.select().from(users).where(eq(users.id, adminId)).limit(1).all()
  )[0];
}
if (!workspace || !admin) throw new Error("Could not create seed workspace.");
const existingProjects = await db
  .select()
  .from(projects)
  .where(eq(projects.workspaceId, workspace.id))
  .all();
for (let index = existingProjects.length; index < 6; index += 1) {
  const projectId = ids.ulid();
  await db
    .insert(projects)
    .values({
      id: projectId,
      workspaceId: workspace.id,
      name:
        [
          "Dailies",
          "Editorial",
          "Commercials",
          "Documentary",
          "Archive",
          "Presentation",
        ][index] ?? `Project ${index + 1}`,
      status: "active",
      palette: PALETTES[index % PALETTES.length] ?? "kuwanomi",
      restricted: false,
      settingsJson: "{}",
      createdBy: admin.id,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await db
    .insert(projectMembers)
    .values({ projectId, userId: admin.id, role: "manager", createdAt: now })
    .run();
}
// Never echo a password that came from the environment; only print one the
// seed generated itself.
console.log(`Seeded ${workspace.name}. Demo login: ${admin.email}`);
if (generatedPassword)
  console.log(`Generated demo password: ${generatedPassword}`);
else
  console.log(
    "Password: not shown (existing account or ONELIGHT_ADMIN_PASSWORD).",
  );
sqlite.close();
