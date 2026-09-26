import {
  transferItems,
  transferReceipts,
  uploadSessions,
  transfers,
  assets,
  projects,
  assetVersions,
  transferVisits,
  transferDownloads,
  folders,
} from "@onelight/db/schema";
import { sql, inArray, eq, and, isNull, desc, asc, lt } from "drizzle-orm";
import {
  errors,
  base64UrlEncode,
  randomBytes,
  sha256Hex,
  zipEntryName,
} from "@onelight/core";
import { requireAuth } from "../auth.js";
import {
  userFromContext,
  jsonBody,
  parseJsonObject,
  clientIp,
  base62,
} from "../helpers.js";
import { bodies } from "../schemas.js";
import {
  DEFAULT_TRANSFER_REQUEST_BYTE_CAP,
  PRESENCE_WRITE_INTERVAL_MS,
} from "../limits.js";
import type { Context } from "hono";
import type { Variables, AppEnv, ApiRouter } from "../types.js";
import { SignJWT, jwtVerify } from "jose";
import { setCookie, getCookie } from "hono/cookie";
import type { ZipEntry } from "@onelight/core";
import type { Access } from "../operation/access.js";
import type { Activity } from "../operation/activity.js";
import type { Identity } from "../operation/identity.js";
import type { Blobs } from "../operation/blobs.js";
import type { Media } from "../operation/media.js";
import type { Uploads } from "../operation/uploads.js";

