import { errors } from "@onelight/core";
import {
  assets,
  comments,
  users,
  assetVersions,
  projects,
  commentAttachments,
} from "@onelight/db/schema";
import { and, eq, isNull, asc, desc, ne } from "drizzle-orm";
import { clientIp, jsonBody } from "../helpers.js";
import { bodies } from "../schemas.js";
import { nextAssetStamp } from "../operation/asset-state.js";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Shares } from "../operation/shares.js";
import type { Comments } from "../operation/comments.js";
import { publicCommentWire } from "../wire.js";
import type { Identity } from "../operation/identity.js";
import type { Activity } from "../operation/activity.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";

export const registerShareCommentsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    sharesOps,
    commentsOps,
    identity,
    activity,
    media,
    blobs,
  }: {
    sharesOps: Shares;
    commentsOps: Comments;
    identity: Identity;
    activity: Activity;
    media: Media;
    blobs: Blobs;
  },
) => {
  const { publicShare, shareBySlug, shareCommentForViewer, NO_ASSET } =
    sharesOps;
  const {
    attachmentsFor,
    validateCommentAnchor,
    deleteAttachmentsForComment,
    storeCommentAttachment,
    attachmentFileFrom,
  } = commentsOps;
  const { userAvatarResponse, hitRateLimit } = identity;
  const {
    createNotifications,
    projectManagerIds,
    notificationPreview,
    appendProjectEvent,
    threadParticipantIds,
    notifyApprovalChange,
  } = activity;
  const { publicMediaUrl, DOWNLOAD_TOKEN_TTL_MS } = media;
  const { attachmentDisposition, deleteBlobQuietly } = blobs;

  api.get("/s/:slug/assets/:assetId/comments", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
      { assetId: c.req.param("assetId") },
    );
    if (!projection.viewer) throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset || !asset.currentVersionId) throw errors.notFound();
    const rows = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, asset.currentVersionId),
          isNull(comments.deletedAt),
          eq(comments.internal, false),
        ),
      )
      .orderBy(asc(comments.frameIn), desc(comments.id))
      .all();
    const attached = await attachmentsFor(
      rows.map((comment: typeof comments.$inferSelect) => comment.id),
    );
    return c.json({
      items: rows.map((comment: typeof comments.$inferSelect) => ({
        ...publicCommentWire(comment, projection.share.slug),
        attachments: attached.get(comment.id) ?? [],
        /* Whether this viewer wrote it: the room shows Edit and Delete only
           where the server would allow them. The key itself never leaves. */
        mine:
          comment.viewerKey !== null &&
          comment.viewerKey === projection.viewer?.viewerKey,
      })),
    });
  });

  api.get("/s/:slug/comments/:commentId/avatar", async (c) => {
    const projection = await publicShare(
      c,
      await shareBySlug(c.req.param("slug")),
    );
    if (!projection.viewer) throw errors.unauthorized();
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.id, c.req.param("commentId")),
            eq(comments.internal, false),
            isNull(comments.deletedAt),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (
      !comment?.authorUserId ||
      !projection.assets.some(
        (asset: typeof assets.$inferSelect & { sort_order: number }) =>
          asset.currentVersionId === comment.versionId,
      )
    )
      throw errors.notFound();
    const author = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, comment.authorUserId))
        .limit(1)
        .all()
    )[0];
    if (!author) throw errors.notFound();
    /* A share URL carries no stable user id and is scoped through the comment.
       Keep the cache short so an avatar change reaches an open client review. */
    return userAvatarResponse(author, "private, max-age=300");
  });

  api.post("/s/:slug/assets/:assetId/comments", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    const ip = clientIp(c, env);
    await hitRateLimit(`share_comment:${share.id}:${ip}`, 30, 5 * 60 * 1000);
    const projection = await publicShare(c, share, {
      assetId: c.req.param("assetId"),
    });
    if (!projection.viewer || !projection.viewer.viewerKey)
      throw errors.unauthorized();
    const asset = projection.assets.find(
      (candidate: typeof assets.$inferSelect & { sort_order: number }) =>
        candidate.id === c.req.param("assetId"),
    );
    if (!asset || !asset.currentVersionId) throw errors.notFound();
    const body = await jsonBody(c, bodies.shareCommentCreate);
    validateCommentAnchor(body);
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: asset.currentVersionId,
        parentId: null,
        authorUserId: null,
        authorName: projection.viewer.name,
        authorEmail: projection.viewer.email,
        viewerKey: projection.viewer.viewerKey,
        frameIn: body.frame_in ?? null,
        frameOut: body.frame_out ?? null,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson: null,
        pageNo: null,
        internal: false,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: now,
        editedAt: null,
      })
      .run();
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!comment) throw errors.internal();
    // Share-viewer comments notify the same recipients as member comments;
    // the actor fields come from the named viewer (who has no user id, so
    // there is no self to exclude).
    const commentedVersion = (
      await env.db
        .select({ uploadedBy: assetVersions.uploadedBy })
        .from(assetVersions)
        .where(eq(assetVersions.id, asset.currentVersionId))
        .limit(1)
        .all()
    )[0];
    await createNotifications({
      projectId: share.projectId,
      actorUserId: null,
      recipients: [
        commentedVersion?.uploadedBy,
        ...(await projectManagerIds(share.projectId)),
      ],
      kind: "comment.created",
      payload: {
        project_id: share.projectId,
        asset_id: asset.id,
        asset_name: asset.name,
        version_id: asset.currentVersionId,
        comment_id: id,
        actor_name:
          projection.viewer.name ?? projection.viewer.email ?? "Share viewer",
        preview: notificationPreview(body.body_text.trim()),
      },
    });
    // Share-viewer comments feed the same live stream as member comments.
    await appendProjectEvent(share.projectId, "comment.created", {
      comment_id: id,
      version_id: asset.currentVersionId,
      frame_in: comment.frameIn,
    });
    return c.json(publicCommentWire(comment, share.slug), 201);
  });

  api.patch("/s/:slug/comments/:commentId", async (c) => {
    const { share, comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    const body = await jsonBody(c, bodies.shareCommentPatch);
    validateCommentAnchor(body);
    await env.db
      .update(comments)
      .set({
        bodyText: body.body_text.trim(),
        ...(body.annotation === undefined
          ? {}
          : { annotationJson: JSON.stringify(body.annotation) }),
        editedAt: env.clock.now(),
      })
      .where(eq(comments.id, comment.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await appendProjectEvent(share.projectId, "comment.updated", {
      comment_id: updated.id,
      version_id: updated.versionId,
      frame_in: updated.frameIn,
    });
    return c.json(publicCommentWire(updated, share.slug));
  });

  api.delete("/s/:slug/comments/:commentId", async (c) => {
    const { share, comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    await deleteAttachmentsForComment(comment.id);
    await env.db
      .update(comments)
      .set({ deletedAt: env.clock.now() })
      .where(eq(comments.id, comment.id))
      .run();
    await appendProjectEvent(share.projectId, "comment.deleted", {
      comment_id: comment.id,
      version_id: comment.versionId,
    });
    return c.body(null, 204);
  });

  /* A viewer's files on their own note: same ownership rule as editing it,
     same cap and shape as the internal attachment route. */
  api.post("/s/:slug/comments/:commentId/attachments", async (c) => {
    const { share, projection, comment } = await shareCommentForViewer(
      c,
      c.req.param("slug"),
      c.req.param("commentId"),
    );
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    await hitRateLimit(
      `share_attachment:${share.id}:${projection.viewer?.viewerKey ?? clientIp(c, env)}`,
      20,
      60 * 60 * 1000,
    );
    const project = (
      await env.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, share.projectId))
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.notFound();
    return c.json(
      await storeCommentAttachment(
        comment,
        project.workspaceId,
        await attachmentFileFrom(c),
      ),
      201,
    );
  });

  /* Any viewer of the share can open a visible note's files: visibility is
     the share's own comment rule (current version, never internal), and the
     URL is share-scoped and short-lived like every other media link here. */
  api.get(
    "/s/:slug/comments/:commentId/attachments/:attachmentId",
    async (c) => {
      const share = await shareBySlug(c.req.param("slug"));
      /* The gate only; the shared asset is looked up by the comment's version
         below, rather than by reading the whole share. */
      const projection = await publicShare(c, share, { assetId: NO_ASSET });
      if (!projection.viewer) throw errors.unauthorized();
      const comment = (
        await env.db
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.id, c.req.param("commentId")),
              isNull(comments.deletedAt),
              eq(comments.internal, false),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!comment) throw errors.notFound();
      const asset = (
        await publicShare(c, share, { versionId: comment.versionId })
      ).assets[0];
      if (!asset) throw errors.notFound();
      const attachment = (
        await env.db
          .select()
          .from(commentAttachments)
          .where(
            and(
              eq(commentAttachments.id, c.req.param("attachmentId")),
              eq(commentAttachments.commentId, comment.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!attachment || !env.blobStore) throw errors.notFound();
      return c.json({
        url: await publicMediaUrl(
          projection.share,
          asset.id,
          comment.versionId,
          attachment.blobKey,
          attachmentDisposition(attachment.filename),
        ),
        expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
      });
    },
  );

  api.delete(
    "/s/:slug/comments/:commentId/attachments/:attachmentId",
    async (c) => {
      const { comment } = await shareCommentForViewer(
        c,
        c.req.param("slug"),
        c.req.param("commentId"),
      );
      const attachment = (
        await env.db
          .select()
          .from(commentAttachments)
          .where(
            and(
              eq(commentAttachments.id, c.req.param("attachmentId")),
              eq(commentAttachments.commentId, comment.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!attachment) throw errors.notFound();
      await deleteBlobQuietly(attachment.blobKey);
      await env.db
        .delete(commentAttachments)
        .where(eq(commentAttachments.id, attachment.id))
        .run();
      return c.body(null, 204);
    },
  );

  api.post("/s/:slug/comments/:commentId/replies", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowComments)
      throw errors.forbidden("Comments are disabled for this share.");
    /* The gate only: this endpoint never looks at the listing, and reading a
       whole delivery to check a passphrase is what made a big share slow. */
    const projection = await publicShare(c, share, { assetId: NO_ASSET });
    if (!projection.viewer) throw errors.unauthorized();
    await hitRateLimit(
      `share_comment:${share.id}:${clientIp(c, env)}`,
      30,
      5 * 60 * 1000,
    );
    const parent = (
      await env.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.id, c.req.param("commentId")),
            isNull(comments.deletedAt),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!parent) throw errors.notFound("Comment was not found.");
    // The parent must be a comment this share exposes: on the current
    // version of one of the shared assets and not internal. Without this
    // check a share viewer could reply to any comment in the database.
    const parentAsset = (
      await publicShare(c, share, { versionId: parent.versionId })
    ).assets[0];
    if (!parentAsset || parent.internal)
      throw errors.notFound("Comment was not found.");
    if (parent.parentId) throw errors.validation("Replies cannot be nested.");
    const body = await jsonBody(c, bodies.shareReplyCreate);
    validateCommentAnchor(body);
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: parent.versionId,
        parentId: parent.id,
        authorUserId: null,
        authorName: projection.viewer.name,
        authorEmail: projection.viewer.email,
        viewerKey: projection.viewer.viewerKey,
        frameIn: parent.frameIn,
        frameOut: parent.frameOut,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson: null,
        pageNo: null,
        internal: false,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: env.clock.now(),
        editedAt: null,
      })
      .run();
    const reply = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!reply) throw errors.internal();
    // Share-viewer replies notify the registered-user thread participants;
    // the actor is a viewer without a user id, so no self-exclusion applies.
    await createNotifications({
      projectId: share.projectId,
      actorUserId: null,
      recipients: await threadParticipantIds(parent.id),
      kind: "comment.reply",
      payload: {
        project_id: share.projectId,
        asset_id: parentAsset.id,
        asset_name: parentAsset.name,
        version_id: parent.versionId,
        comment_id: id,
        parent_comment_id: parent.id,
        actor_name:
          projection.viewer.name ?? projection.viewer.email ?? "Share viewer",
        preview: notificationPreview(body.body_text.trim()),
      },
    });
    await appendProjectEvent(share.projectId, "comment.created", {
      comment_id: id,
      version_id: parent.versionId,
      frame_in: parent.frameIn,
      parent_id: parent.id,
    });
    return c.json(publicCommentWire(reply, share.slug), 201);
  });

  api.patch("/s/:slug/approval", async (c) => {
    const share = await shareBySlug(c.req.param("slug"));
    if (!share.allowApprovals)
      throw errors.forbidden("This share does not take approval decisions.");
    /* The gate only: this endpoint never looks at the listing, and reading a
       whole delivery to check a passphrase is what made a big share slow. */
    const projection = await publicShare(c, share, { assetId: NO_ASSET });
    if (!projection.viewer) throw errors.unauthorized();
    await hitRateLimit(
      `share_approval:${share.id}:${clientIp(c, env)}`,
      30,
      5 * 60 * 1000,
    );
    const body = await jsonBody(c, bodies.shareApprovalPatch);
    const asset = (await publicShare(c, share, { assetId: body.asset_id }))
      .assets[0];
    if (!asset) throw errors.notFound();
    const changed = await env.db
      .update(assets)
      .set({ status: body.status, updatedAt: nextAssetStamp(env.clock.now()) })
      .where(and(eq(assets.id, asset.id), ne(assets.status, body.status)))
      .returning({ id: assets.id })
      .all();
    if (!changed.length)
      return c.json({ asset_id: asset.id, status: body.status });
    await notifyApprovalChange({
      asset,
      status: body.status,
      actorUserId: null,
      actorName:
        projection.viewer.name ?? projection.viewer.email ?? "Share viewer",
    });
    return c.json({ asset_id: asset.id, status: body.status });
  });
};
