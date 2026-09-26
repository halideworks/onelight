import { requireAuth } from "../auth.js";
import { userFromContext, jsonBody, parseJsonValue } from "../helpers.js";
import {
  shares,
  exportJobs,
  folders,
  assets,
  assetVersions,
  projects,
  downloadManifests,
} from "@onelight/db/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
import { errors, zipEntryName, zipLength } from "@onelight/core";
import { bodies } from "../schemas.js";
import type { ZipEntry } from "@onelight/core";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Access } from "../operation/access.js";
import { exportWire } from "../wire.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";

export const registerDownloadsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  { access, media, blobs }: { access: Access; media: Media; blobs: Blobs },
) => {
  const { requireProject, requireDestinationFolder } = access;
  const { privateMediaUrl, DOWNLOAD_TOKEN_TTL_MS } = media;
  const { attachmentDisposition, requireBlobStore, serveZip } = blobs;

  api.post("/shares/:id/export", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "viewer");
    const body = await jsonBody(c, bodies.exportCreate);
    const id = env.ids.ulid();
    await env.db
      .insert(exportJobs)
      .values({
        id,
        workspaceId: actor.workspaceId,
        requestedBy: actor.id,
        projectId: share.projectId,
        format: body.format,
        // These final constraints are server-controlled. They prevent a share
        // export from leaking comments on other project assets or internal
        // review notes.
        filtersJson: JSON.stringify({
          ...body.filters,
          share_id: share.id,
          internal: false,
        }),
        timecodeBase: body.timecode_base,
        status: "queued",
        resultBlobKey: null,
        error: null,
        createdAt: env.clock.now(),
        finishedAt: null,
      })
      .run();
    return c.json({ id, status: "queued" }, 202);
  });

  /* The project-scoped twin of the share export: same job, no share needed.
     This is the entry point the review page uses. */
  api.post("/projects/:id/export", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "viewer",
    );
    const body = await jsonBody(c, bodies.exportCreate);
    const id = env.ids.ulid();
    await env.db
      .insert(exportJobs)
      .values({
        id,
        workspaceId: actor.workspaceId,
        requestedBy: actor.id,
        projectId: project.id,
        format: body.format,
        filtersJson: JSON.stringify(body.filters),
        timecodeBase: body.timecode_base,
        status: "queued",
        resultBlobKey: null,
        error: null,
        createdAt: env.clock.now(),
        finishedAt: null,
      })
      .run();
    return c.json({ id, status: "queued" }, 202);
  });

  api.get("/exports/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const job = (
      await env.db
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.id, c.req.param("id")),
            eq(exportJobs.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!job) throw errors.notFound();
    await requireProject(job.projectId, actor, "viewer");
    return c.json(exportWire(job));
  });

  api.get("/exports/:id/download", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const job = (
      await env.db
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.id, c.req.param("id")),
            eq(exportJobs.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!job) throw errors.notFound();
    await requireProject(job.projectId, actor, "viewer");
    if (job.status !== "complete" || !job.resultBlobKey || !env.blobStore)
      throw errors.notFound("The export is not ready.");
    const filename = job.resultBlobKey.split("/").pop() || `export-${job.id}`;
    return c.json({
      url: await privateMediaUrl(
        { exportId: job.id },
        job.resultBlobKey,
        attachmentDisposition(filename),
      ),
      expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
  });

  /* The entries a project download is made of: the current version of every
     chosen asset, filed under its folder path, with duplicate names made
     unique. Shared by the query-string zip and the manifest download. */
  const projectZipEntries = async (
    projectId: string,
    options: { folderId: string | null; assetIds: string[] },
  ): Promise<{ entries: ZipEntry[]; scopeName: string }> => {
    const store = requireBlobStore();
    const folderId = options.folderId;
    const wantedIds = options.assetIds;
    /* The folder tree, for archive paths and for expanding a folder pick
       into its descendants. */
    const folderRows = (await env.db
      .select()
      .from(folders)
      .where(and(eq(folders.projectId, projectId), eq(folders.kind, "assets")))
      .all()) as Array<typeof folders.$inferSelect>;
    const foldersById = new Map(folderRows.map((row) => [row.id, row]));
    const pathOf = (id: string | null): string[] => {
      const segments: string[] = [];
      let cursor = id;
      let guard = 0;
      while (cursor && guard < 64) {
        const row = foldersById.get(cursor);
        if (!row) break;
        segments.unshift(row.name);
        cursor = row.parentId;
        guard += 1;
      }
      return segments;
    };
    const insideWanted = (id: string | null): boolean => {
      if (!folderId) return true;
      let cursor = id;
      let guard = 0;
      while (cursor && guard < 64) {
        if (cursor === folderId) return true;
        cursor = foldersById.get(cursor)?.parentId ?? null;
        guard += 1;
      }
      return false;
    };
    if (folderId && !foldersById.has(folderId))
      throw errors.notFound("Folder was not found.");
    const rows = (await env.db
      .select({ asset: assets, version: assetVersions })
      .from(assets)
      .innerJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(and(eq(assets.projectId, projectId), isNull(assets.deletedAt)))
      .orderBy(asc(assets.id))
      .all()) as Array<{
      asset: typeof assets.$inferSelect;
      version: typeof assetVersions.$inferSelect;
    }>;
    const wanted = new Set(wantedIds);
    const chosen = rows.filter(
      (row) =>
        (wanted.size === 0 || wanted.has(row.asset.id)) &&
        insideWanted(row.asset.folderId),
    );
    if (!chosen.length) throw errors.notFound("Nothing to download.");
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const row of chosen) {
      const version = row.version;
      const directory = pathOf(row.asset.folderId)
        .map((segment) => zipEntryName(segment))
        .join("/");
      let name = zipEntryName(version.originalFilename);
      if (directory) name = `${directory}/${name}`;
      if (used.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let suffix = 2;
        while (used.has(`${stem} (${suffix})${extension}`)) suffix += 1;
        name = `${stem} (${suffix})${extension}`;
      }
      used.add(name);
      entries.push({
        name,
        size: version.size,
        modifiedAt: version.createdAt,
        cacheKey: version.originalBlobKey,
        open: () => store.getStream(version.originalBlobKey),
        openRange: (from) =>
          store.getStream(version.originalBlobKey, { start: from }),
      });
    }
    const scopeName = folderId
      ? (foldersById.get(folderId)?.name ?? "folder")
      : ((
          await env.db
            .select({ name: projects.name })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1)
            .all()
        )[0]?.name ?? "project");
    return { entries, scopeName };
  };

  const zipNameOf = (scopeName: string, suffix = ""): string =>
    `${
      scopeName
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "files"
    }${suffix}.zip`;

  /* A folder, a selection, or the whole project as one streamed zip of
     originals. Editor for the same reason the single original is: this is
     the negative, not the screener. */
  api.get("/projects/:id/zip", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "editor");
    const { entries, scopeName } = await projectZipEntries(projectId, {
      folderId: c.req.query("folder_id") ?? null,
      assetIds: (c.req.query("asset_ids") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
    return serveZip(c, entries, zipNameOf(scopeName));
  });

  /* A delivery chosen once, downloaded by a short token, and split into
     archives a person can actually receive.

     Two things were wrong with handing a browser one URL. The selection rode
     in the query string, which is about 81 KB for 3000 files: fine on Caddy,
     refused by an nginx default and past the Cloudflare 16 KB URL cap. And a
     single 150 GB archive is a bad unit of delivery even when it resumes
     correctly, which ours does.

     A manifest is POSTed once. The reply says how many archives it is and how
     big each one is, and each part is an ordinary zip: exact length, ETag,
     ranged resume. Parts are cut on entry boundaries, so a part is always a
     set of whole files. */
  const MANIFEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const manifestParts = (
    entries: ZipEntry[],
    partBytes: number | null,
  ): ZipEntry[][] => {
    if (!partBytes || partBytes <= 0) return entries.length ? [entries] : [];
    const parts: ZipEntry[][] = [];
    let current: ZipEntry[] = [];
    let size = 0;
    for (const entry of entries) {
      /* A file larger than the part size gets its own part rather than being
         cut in half: a part must always be a set of whole files. */
      if (current.length && size + entry.size > partBytes) {
        parts.push(current);
        current = [];
        size = 0;
      }
      current.push(entry);
      size += entry.size;
    }
    if (current.length) parts.push(current);
    return parts;
  };

  api.post("/projects/:id/downloads", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "editor");
    const body = await jsonBody(c, bodies.downloadManifestCreate);
    if (body.folder_id)
      await requireDestinationFolder(projectId, body.folder_id);
    const { entries, scopeName } = await projectZipEntries(projectId, {
      folderId: body.folder_id ?? null,
      assetIds: body.asset_ids ?? [],
    });
    const partBytes = body.part_bytes ?? null;
    const parts = manifestParts(entries, partBytes);
    const id = env.ids.ulid();
    const now = env.clock.now();
    await env.db
      .insert(downloadManifests)
      .values({
        id,
        projectId,
        createdBy: actor.id,
        name: scopeName,
        assetIdsJson: JSON.stringify(body.asset_ids ?? []),
        folderId: body.folder_id ?? null,
        partBytes,
        createdAt: now,
        expiresAt: now + MANIFEST_TTL_MS,
      })
      .run();
    return c.json(
      {
        id,
        name: scopeName,
        file_count: entries.length,
        total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        expires_at: now + MANIFEST_TTL_MS,
        parts: parts.map((part, index) => ({
          index: index + 1,
          file_count: part.length,
          bytes: zipLength(part),
          url: `/api/v1/downloads/${id}/zip${
            parts.length > 1 ? `?part=${String(index + 1)}` : ""
          }`,
        })),
      },
      201,
    );
  });

  api.get("/downloads/:id/zip", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const manifest = (
      await env.db
        .select()
        .from(downloadManifests)
        .where(eq(downloadManifests.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!manifest) throw errors.notFound();
    if (manifest.expiresAt <= env.clock.now())
      throw errors.notFound("This download has expired.");
    /* The manifest is a saved selection, not a grant: permission is checked
       now, against the project, exactly as the direct zip does. */
    await requireProject(manifest.projectId, actor, "editor");
    const assetIds = Array.isArray(parseJsonValue(manifest.assetIdsJson))
      ? (parseJsonValue(manifest.assetIdsJson) as string[])
      : [];
    const { entries, scopeName } = await projectZipEntries(manifest.projectId, {
      folderId: manifest.folderId,
      assetIds,
    });
    const parts = manifestParts(entries, manifest.partBytes);
    if (!parts.length) throw errors.notFound("Nothing to download.");
    const requested = Number(c.req.query("part") ?? 1);
    if (
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > parts.length
    )
      throw errors.validation("That part is not in this download.", {
        parts: parts.length,
      });
    const part = parts[requested - 1] as ZipEntry[];
    return serveZip(
      c,
      part,
      zipNameOf(
        scopeName,
        parts.length > 1
          ? ` (${String(requested)} of ${String(parts.length)})`
          : "",
      ),
    );
  });
};
