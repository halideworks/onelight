import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { base64UrlEncode, loadConfig, randomBytes } from "@onelight/core";
import {
  applyNodeMigrations,
  createNodeDb,
  sessions,
  users,
} from "@onelight/db";
import { NodePasswordHasher } from "./password.js";

const [command, email] = process.argv.slice(2);
if (command !== "reset-password" || !email)
  throw new Error("Usage: reset-password <email>");
const config = loadConfig(process.env);
fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });
const { db, sqlite } = createNodeDb(config.DATABASE_PATH);
applyNodeMigrations(sqlite);
const user = (
  await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1)
    .all()
)[0];
if (!user) throw new Error(`No user found for ${email}.`);
const password = `ol-${base64UrlEncode(randomBytes(12))}`;
await db
  .update(users)
  .set({
    passwordHash: await new NodePasswordHasher().hash(password),
    updatedAt: Date.now(),
  })
  .where(eq(users.id, user.id))
  .run();
await db.delete(sessions).where(eq(sessions.userId, user.id)).run();
console.log(`One-time password for ${user.email}: ${password}`);
sqlite.close();