export const registerTransfersRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    activity,
    identity,
    blobs,
    media,
    uploads,
  }: {
    access: Access;
    activity: Activity;
    identity: Identity;
    blobs: Blobs;
    media: Media;
    uploads: Uploads;
  },
) => {
  const { requireProject, requireDestinationFolder } = access;
  const { appendProjectEvent, createNotifications, projectManagerIds } =
    activity;
  const { hitRateLimit } = identity;
  const {
    attachmentDisposition,
    sanitizeDisposition,
    serveBlob,
    requireBlobStore,
    serveZip,
  } = blobs;
  const { DOWNLOAD_TOKEN_TTL, DOWNLOAD_TOKEN_TTL_MS } = media;
  const {
    storedFilename,
    startMultipart,
    listPartsResponse,
    storePart,
    finishUpload,
    landUploadAsAsset,
  } = uploads;

  /* ------------------------------ Transfers ------------------------------
     Links that move files in and out of a project without a seat. A package
     sends existing assets to someone; a request receives files from someone,
     landing them as assets through the same multipart engine, checksum
     verification, and probe pipeline members use. */

  /* A package hands out originals, so it takes the same authority a share
     with original downloads takes; a request only adds files, like an
     editor. */
  const transferRoleFor = (kind: "package" | "request") =>
    kind === "package" ? ("manager" as const) : ("editor" as const);

  type TransferCounts = {
    itemCount: number;
    receivedCount: number;
    receivedBytes: number;
  };

  const transferCountsFor = async (
    transferIds: string[],
  ): Promise<Map<string, TransferCounts>> => {
    const counts = new Map<string, TransferCounts>();
    if (!transferIds.length) return counts;
    for (const id of transferIds)
      counts.set(id, { itemCount: 0, receivedCount: 0, receivedBytes: 0 });
    const itemRows = await env.db
      .select({
        transferId: transferItems.transferId,
        total: sql<number>`count(*)`,
      })
      .from(transferItems)
      .where(inArray(transferItems.transferId, transferIds))
      .groupBy(transferItems.transferId)
      .all();
    for (const row of itemRows) {
      const entry = counts.get(row.transferId);
      if (entry) entry.itemCount = Number(row.total);
    }
    const receiptRows = await env.db
      .select({
        transferId: transferReceipts.transferId,
        size: uploadSessions.size,
        status: uploadSessions.status,
      })
      .from(transferReceipts)
      .innerJoin(
        uploadSessions,
        eq(transferReceipts.uploadSessionId, uploadSessions.id),
      )
      .where(inArray(transferReceipts.transferId, transferIds))
      .all();
    for (const row of receiptRows) {
      const entry = counts.get(row.transferId);
      if (!entry || row.status === "aborted" || row.status === "quarantined")
        continue;
      // In-flight bytes count toward the cap; the count is finished files.
      entry.receivedBytes += row.size;
      if (row.status === "completed") entry.receivedCount += 1;
    }
    return counts;
  };

  const transferWire = (
    row: typeof transfers.$inferSelect,
    counts?: TransferCounts,
  ) => ({
    id: row.id,
    project_id: row.projectId,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    message: row.message,
    has_passphrase: row.passphraseHash !== null,
    expires_at: row.expiresAt,
    byte_cap: row.byteCap,
    folder_id: row.folderId,
    created_by: row.createdBy,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
    item_count: counts?.itemCount ?? 0,
    received_count: counts?.receivedCount ?? 0,
    received_bytes: counts?.receivedBytes ?? 0,
  });

  const transferById = async (id: string) => {
    const row = (
      await env.db
        .select()
        .from(transfers)
        .where(eq(transfers.id, id))
        .limit(1)
        .all()
    )[0];
    if (!row) throw errors.notFound("Transfer was not found.");
    return row;
  };

  api.post("/transfers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.transferCreate);
    await requireProject(body.project_id, actor, transferRoleFor(body.kind));
    if (body.kind === "package" && !body.asset_ids.length)
      throw errors.validation("A package needs at least one file.");
    if (body.kind === "request" && body.asset_ids.length)
      throw errors.validation("A request link does not carry files.");
    if (body.asset_ids.length) {
      const allowedAssets = await env.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(eq(assets.projectId, body.project_id), isNull(assets.deletedAt)),
        )
        .all();
      const allowed = new Set(
        allowedAssets.map((asset: { id: string }) => asset.id),
      );
      if (body.asset_ids.some((id) => !allowed.has(id)))
        throw errors.validation(
          "Every packaged file must belong to the project.",
        );
    }
    if (body.folder_id)
      await requireDestinationFolder(body.project_id, body.folder_id);
    const id = env.ids.ulid();
    const readable = body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
    const slug = readable ? `${readable}-${base62(14)}` : base62(22);
    const now = env.clock.now();
    await env.db
      .insert(transfers)
      .values({
        id,
        projectId: body.project_id,
        kind: body.kind,
        slug,
        title: body.title.trim(),
        message: body.message,
        passphraseHash: body.passphrase
          ? await env.hasher.hash(body.passphrase)
          : null,
        expiresAt: body.expires_at ?? null,
        byteCap:
          body.kind === "request"
            ? (body.byte_cap ?? DEFAULT_TRANSFER_REQUEST_BYTE_CAP)
            : null,
        folderId: body.kind === "request" ? (body.folder_id ?? null) : null,
        createdBy: actor.id,
        revokedAt: null,
        createdAt: now,
      })
      .run();
    for (const [index, assetId] of body.asset_ids.entries())
      await env.db
        .insert(transferItems)
        .values({ transferId: id, assetId, sortOrder: index })
        .run();
    await appendProjectEvent(body.project_id, "transfer.created", {
      transfer_id: id,
      kind: body.kind,
    });
    const row = await transferById(id);
    const counts = (await transferCountsFor([id])).get(id);
    return c.json(
      {
        transfer: transferWire(row, counts),
        url: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/t/${slug}`,
      },
      201,
    );
  });

  api.get("/transfers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.query("project_id");
    if (projectId) await requireProject(projectId, actor, "viewer");
    const rows = await env.db
      .select()
      .from(transfers)
      .innerJoin(projects, eq(transfers.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          projectId ? eq(transfers.projectId, projectId) : undefined,
        ),
      )
      .orderBy(desc(transfers.id))
      .all();
    const list = rows.map(
      (row: { transfers: typeof transfers.$inferSelect }) => row.transfers,
    );
    const counts = await transferCountsFor(
      list.map((row: typeof transfers.$inferSelect) => row.id),
    );
    return c.json({
      items: list.map((row: typeof transfers.$inferSelect) =>
        transferWire(row, counts.get(row.id)),
      ),
    });
  });

  api.get("/transfers/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(transfer.projectId, actor, "viewer");
    const itemRows = await env.db
      .select({
        link: transferItems,
        asset: assets,
        version: assetVersions,
      })
      .from(transferItems)
      .innerJoin(assets, eq(transferItems.assetId, assets.id))
      .leftJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(asc(transferItems.sortOrder))
      .all();
    const receiptRows = await env.db
      .select({ receipt: transferReceipts, upload: uploadSessions })
      .from(transferReceipts)
      .innerJoin(
        uploadSessions,
        eq(transferReceipts.uploadSessionId, uploadSessions.id),
      )
      .where(eq(transferReceipts.transferId, transfer.id))
      .orderBy(asc(transferReceipts.id))
      .all();
    const counts = (await transferCountsFor([transfer.id])).get(transfer.id);
    return c.json({
      ...transferWire(transfer, counts),
      items: itemRows.map(
        (row: {
          link: typeof transferItems.$inferSelect;
          asset: typeof assets.$inferSelect;
          version: typeof assetVersions.$inferSelect | null;
        }) => ({
          asset_id: row.asset.id,
          name: row.asset.name,
          kind: row.asset.kind,
          size: row.version?.size ?? null,
          sort_order: row.link.sortOrder,
        }),
      ),
      receipts: receiptRows.map(
        (row: {
          receipt: typeof transferReceipts.$inferSelect;
          upload: typeof uploadSessions.$inferSelect;
        }) => ({
          id: row.receipt.id,
          sender_name: row.receipt.senderName,
          filename: row.upload.clientFilename,
          size: row.upload.size,
          status: row.upload.status,
          asset_id: row.receipt.assetId,
          created_at: row.receipt.createdAt,
        }),
      ),
    });
  });

  api.patch("/transfers/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(
      transfer.projectId,
      actor,
      transferRoleFor(transfer.kind),
    );
    const body = await jsonBody(c, bodies.transferPatch);
    if (body.folder_id)
      await requireDestinationFolder(transfer.projectId, body.folder_id);
    await env.db
      .update(transfers)
      .set({
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.message !== undefined ? { message: body.message } : {}),
        ...(body.passphrase !== undefined
          ? {
              passphraseHash: body.passphrase
                ? await env.hasher.hash(body.passphrase)
                : null,
            }
          : {}),
        ...(body.expires_at !== undefined
          ? { expiresAt: body.expires_at }
          : {}),
        ...(body.byte_cap !== undefined && transfer.kind === "request"
          ? {
              byteCap: body.byte_cap ?? DEFAULT_TRANSFER_REQUEST_BYTE_CAP,
            }
          : {}),
        ...(body.folder_id !== undefined && transfer.kind === "request"
          ? { folderId: body.folder_id }
          : {}),
        ...(body.revoked !== undefined
          ? { revokedAt: body.revoked ? env.clock.now() : null }
          : {}),
      })
      .where(eq(transfers.id, transfer.id))
      .run();
    const updated = await transferById(transfer.id);
    const counts = (await transferCountsFor([transfer.id])).get(transfer.id);
    return c.json(transferWire(updated, counts));
  });

  api.delete("/transfers/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(
      transfer.projectId,
      actor,
      transferRoleFor(transfer.kind),
    );
    await env.db.delete(transfers).where(eq(transfers.id, transfer.id)).run();
    return c.body(null, 204);
  });

  /* The access record is the owner's, not the room's: a viewer on the project
     can see that a transfer exists, but who opened it and what they took is
     for whoever is answerable for the link. */
  const requireTransferAudit = async (
    c: Context<{ Variables: Variables }>,
    id: string,
  ): Promise<typeof transfers.$inferSelect> => {
    const actor = userFromContext(c);
    const transfer = await transferById(id);
    await requireProject(
      transfer.projectId,
      actor,
      transferRoleFor(transfer.kind),
    );
    return transfer;
  };

  api.get("/transfers/:id/visits", requireAuth, async (c) => {
    const transfer = await requireTransferAudit(c, c.req.param("id"));
    const visitRows = await env.db
      .select()
      .from(transferVisits)
      .where(eq(transferVisits.transferId, transfer.id))
      .orderBy(desc(transferVisits.id))
      .all();
    const downloadRows = await env.db
      .select({ visitId: transferDownloads.visitId })
      .from(transferDownloads)
      .where(eq(transferDownloads.transferId, transfer.id))
      .all();
    const takenBy = new Map<string, number>();
    for (const row of downloadRows)
      if (row.visitId)
        takenBy.set(row.visitId, (takenBy.get(row.visitId) ?? 0) + 1);
    return c.json({
      items: visitRows.map((visit) => ({
        id: visit.id,
        name: visit.name,
        first_seen_at: visit.firstSeenAt,
        last_seen_at: visit.lastSeenAt,
        user_agent: visit.userAgent,
        ip: visit.ip,
        download_count: takenBy.get(visit.id) ?? 0,
      })),
    });
  });

  api.get("/transfers/:id/downloads", requireAuth, async (c) => {
    const transfer = await requireTransferAudit(c, c.req.param("id"));
    const rows = await env.db
      .select()
      .from(transferDownloads)
      .where(eq(transferDownloads.transferId, transfer.id))
      .orderBy(desc(transferDownloads.id))
      .all();
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        visit_id: row.visitId,
        name: row.name,
        asset_id: row.assetId,
        filename: row.filename,
        kind: row.kind,
        bytes: row.bytes,
        user_agent: row.userAgent,
        ip: row.ip,
        created_at: row.createdAt,
      })),
    });
  });

  api.post("/transfers/:id/items", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    if (transfer.kind !== "package")
      throw errors.validation("Only a package carries files.");
    await requireProject(transfer.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.transferItemsAdd);
    const allowedAssets = await env.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(eq(assets.projectId, transfer.projectId), isNull(assets.deletedAt)),
      )
      .all();
    const allowed = new Set(
      allowedAssets.map((asset: { id: string }) => asset.id),
    );
    if (body.asset_ids.some((id) => !allowed.has(id)))
      throw errors.validation(
        "Every packaged file must belong to the project.",
      );
    const existing = await env.db
      .select({
        assetId: transferItems.assetId,
        sortOrder: transferItems.sortOrder,
      })
      .from(transferItems)
      .where(eq(transferItems.transferId, transfer.id))
      .all();
    const present = new Set(
      existing.map((row: { assetId: string }) => row.assetId),
    );
    let next =
      existing.reduce(
        (max: number, row: { sortOrder: number }) =>
          Math.max(max, row.sortOrder),
        -1,
      ) + 1;
    let added = 0;
    for (const assetId of body.asset_ids) {
      if (present.has(assetId)) continue;
      await env.db
        .insert(transferItems)
        .values({ transferId: transfer.id, assetId, sortOrder: next })
        .run();
      present.add(assetId);
      next += 1;
      added += 1;
    }
    const counts = (await transferCountsFor([transfer.id])).get(transfer.id);
    return c.json({ transfer: transferWire(transfer, counts), added });
  });

  api.delete("/transfers/:id/items/:assetId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const transfer = await transferById(c.req.param("id"));
    await requireProject(transfer.projectId, actor, "manager");
    await env.db
      .delete(transferItems)
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          eq(transferItems.assetId, c.req.param("assetId")),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  /* ------------------------- Transfers, public ------------------------- */

  const liveTransferBySlug = async (slug: string) => {
    const row = (
      await env.db
        .select()
        .from(transfers)
        .where(eq(transfers.slug, slug))
        .limit(1)
        .all()
    )[0];
    if (
      !row ||
      row.revokedAt ||
      (row.expiresAt !== null && row.expiresAt <= env.clock.now())
    )
      throw errors.notFound("Transfer is unavailable.");
    return row;
  };

  const transferCookie = (transferId: string): string =>
    `ol_transfer_${transferId}`;

  /**
   * Whether this transfer's project records the addresses of the people who
   * use its links. Off unless the project turns it on: a link handed to a
   * client should not start logging IPs because the software felt like it.
   */
  const projectRecordsIps = async (projectId: string): Promise<boolean> => {
    const project = (
      await env.db
        .select({ settingsJson: projects.settingsJson })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all()
    )[0];
    return parseJsonObject(project?.settingsJson).record_transfer_ips === true;
  };

  const issueTransferGrant = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
    name: string,
  ): Promise<void> => {
    /* The grant carries an unguessable key rather than only a name, so the
       visit it belongs to can be found again on every later request. The name
       stays in the token too: an old cookie issued before this table existed
       still identifies its holder, it just has no visit to update. */
    const grantKey = base64UrlEncode(randomBytes(18));
    const now = env.clock.now();
    await env.db
      .insert(transferVisits)
      .values({
        id: env.ids.ulid(),
        transferId: transfer.id,
        grantKey,
        name,
        userAgent: c.req.header("user-agent") ?? null,
        ip: (await projectRecordsIps(transfer.projectId))
          ? clientIp(c, env)
          : null,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    const signed = await new SignJWT({
      transfer_id: transfer.id,
      name,
      grant_key: grantKey,
      passphrase_tag: await sha256Hex(transfer.passphraseHash ?? ""),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    setCookie(c, transferCookie(transfer.id), signed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: env.config.cookieSecure,
      maxAge: 86_400,
      path: "/",
    });
  };

  const transferGrantFor = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
  ): Promise<{ name: string; visitId: string | null } | undefined> => {
    const signed = getCookie(c, transferCookie(transfer.id));
    if (!signed) return undefined;
    try {
      const verified = await jwtVerify(
        signed,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.transfer_id !== transfer.id ||
        typeof verified.payload.name !== "string" ||
        verified.payload.passphrase_tag !==
          (await sha256Hex(transfer.passphraseHash ?? ""))
      )
        return undefined;
      const grantKey =
        typeof verified.payload.grant_key === "string"
          ? verified.payload.grant_key
          : null;
      if (!grantKey) return { name: verified.payload.name, visitId: null };
      const visit = (
        await env.db
          .select()
          .from(transferVisits)
          .where(
            and(
              eq(transferVisits.transferId, transfer.id),
              eq(transferVisits.grantKey, grantKey),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!visit) return { name: verified.payload.name, visitId: null };
      const now = env.clock.now();
      if (visit.lastSeenAt <= now - PRESENCE_WRITE_INTERVAL_MS)
        await env.db
          .update(transferVisits)
          .set({ lastSeenAt: now })
          .where(
            and(
              eq(transferVisits.id, visit.id),
              lt(
                transferVisits.lastSeenAt,
                now - PRESENCE_WRITE_INTERVAL_MS + 1,
              ),
            ),
          )
          .run();
      return { name: visit.name, visitId: visit.id };
    } catch {
      return undefined;
    }
  };

  const requireTransferGrant = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
  ): Promise<{ name: string; visitId: string | null }> => {
    const grant = await transferGrantFor(c, transfer);
    if (!grant) throw errors.unauthorized();
    return grant;
  };

  /**
   * Record a file or an archive leaving. The filename is copied in rather than
   * joined out later: the record has to outlive the asset it names.
   */
  const recordTransferDownload = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
    grant: { name: string; visitId: string | null },
    entry: {
      kind: "file" | "zip";
      assetId?: string | null;
      filename?: string | null;
      bytes?: number;
    },
  ): Promise<void> => {
    await env.db
      .insert(transferDownloads)
      .values({
        id: env.ids.ulid(),
        transferId: transfer.id,
        visitId: grant.visitId,
        name: grant.name,
        assetId: entry.assetId ?? null,
        filename: entry.filename ?? "",
        kind: entry.kind,
        bytes: entry.bytes ?? 0,
        userAgent: c.req.header("user-agent") ?? null,
        ip: (await projectRecordsIps(transfer.projectId))
          ? clientIp(c, env)
          : null,
        createdAt: env.clock.now(),
      })
      .run();
  };

  const receivedBytesFor = async (transferId: string): Promise<number> =>
    (await transferCountsFor([transferId])).get(transferId)?.receivedBytes ?? 0;

  interface PackageFile {
    asset_id: string;
    name: string;
    kind: "video" | "audio" | "image" | "pdf" | "file";
    size: number | null;
    checksum_crc32c: string | null;
    version: typeof assetVersions.$inferSelect | null;
  }

  const packageFilesFor = async (
    transfer: typeof transfers.$inferSelect,
  ): Promise<PackageFile[]> => {
    const rows = await env.db
      .select({ link: transferItems, asset: assets, version: assetVersions })
      .from(transferItems)
      .innerJoin(assets, eq(transferItems.assetId, assets.id))
      .leftJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(asc(transferItems.sortOrder))
      .all();
    return rows.map(
      (row: {
        link: typeof transferItems.$inferSelect;
        asset: typeof assets.$inferSelect;
        version: typeof assetVersions.$inferSelect | null;
      }) => ({
        asset_id: row.asset.id,
        name: row.asset.name,
        kind: row.asset.kind,
        size: row.version?.size ?? null,
        checksum_crc32c: row.version?.checksumCrc32c || null,
        version: row.version,
      }),
    );
  };

  const publicTransferWire = (
    transfer: typeof transfers.$inferSelect,
    receivedBytes: number,
  ) => ({
    slug: transfer.slug,
    kind: transfer.kind,
    title: transfer.title,
    message: transfer.message,
    requires_passphrase: transfer.passphraseHash !== null,
    expires_at: transfer.expiresAt,
    byte_cap: transfer.byteCap,
    received_bytes: receivedBytes,
  });

  const publicTransferShell = async (
    c: Context<{ Variables: Variables }>,
    transfer: typeof transfers.$inferSelect,
    grantOverride?: { name: string },
  ) => {
    const grant = grantOverride ?? (await transferGrantFor(c, transfer));
    const authorized = grant !== undefined;
    const files =
      authorized && transfer.kind === "package"
        ? (await packageFilesFor(transfer)).map((file) => ({
            asset_id: file.asset_id,
            name: file.name,
            kind: file.kind,
            size: file.size,
            checksum_crc32c: file.checksum_crc32c,
          }))
        : [];
    const receivedBytes =
      transfer.kind === "request" ? await receivedBytesFor(transfer.id) : 0;
    return {
      transfer: publicTransferWire(transfer, receivedBytes),
      authorized,
      files,
    };
  };

  api.get("/t/:slug", async (c) =>
    c.json(
      await publicTransferShell(
        c,
        await liveTransferBySlug(c.req.param("slug")),
      ),
    ),
  );

  api.post("/t/:slug/access", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    const ip = clientIp(c, env);
    await hitRateLimit(
      `transfer_access:${transfer.id}:${ip}`,
      20,
      5 * 60 * 1000,
    );
    const body = await jsonBody(c, bodies.transferAccess);
    if (
      transfer.passphraseHash &&
      (!body.passphrase ||
        !(await env.hasher.verify(body.passphrase, transfer.passphraseHash)))
    )
      throw errors.invalidCredentials();
    const name = body.name.trim();
    await issueTransferGrant(c, transfer, name);
    return c.json(await publicTransferShell(c, transfer, { name }));
  });

  const notifyTransferDownloaded = async (
    transfer: typeof transfers.$inferSelect,
    name: string,
    file: string | null,
  ): Promise<void> => {
    await createNotifications({
      projectId: transfer.projectId,
      actorUserId: null,
      recipients: [transfer.createdBy],
      kind: "transfer.downloaded",
      payload: {
        transfer_id: transfer.id,
        transfer_title: transfer.title,
        project_id: transfer.projectId,
        name,
        file,
      },
    });
    await appendProjectEvent(transfer.projectId, "transfer.downloaded", {
      transfer_id: transfer.id,
      name,
      file,
    });
  };

  api.post("/t/:slug/files/:assetId/download", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    if (transfer.kind !== "package") throw errors.notFound();
    const grant = await requireTransferGrant(c, transfer);
    const file = (await packageFilesFor(transfer)).find(
      (candidate) => candidate.asset_id === c.req.param("assetId"),
    );
    if (!file || !file.version) throw errors.notFound();
    const token = await new SignJWT({
      transfer_id: transfer.id,
      blob_key: file.version.originalBlobKey,
      disposition: attachmentDisposition(file.version.originalFilename),
      passphrase_tag: await sha256Hex(transfer.passphraseHash ?? ""),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(DOWNLOAD_TOKEN_TTL)
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    await notifyTransferDownloaded(transfer, grant.name, file.name);
    await recordTransferDownload(c, transfer, grant, {
      kind: "file",
      assetId: file.asset_id,
      filename: file.name,
      bytes: file.version.size,
    });
    return c.json({
      url: `/api/v1/t/${transfer.slug}/file?token=${encodeURIComponent(token)}`,
      expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
  });

  api.get("/t/:slug/file", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    const token = c.req.query("token");
    if (!token || !env.blobStore) throw errors.unauthorized();
    let blobKey: string;
    let disposition: string | undefined;
    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(env.config.SECRET_KEY),
      );
      if (
        verified.payload.transfer_id !== transfer.id ||
        typeof verified.payload.blob_key !== "string" ||
        verified.payload.passphrase_tag !==
          (await sha256Hex(transfer.passphraseHash ?? ""))
      )
        throw new Error("Token claims do not match this transfer.");
      blobKey = verified.payload.blob_key;
      if (typeof verified.payload.disposition === "string")
        disposition = sanitizeDisposition(verified.payload.disposition);
    } catch {
      throw errors.unauthorized();
    }
    const visible = await env.db
      .select({ id: assets.id })
      .from(transferItems)
      .innerJoin(assets, eq(transferItems.assetId, assets.id))
      .innerJoin(assetVersions, eq(assets.currentVersionId, assetVersions.id))
      .where(
        and(
          eq(transferItems.transferId, transfer.id),
          eq(assetVersions.originalBlobKey, blobKey),
          isNull(assets.deletedAt),
          isNull(assetVersions.deletedAt),
        ),
      )
      .limit(1)
      .all();
    if (!visible.length) throw errors.notFound();
    return serveBlob(c, blobKey, disposition);
  });

  api.get("/t/:slug/zip", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    if (transfer.kind !== "package") throw errors.notFound();
    const grant = await requireTransferGrant(c, transfer);
    const store = requireBlobStore();
    const files = await packageFilesFor(transfer);
    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const file of files) {
      const version = file.version;
      if (!version) continue;
      let name = zipEntryName(version.originalFilename);
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
    if (!entries.length) throw errors.notFound("The package has no files.");
    /* A Range request is the same download resuming, not a second one. */
    if (!c.req.header("range")) {
      await notifyTransferDownloaded(transfer, grant.name, null);
      await recordTransferDownload(c, transfer, grant, {
        kind: "zip",
        filename: `${transfer.title} (${String(entries.length)} ${entries.length === 1 ? "file" : "files"})`,
        bytes: entries.reduce((total, entry) => total + entry.size, 0),
      });
    }
    const zipName = `${
      transfer.title
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "package"
    }.zip`;
    return serveZip(c, entries, zipName);
  });

  const transferUploadWire = (upload: typeof uploadSessions.$inferSelect) => ({
    id: upload.id,
    filename: upload.clientFilename,
    relative_path: upload.relativePath,
    size: upload.size,
    checksum_crc32c: upload.checksumCrc32c,
    status: upload.status,
    created_at: upload.createdAt,
    completed_at: upload.completedAt,
  });

  /** The upload must be one this transfer's link created. */
  const findTransferUpload = async (
    transfer: typeof transfers.$inferSelect,
    uploadId: string,
  ): Promise<{
    upload: typeof uploadSessions.$inferSelect;
    receipt: typeof transferReceipts.$inferSelect;
  }> => {
    const receipt = (
      await env.db
        .select()
        .from(transferReceipts)
        .where(
          and(
            eq(transferReceipts.transferId, transfer.id),
            eq(transferReceipts.uploadSessionId, uploadId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!receipt) throw errors.notFound("Upload was not found.");
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .limit(1)
        .all()
    )[0];
    if (!upload) throw errors.notFound("Upload was not found.");
    return { upload, receipt };
  };

  api.post("/t/:slug/uploads", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    if (transfer.kind !== "request") throw errors.notFound();
    const grant = await requireTransferGrant(c, transfer);
    const ip = clientIp(c, env);
    await hitRateLimit(
      `transfer_upload:${transfer.id}:${ip}`,
      240,
      60 * 60 * 1000,
    );
    const body = await jsonBody(c, bodies.transferUploadCreate);
    if ((body.relative_path ?? "").split(/[\\/]/).includes(".."))
      throw errors.validation("Relative path cannot contain parent segments.");
    const filename = storedFilename(body.filename);
    if (transfer.byteCap !== null) {
      const used = await receivedBytesFor(transfer.id);
      if (used + body.size > transfer.byteCap) throw errors.payloadTooLarge();
    }
    const project = (
      await env.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, transfer.projectId))
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.notFound("Transfer is unavailable.");
    const uploadId = env.ids.ulid();
    const blobKey = `${project.workspaceId}/${transfer.projectId}/uploads/${uploadId}/${filename}`;
    const now = env.clock.now();
    await env.db
      .insert(uploadSessions)
      .values({
        id: uploadId,
        workspaceId: project.workspaceId,
        projectId: transfer.projectId,
        createdBy: transfer.createdBy,
        clientFilename: filename,
        relativePath: body.relative_path ?? "",
        size: body.size,
        checksumCrc32c: body.checksum_crc32c ?? null,
        blobKey,
        uploadId: null,
        partSize: null,
        status: "pending",
        createdAt: now,
        completedAt: null,
      })
      .run();
    try {
      await env.db
        .insert(transferReceipts)
        .values({
          id: env.ids.ulid(),
          transferId: transfer.id,
          uploadSessionId: uploadId,
          senderName: grant.name,
          assetId: null,
          createdAt: now,
        })
        .run();
    } catch (error) {
      await env.db
        .delete(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .run();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("transfer byte limit reached"))
        throw errors.payloadTooLarge();
      throw error;
    }
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, uploadId))
        .limit(1)
        .all()
    )[0];
    if (!upload) throw errors.internal();
    return c.json({ upload: transferUploadWire(upload) }, 201);
  });

  api.post("/t/:slug/uploads/:id/multipart", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    await requireTransferGrant(c, transfer);
    const { upload } = await findTransferUpload(transfer, c.req.param("id"));
    const started = await startMultipart(upload);
    return c.json({
      upload: transferUploadWire(started.upload),
      ...(started.uploadId
        ? { upload_id: started.uploadId, part_size: started.partSize }
        : {}),
    });
  });

  api.get("/t/:slug/uploads/:id/parts", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    await requireTransferGrant(c, transfer);
    const { upload } = await findTransferUpload(transfer, c.req.param("id"));
    return c.json(await listPartsResponse(upload));
  });

  api.put("/t/:slug/uploads/:id/parts/:partNo", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    await requireTransferGrant(c, transfer);
    const { upload } = await findTransferUpload(transfer, c.req.param("id"));
    c.header("etag", await storePart(c, upload));
    return c.body(null, 204);
  });

  api.post("/t/:slug/uploads/:id/complete", async (c) => {
    const transfer = await liveTransferBySlug(c.req.param("slug"));
    const grant = await requireTransferGrant(c, transfer);
    const found = await findTransferUpload(transfer, c.req.param("id"));
    if (found.upload.status === "completed")
      return c.json(
        {
          upload: transferUploadWire(found.upload),
          asset_id: found.receipt.assetId,
        },
        202,
      );
    const body = await jsonBody(c, bodies.uploadComplete);
    const completed = await finishUpload(found.upload, body);
    /* The received file lands as an asset immediately: media probes and
       transcodes exactly as a member upload would, so the request's yield
       is review-ready, not a pile of blobs. */
    const existingVersion = await env.db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(eq(assetVersions.uploadSessionId, completed.id))
      .limit(1)
      .all();
    let assetId = found.receipt.assetId;
    if (!existingVersion.length) {
      /* The destination folder may have been deleted since the link was
         minted; received files then land at the project root. */
      let folderId = transfer.folderId;
      if (folderId) {
        const folder = (
          await env.db
            .select({ id: folders.id })
            .from(folders)
            .where(eq(folders.id, folderId))
            .limit(1)
            .all()
        )[0];
        if (!folder) folderId = null;
      }
      const landed = await landUploadAsAsset(completed, {
        folderId,
        uploadedBy: transfer.createdBy,
      });
      assetId = landed.assetId;
      await env.db
        .update(transferReceipts)
        .set({ assetId })
        .where(eq(transferReceipts.id, found.receipt.id))
        .run();
      await createNotifications({
        projectId: transfer.projectId,
        actorUserId: null,
        recipients: [
          transfer.createdBy,
          ...(await projectManagerIds(transfer.projectId)),
        ],
        kind: "transfer.received",
        payload: {
          transfer_id: transfer.id,
          transfer_title: transfer.title,
          project_id: transfer.projectId,
          sender_name: grant.name,
          filename: completed.clientFilename,
          asset_id: assetId,
        },
      });
      await appendProjectEvent(transfer.projectId, "transfer.received", {
        transfer_id: transfer.id,
        sender_name: grant.name,
        asset_id: assetId,
      });
    }
    return c.json(
      { upload: transferUploadWire(completed), asset_id: assetId },
      202,
    );
  });
};
