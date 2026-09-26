import { requireAuth } from "../auth.js";
import {
  userFromContext,
  jsonBody,
  parseJsonObject,
  readBodyBytes,
  base62,
} from "../helpers.js";
import { bodies } from "../schemas.js";
import {
  assets,
  shares,
  shareAssets,
  projects,
  shareViewers,
  folders,
  renditions,
} from "@onelight/db/schema";
import { and, eq, isNull, desc, asc, sql } from "drizzle-orm";
import {
  errors,
  sha256Hex,
  projectRoleAtLeast,
  renderEmail,
  mailHeaders,
} from "@onelight/core";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Access } from "../operation/access.js";
import { shareWire } from "../wire.js";
import type { Mail } from "../operation/mail.js";
import type { Identity } from "../operation/identity.js";
import type { Activity } from "../operation/activity.js";
import type { Shares } from "../operation/shares.js";
import type { Blobs } from "../operation/blobs.js";

export const registerSharesRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    mail,
    identity,
    activity,
    sharesOps,
    blobs,
  }: {
    access: Access;
    mail: Mail;
    identity: Identity;
    activity: Activity;
    sharesOps: Shares;
    blobs: Blobs;
  },
) => {
  const { requireProject, newSharePublicId, shareParam, workspaceFor } = access;
  const { mailControl, mailStatus } = mail;
  const { hitRateLimit } = identity;
  const { audit } = activity;
  const { LOGO_TYPES, LOGO_MAX_BYTES, logoKeyOf } = sharesOps;
  const { deleteBlobQuietly } = blobs;

  api.post("/shares", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.shareCreate);
    await requireProject(body.project_id, actor, "manager");
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
      throw errors.validation("Every shared asset must belong to the project.");
    const id = env.ids.ulid();
    // The link reads like what it opens: the title, then 14 base62 chars
    // (about 83 bits) so the URL stays the secret it is documented to be.
    const readable = body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
    const slug = readable ? `${readable}-${base62(14)}` : base62(22);
    const now = env.clock.now();
    const watermarkJson = body.watermark_spec
      ? JSON.stringify(body.watermark_spec)
      : null;
    await env.db
      .insert(shares)
      .values({
        id,
        publicId: await newSharePublicId(),
        projectId: body.project_id,
        slug,
        kind: body.kind,
        title: body.title.trim(),
        layout: body.layout,
        passphraseHash: body.passphrase
          ? await env.hasher.hash(body.passphrase)
          : null,
        expiresAt: body.expires_at ?? null,
        allowDownload: body.allow_download,
        allowComments: body.allow_comments,
        allowApprovals: body.allow_approvals ?? body.kind !== "presentation",
        showAllVersions: body.show_all_versions,
        watermarkSpecJson: watermarkJson,
        watermarkSpecHash: watermarkJson
          ? await sha256Hex(watermarkJson)
          : null,
        brandJson: body.brand ? JSON.stringify(body.brand) : null,
        createdBy: actor.id,
        folderId: body.folder_id ?? null,
        revokedAt: null,
        createdAt: now,
      })
      .run();
    for (const [index, assetId] of body.asset_ids.entries())
      await env.db
        .insert(shareAssets)
        .values({ shareId: id, assetId, sortOrder: index })
        .run();
    const share = (
      await env.db.select().from(shares).where(eq(shares.id, id)).limit(1).all()
    )[0];
    if (!share) throw errors.internal();
    return c.json(
      {
        share: shareWire(share),
        url: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/s/${slug}`,
      },
      201,
    );
  });

  api.get("/shares", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.query("project_id");
    if (projectId) await requireProject(projectId, actor, "viewer");
    const rows = await env.db
      .select()
      .from(shares)
      .innerJoin(projects, eq(shares.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          projectId ? eq(shares.projectId, projectId) : undefined,
        ),
      )
      .orderBy(desc(shares.id))
      .all();
    return c.json({
      items: rows.map((row: { shares: typeof shares.$inferSelect }) =>
        shareWire(row.shares),
      ),
    });
  });

  api.get("/shares/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const share = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, await shareParam(c.req.param("id"))))
        .limit(1)
        .all()
    )[0];
    if (!share) throw errors.notFound();
    await requireProject(share.projectId, actor, "viewer");
    const links = await env.db
      .select()
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .orderBy(asc(shareAssets.sortOrder))
      .all();
    return c.json({
      ...shareWire(share),
      assets: links.map((link: typeof shareAssets.$inferSelect) => ({
        share_id: link.shareId,
        asset_id: link.assetId,
        sort_order: link.sortOrder,
      })),
    });
  });

  // Share viewer roster: who opened the share and when. Restricted to the
  // share owner or a project manager; the signed viewer_key never leaves
  // the server.
  api.get("/shares/:id/viewers", requireAuth, async (c) => {
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
    // requireProject 404s cross-workspace and non-member-on-restricted
    // callers before the owner-or-manager rule applies.
    const { role } = await requireProject(share.projectId, actor, "viewer");
    if (share.createdBy !== actor.id && !projectRoleAtLeast(role, "manager"))
      throw errors.forbidden();
    const rows = await env.db
      .select()
      .from(shareViewers)
      .where(eq(shareViewers.shareId, share.id))
      .orderBy(desc(shareViewers.id))
      .all();
    return c.json({
      items: rows.map((viewer: typeof shareViewers.$inferSelect) => ({
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        first_seen_at: viewer.firstSeenAt,
        last_seen_at: viewer.lastSeenAt,
        user_agent: viewer.userAgent,
      })),
    });
  });

  api.patch("/shares/:id", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.sharePatch);
    if (body.folder_id) {
      const folder = (
        await env.db
          .select({ projectId: folders.projectId, kind: folders.kind })
          .from(folders)
          .where(eq(folders.id, body.folder_id))
          .limit(1)
          .all()
      )[0];
      if (
        !folder ||
        folder.projectId !== share.projectId ||
        folder.kind !== "shares"
      )
        throw errors.validation(
          "folder_id must name a shares folder in this project.",
        );
    }
    const watermarkJson =
      body.watermark_spec === undefined
        ? share.watermarkSpecJson
        : body.watermark_spec
          ? JSON.stringify(body.watermark_spec)
          : null;
    await env.db
      .update(shares)
      .set({
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.layout ? { layout: body.layout } : {}),
        ...(body.passphrase === undefined
          ? {}
          : {
              passphraseHash: body.passphrase
                ? await env.hasher.hash(body.passphrase)
                : null,
            }),
        ...(body.expires_at === undefined
          ? {}
          : { expiresAt: body.expires_at }),
        ...(body.allow_download ? { allowDownload: body.allow_download } : {}),
        // Explicit null files a share back under the Shares root, so it must
        // not be confused with "not mentioned".
        ...(body.folder_id === undefined ? {} : { folderId: body.folder_id }),
        ...(body.allow_comments === undefined
          ? {}
          : { allowComments: body.allow_comments }),
        ...(body.allow_approvals === undefined
          ? {}
          : { allowApprovals: body.allow_approvals }),
        ...(body.show_all_versions === undefined
          ? {}
          : { showAllVersions: body.show_all_versions }),
        ...(body.watermark_spec === undefined
          ? {}
          : {
              watermarkSpecJson: watermarkJson,
              watermarkSpecHash: watermarkJson
                ? await sha256Hex(watermarkJson)
                : null,
            }),
        ...(body.brand === undefined
          ? {}
          : {
              // The logo rides the brand row but is managed by its own
              // endpoints; a colour change must not silently drop the mark.
              brandJson: (() => {
                const kept = share.brandJson
                  ? parseJsonObject(share.brandJson).logo_key
                  : undefined;
                const next = {
                  ...(body.brand ?? {}),
                  ...(typeof kept === "string" ? { logo_key: kept } : {}),
                };
                return Object.keys(next).length ? JSON.stringify(next) : null;
              })(),
            }),
        ...(body.revoked ? { revokedAt: env.clock.now() } : {}),
      })
      .where(eq(shares.id, share.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(shares)
        .where(eq(shares.id, share.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    return c.json(shareWire(updated));
  });

  /* Add assets to a share that already exists. Without this, putting one more
     clip in front of a client meant building a second share with a second link
     -- so the project page could only ever offer "create a share", never "add
     to that one". */
  /* Send a share to the people it is for.

     Until now a link left Onelight by being copied into somebody else's email
     client, which means the client's first impression of the work was whatever
     that person typed at half past eleven at night. This is the same renderer
     everything else uses, so a review link arrives looking like the tool it
     opens.

     Two rules it keeps. A passphrase is never in the message: a link and its
     password in the same email is the password not existing. And an expiry is
     said out loud, because a client who opens it a week late deserves to know
     why nothing is there rather than thinking the tool is broken. */
  api.post("/shares/:id/email", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    if (share.revokedAt)
      throw errors.validation("That share has been revoked.");
    const body = await jsonBody(c, bodies.shareEmail);
    if (!mailControl || (await mailStatus()).state !== "ready")
      throw errors.validation(
        "Email is not configured on this Onelight, so a share cannot be sent from it.",
      );
    /* One person cannot turn a share into a mailing list. */
    await hitRateLimit(`share_email:user:${actor.id}`, 20, 60 * 60 * 1000);
    const project = (
      await env.db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, share.projectId))
        .limit(1)
        .all()
    )[0];
    const workspace = await workspaceFor(actor.workspaceId);
    const url = `${env.config.PUBLIC_URL.replace(/\/$/, "")}/s/${share.slug}`;
    const assetCount = (
      await env.db
        .select({ count: sql<number>`count(*)` })
        .from(shareAssets)
        .where(eq(shareAssets.shareId, share.id))
        .all()
    )[0];
    const items = Number(assetCount?.count ?? 0);
    const what = share.title ?? project?.name ?? "work";
    const facts: string[] = [
      `${String(items)} ${items === 1 ? "file" : "files"} to look at`,
    ];
    if (share.allowComments) facts.push("You can leave notes on the frame");
    if (share.allowApprovals) facts.push("You can approve or ask for changes");
    if (share.allowDownload !== "none")
      facts.push(
        share.allowDownload === "original"
          ? "Downloads are the original files"
          : "Downloads are review copies",
      );
    if (share.expiresAt)
      facts.push(
        `The link stops working on ${new Date(share.expiresAt).toISOString().slice(0, 10)}`,
      );
    if (share.passphraseHash)
      /* Named, never included: a link and its password in one message is the
         password not existing. */
      facts.push(`${actor.name} will send you the password for it separately`);
    const rendered = renderEmail({
      subject: `${actor.name} shared ${what} with you`,
      preheader: body.message?.trim()
        ? body.message.trim()
        : `${String(items)} ${items === 1 ? "file" : "files"} to review in Onelight.`,
      heading: `${actor.name} shared ${what} with you`,
      ...(workspace?.name ? { workspace: workspace.name } : {}),
      ...(body.message?.trim() ? { intro: body.message.trim() } : {}),
      sections: [
        {
          items: facts.map((fact) => ({ meta: fact, tone: "quiet" as const })),
        },
      ],
      action: { label: "Open the review", href: url },
      footer: [
        `Sent by ${actor.name} from Onelight. Replies to this message are not read; leave notes in the review itself.`,
      ],
    });
    for (const recipient of body.recipients) {
      try {
        await mailControl.send({
          to: recipient,
          ...rendered,
          headers: mailHeaders({
            publicUrl: env.config.PUBLIC_URL,
            messageKey: `share-${share.id}-${await sha256Hex(recipient)}`,
            threadKey: `share-${share.id}`,
          }),
        });
      } catch {
        /* One bad address must not stop the rest: the link still works and the
           sender can see who it reached in the audit log. */
      }
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "share.emailed",
      `share:${share.id}`,
      { recipients: body.recipients.length },
    );
    return c.json({ sent: body.recipients.length });
  });

  api.post("/shares/:id/assets", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.shareAssetsAdd);
    const allowed = new Set(
      (
        await env.db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.projectId, share.projectId),
              isNull(assets.deletedAt),
            ),
          )
          .all()
      ).map((asset: { id: string }) => asset.id),
    );
    if (body.asset_ids.some((id) => !allowed.has(id)))
      throw errors.validation("Every shared asset must belong to the project.");
    const existing = await env.db
      .select({
        assetId: shareAssets.assetId,
        sortOrder: shareAssets.sortOrder,
      })
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .all();
    const present = new Set(
      existing.map((link: { assetId: string }) => link.assetId),
    );
    // Adding what is already there is a no-op, not a conflict: this runs from a
    // multi-select where an overlap with the share's contents is ordinary.
    let sortOrder = existing.reduce(
      (highest: number, link: { sortOrder: number }) =>
        Math.max(highest, link.sortOrder + 1),
      0,
    );
    let added = 0;
    for (const assetId of body.asset_ids) {
      if (present.has(assetId)) continue;
      await env.db
        .insert(shareAssets)
        .values({ shareId: share.id, assetId, sortOrder })
        .run();
      present.add(assetId);
      sortOrder += 1;
      added += 1;
    }
    if (added > 0)
      await audit(
        actor.workspaceId,
        actor.id,
        "share.update",
        `share:${share.id}`,
      );
    return c.json({ share: shareWire(share), added });
  });

  /* Curation: a presentation is an ordered reel, so its order is a setting.
     The body names every asset currently in the share, in the order wanted;
     naming a different set is a mistake, not a merge. */
  api.patch("/shares/:id/assets", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    const body = await jsonBody(c, bodies.shareAssetsReorder);
    const existing = (await env.db
      .select({ assetId: shareAssets.assetId })
      .from(shareAssets)
      .where(eq(shareAssets.shareId, share.id))
      .all()) as Array<{ assetId: string }>;
    const current = new Set(existing.map((link) => link.assetId));
    const wanted = new Set(body.asset_ids);
    if (
      wanted.size !== body.asset_ids.length ||
      current.size !== wanted.size ||
      body.asset_ids.some((id) => !current.has(id))
    )
      throw errors.validation(
        "The order must name each asset in the share exactly once.",
      );
    for (const [index, assetId] of body.asset_ids.entries()) {
      await env.db
        .update(shareAssets)
        .set({ sortOrder: index })
        .where(
          and(
            eq(shareAssets.shareId, share.id),
            eq(shareAssets.assetId, assetId),
          ),
        )
        .run();
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "share.update",
      `share:${share.id}`,
    );
    return c.json({
      items: body.asset_ids.map((assetId, index) => ({
        asset_id: assetId,
        sort_order: index,
      })),
    });
  });

  api.delete("/shares/:id/assets/:assetId", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    const link = (
      await env.db
        .select({ assetId: shareAssets.assetId })
        .from(shareAssets)
        .where(
          and(
            eq(shareAssets.shareId, share.id),
            eq(shareAssets.assetId, c.req.param("assetId")),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!link) throw errors.notFound();
    await env.db
      .delete(shareAssets)
      .where(
        and(
          eq(shareAssets.shareId, share.id),
          eq(shareAssets.assetId, link.assetId),
        ),
      )
      .run();
    await audit(
      actor.workspaceId,
      actor.id,
      "share.update",
      `share:${share.id}`,
    );
    return c.body(null, 204);
  });

  api.put("/shares/:id/logo", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const contentType =
      (c.req.header("content-type") ?? "").split(";")[0] ?? "";
    const extension = LOGO_TYPES[contentType];
    if (!extension)
      throw errors.validation("The logo must be a PNG, JPEG, WebP, or SVG.");
    const bytes = await readBodyBytes(c, LOGO_MAX_BYTES);
    if (bytes.byteLength === 0) throw errors.validation("The logo is empty.");
    // A fresh key per upload, so the public URL changes and no cache can
    // serve the old mark; the replaced blob is deleted best-effort.
    const previous = logoKeyOf(share);
    const key = `${actor.workspaceId}/sharelogos/${share.id}-${env.ids.ulid()}.${extension}`;
    await env.blobStore.putStream(
      key,
      new Response(bytes).body as ReadableStream,
      { contentType, size: bytes.byteLength },
    );
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    await env.db
      .update(shares)
      .set({ brandJson: JSON.stringify({ ...brand, logo_key: key }) })
      .where(eq(shares.id, share.id))
      .run();
    await deleteBlobQuietly(previous);
    return c.json({ logo_url: `/api/v1/s/${share.slug}/logo` });
  });

  api.delete("/shares/:id/logo", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    await deleteBlobQuietly(logoKeyOf(share));
    const brand = share.brandJson ? parseJsonObject(share.brandJson) : {};
    delete brand.logo_key;
    await env.db
      .update(shares)
      .set({
        brandJson: Object.keys(brand).length ? JSON.stringify(brand) : null,
      })
      .where(eq(shares.id, share.id))
      .run();
    return c.body(null, 204);
  });

  api.delete("/shares/:id", requireAuth, async (c) => {
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
    await requireProject(share.projectId, actor, "manager");
    await env.db
      .update(shares)
      .set({ revokedAt: env.clock.now() })
      .where(eq(shares.id, share.id))
      .run();
    /* Drop the burned-in watermark renditions this share caused.
       renditions.share_id carries no foreign key -- it cannot, since a
       rendition may belong to no share at all -- so nothing else would ever
       remove them, and a revoked share can never be watched again. They were
       minutes of encoding and hundreds of megabytes each, pinned forever by a
       row that exists only to say "revoked". The blobs become unreferenced and
       the sweeper reclaims them; a later share re-renders its own. */
    await env.db
      .delete(renditions)
      .where(eq(renditions.shareId, share.id))
      .run();
    await audit(
      actor.workspaceId,
      actor.id,
      "share.revoke",
      `share:${share.id}`,
    );
    return c.body(null, 204);
  });
};
