import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import {
  base64UrlEncode,
  crc32cMatches,
  crc32cStream,
  loadConfig,
  randomBytes,
} from "@onelight/core";
import {
  applyNodeMigrations,
  createNodeDb,
  assetVersions,
  assets,
  folders,
  projects,
  sessions,
  transferReceipts,
  transfers,
  users,
} from "@onelight/db";
import { NodePasswordHasher } from "./password.js";

/* Operator commands, run inside the server container:

     node cli.js reset-password <email>
     node cli.js offload --project <id or name> --dest <path> [--transfer <slug>]

   offload copies a project's original files out of blob storage into a
   destination directory (a mounted NAS or DAS path), rebuilding the folder
   tree with original filenames, verifying every copy against the stored
   CRC32C, and writing a manifest. Re-running skips files already present
   and verified, so an interrupted offload resumes. */

const argv = process.argv.slice(2);
const command = argv[0];

const config = loadConfig(process.env);
fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });
const { db, sqlite } = createNodeDb(config.DATABASE_PATH);
applyNodeMigrations(sqlite);

const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const resetPassword = async (email: string): Promise<void> => {
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
};

/** Path-safe single segment: keeps the name, defangs separators. */
const safeSegment = (name: string): string => {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
};

const offload = async (): Promise<void> => {
  const wanted = flag("project");
  const dest = flag("dest");
  const transferSlug = flag("transfer");
  if (!wanted || !dest)
    throw new Error(
      "Usage: offload --project <id or name> --dest <path> [--transfer <slug>]",
    );
  const blobRoot =
    process.env.BLOB_ROOT ??
    path.join(path.dirname(config.DATABASE_PATH), "blobs");
  const projectRows = await db.select().from(projects).all();
  const project = projectRows.find(
    (row: typeof projects.$inferSelect) =>
      row.id === wanted || row.name === wanted,
  );
  if (!project) throw new Error(`No project found for "${wanted}".`);

  /* Folder tree, for rebuilding paths on the destination. */
  const folderRows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.projectId, project.id), eq(folders.kind, "assets")))
    .all();
  const byId = new Map(
    folderRows.map((row: typeof folders.$inferSelect) => [row.id, row]),
  );
  const folderPath = (folderId: string | null): string[] => {
    const segments: string[] = [];
    let cursor = folderId;
    let guard = 0;
    while (cursor && guard < 64) {
      const row = byId.get(cursor);
      if (!row) break;
      segments.unshift(safeSegment(row.name));
      cursor = row.parentId;
      guard += 1;
    }
    return segments;
  };

  /* Every live version of every live asset; a transfer slug narrows the
     set to what that request link received. */
  let rows = await db
    .select({ asset: assets, version: assetVersions })
    .from(assetVersions)
    .innerJoin(assets, eq(assetVersions.assetId, assets.id))
    .where(
      and(
        eq(assets.projectId, project.id),
        isNull(assets.deletedAt),
        isNull(assetVersions.deletedAt),
      ),
    )
    .all();
  if (transferSlug) {
    const transfer = (
      await db
        .select()
        .from(transfers)
        .where(eq(transfers.slug, transferSlug))
        .limit(1)
        .all()
    )[0];
    if (!transfer) throw new Error(`No transfer found for "${transferSlug}".`);
    const receipts = await db
      .select()
      .from(transferReceipts)
      .where(eq(transferReceipts.transferId, transfer.id))
      .all();
    const received = new Set(
      receipts
        .map((row: typeof transferReceipts.$inferSelect) => row.assetId)
        .filter((id: string | null): id is string => id !== null),
    );
    rows = rows.filter((row: { asset: typeof assets.$inferSelect }) =>
      received.has(row.asset.id),
    );
  }

  const root = path.resolve(dest, safeSegment(project.name));
  const used = new Set<string>();
  const manifest: Array<Record<string, unknown>> = [];
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const source = path.join(blobRoot, row.version.originalBlobKey);
    const directory = path.join(
      root,
      ...folderPath(row.asset.folderId ?? null),
    );
    let filename = safeSegment(row.version.originalFilename);
    if (row.version.versionNo > 1) {
      const dot = filename.lastIndexOf(".");
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const extension = dot > 0 ? filename.slice(dot) : "";
      filename = `${stem} v${row.version.versionNo}${extension}`;
    }
    let target = path.join(directory, filename);
    if (used.has(target)) {
      const dot = filename.lastIndexOf(".");
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const extension = dot > 0 ? filename.slice(dot) : "";
      let suffix = 2;
      while (used.has(path.join(directory, `${stem} (${suffix})${extension}`)))
        suffix += 1;
      target = path.join(directory, `${stem} (${suffix})${extension}`);
    }
    used.add(target);
    const entry: Record<string, unknown> = {
      file: path.relative(root, target),
      asset_id: row.asset.id,
      version_id: row.version.id,
      size: row.version.size,
      checksum_crc32c: row.version.checksumCrc32c || null,
    };
    try {
      if (!fs.existsSync(source)) throw new Error("original blob is missing");
      const verify = async (): Promise<boolean> => {
        if (!row.version.checksumCrc32c) return true;
        const digest = await crc32cStream(
          Readable.toWeb(
            fs.createReadStream(target),
          ) as ReadableStream<Uint8Array>,
        );
        return crc32cMatches(row.version.checksumCrc32c, digest);
      };
      if (
        fs.existsSync(target) &&
        fs.statSync(target).size === row.version.size &&
        (await verify())
      ) {
        entry.state = "already present, verified";
        skipped += 1;
      } else {
        fs.mkdirSync(directory, { recursive: true });
        fs.copyFileSync(source, target);
        if (fs.statSync(target).size !== row.version.size)
          throw new Error("copied size does not match");
        if (!(await verify())) throw new Error("checksum mismatch after copy");
        entry.state = "copied, verified";
        copied += 1;
      }
    } catch (caught) {
      entry.state = `failed: ${caught instanceof Error ? caught.message : String(caught)}`;
      failed += 1;
    }
    console.log(`${String(entry.state)}  ${String(entry.file)}`);
    manifest.push(entry);
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "onelight-manifest.json"),
    `${JSON.stringify(
      {
        project: { id: project.id, name: project.name },
        generated_at: new Date().toISOString(),
        files: manifest,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Offload complete: ${copied} copied, ${skipped} already present, ${failed} failed. Manifest written to ${path.join(root, "onelight-manifest.json")}.`,
  );
  if (failed > 0) process.exitCode = 1;
};

try {
  if (command === "reset-password" && argv[1]) {
    await resetPassword(argv[1]);
  } else if (command === "offload") {
    await offload();
  } else {
    throw new Error(
      "Usage: reset-password <email> | offload --project <id or name> --dest <path> [--transfer <slug>]",
    );
  }
} finally {
  sqlite.close();
}
