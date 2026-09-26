import { requireAuth } from "../auth.js";
import {
  userFromContext,
  getLimit,
  commentCursorParam,
  encodeCommentCursor,
  jsonBody,
} from "../helpers.js";
import { sql, and, eq, isNull, or, gt, lt, asc, desc } from "drizzle-orm";
import {
  comments,
  assets,
  assetVersions,
  commentAttachments,
  commentReactions,
} from "@onelight/db/schema";
import { bodies } from "../schemas.js";
import { errors, parseResolveEdl, parseMarkersCsv } from "@onelight/core";
import type { AppEnv, ApiRouter, ActorUser } from "../types.js";
import type { Access } from "../operation/access.js";
import type { Comments } from "../operation/comments.js";
import { commentWire, assetWire } from "../wire.js";
import type { Activity } from "../operation/activity.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";

export const registerCommentsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    commentsOps,
    activity,
    media,
    blobs,
  }: {
    access: Access;
    commentsOps: Comments;
    activity: Activity;
    media: Media;
    blobs: Blobs;
  },
) => {
  const { versionForActor, requireProject, assetForActor } = access;
  const {
    attachmentsFor,
    validateCommentAnchor,
    deleteAttachmentsForComment,
    storeCommentAttachment,
    attachmentFileFrom,
    copyUnresolvedComments,
  } = commentsOps;
  const {
    notificationPreview,
    visibleMentionIds,
    createNotifications,
    projectManagerIds,
    appendProjectEvent,
    projectIdForVersion,
    threadParticipantIds,
    notifyApprovalChange,
  } = activity;
  const { privateMediaUrl, DOWNLOAD_TOKEN_TTL_MS } = media;
  const { attachmentDisposition, deleteBlobQuietly } = blobs;

  api.get("/versions/:id/comments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(c.req.param("id"), actor);
    const limit = getLimit(c.req.query("limit"));
    const cursor = commentCursorParam(c.req.query("cursor"));
    // Composite keyset over (COALESCE(frame_in, -1) ASC, id DESC): a plain id
    // cursor would drop or duplicate rows across pages under this ordering.
    const frameKey = sql<number>`coalesce(${comments.frameIn}, -1)`;
    const rows = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, version.id),
          isNull(comments.deletedAt),
          cursor
            ? or(
                gt(frameKey, cursor.f),
                and(eq(frameKey, cursor.f), lt(comments.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(frameKey), desc(comments.id))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const attached = await attachmentsFor(
      page.map((comment: typeof comments.$inferSelect) => comment.id),
    );
    return c.json({
      items: page.map((comment: typeof comments.$inferSelect) => ({
        ...commentWire(comment),
        attachments: attached.get(comment.id) ?? [],
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCommentCursor(last.frameIn ?? -1, last.id)
          : null,
    });
  });

  api.post("/versions/:id/comments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(c, bodies.commentCreate);
    validateCommentAnchor(body);
    if (
      version.durationFrames !== null &&
      version.durationFrames !== undefined &&
      body.frame_in !== undefined &&
      body.frame_in >= version.durationFrames
    )
      throw errors.validation("Frame anchor is outside the version.");
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: version.id,
        parentId: null,
        authorUserId: actor.id,
        authorName: actor.name,
        authorEmail: actor.email,
        viewerKey: null,
        frameIn: body.frame_in ?? null,
        frameOut: body.frame_out ?? null,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson:
          body.pin_xy === undefined ? null : JSON.stringify(body.pin_xy),
        pageNo: body.page_no ?? null,
        internal: body.internal,
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
    // New top-level comments notify the version uploader and the project
    // managers (never the commenting actor).
    const commentedAsset = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, version.assetId))
        .limit(1)
        .all()
    )[0];
    if (commentedAsset) {
      const payload = {
        project_id: commentedAsset.projectId,
        asset_id: commentedAsset.id,
        asset_name: commentedAsset.name,
        version_id: version.id,
        comment_id: id,
        actor_name: actor.name,
        preview: notificationPreview(body.body_text.trim()),
      };
      // Mention dedup: a mentioned user gets exactly one notification for
      // this comment and it is the mention (comment.mention wins over
      // comment.created for the same comment).
      const mentioned = await visibleMentionIds(
        commentedAsset.projectId,
        body.mentions,
      );
      if (mentioned.length)
        await createNotifications({
          projectId: commentedAsset.projectId,
          actorUserId: actor.id,
          recipients: mentioned,
          kind: "comment.mention",
          payload,
        });
      const mentionedSet = new Set(mentioned);
      await createNotifications({
        projectId: commentedAsset.projectId,
        actorUserId: actor.id,
        recipients: [
          version.uploadedBy,
          ...(await projectManagerIds(commentedAsset.projectId)),
        ].filter((recipient) => recipient && !mentionedSet.has(recipient)),
        kind: "comment.created",
        payload,
      });
      await appendProjectEvent(commentedAsset.projectId, "comment.created", {
        comment_id: id,
        version_id: version.id,
        frame_in: comment.frameIn,
      });
    }
    return c.json(commentWire(comment), 201);
  });

  /* Markers exported from an NLE come back as comments: the round trip. The
     file's timecodes resolve against the version's own rate and start frame,
     markers landing outside the version are counted rather than fatal, and no
     notifications fan out (a marker file is not a conversation). */
  api.post("/versions/:id/comments/import", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const version = await versionForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(c, bodies.commentsImport);
    const options = {
      rate: {
        num: version.frameRateNum ?? 24,
        den: version.frameRateDen ?? 1,
      },
      startFrame:
        body.timecode_base === "source" ? (version.sourceStartFrame ?? 0) : 0,
      dropFrame: Boolean(version.dropFrame),
      timecodeBase: body.timecode_base,
    };
    const markers =
      body.format === "resolve_edl"
        ? parseResolveEdl(body.content, options)
        : parseMarkersCsv(body.content);
    if (!markers.length)
      throw errors.validation(
        "No markers were found in the file. Onelight reads the Resolve marker EDL and its own CSV.",
      );
    if (markers.length > 2000)
      throw errors.validation("The file holds more than 2000 markers.");
    const duration = version.durationFrames;
    let imported = 0;
    let skipped = 0;
    const now = env.clock.now();
    for (const marker of markers) {
      if (duration !== null && duration !== undefined) {
        if (marker.frameIn >= duration) {
          skipped += 1;
          continue;
        }
        if (marker.frameOut !== null && marker.frameOut >= duration)
          marker.frameOut = duration - 1;
      }
      await env.db
        .insert(comments)
        .values({
          id: env.ids.ulid(),
          versionId: version.id,
          parentId: null,
          authorUserId: actor.id,
          authorName: actor.name,
          authorEmail: actor.email,
          viewerKey: null,
          frameIn: marker.frameIn,
          frameOut: marker.frameOut,
          bodyText: marker.bodyText,
          annotationJson: null,
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
      imported += 1;
    }
    return c.json({ imported, skipped }, 201);
  });

  const commentForActor = async (
    id: string,
    actor: ActorUser,
    minimum: "viewer" | "commenter" = "viewer",
  ) => {
    const comment = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, id))
        .limit(1)
        .all()
    )[0];
    if (!comment) throw errors.notFound("Comment was not found.");
    await versionForActor(comment.versionId, actor, minimum);
    return comment;
  };

  const requireCommentAuthor = (
    comment: typeof comments.$inferSelect,
    actor: ActorUser,
  ): void => {
    if (comment.authorUserId !== actor.id)
      throw errors.forbidden("Only the author can edit this comment.");
  };

  // Authors may delete their own comments; project managers can remove any
  // comment in their project. Admins hold manager implicitly in requireProject.
  // Moderation never grants authorship and therefore never grants editing.
  const requireCommentAuthorOrModerator = async (
    comment: typeof comments.$inferSelect,
    actor: ActorUser,
  ) => {
    if (comment.authorUserId === actor.id) return;
    const version = (
      await env.db
        .select({ assetId: assetVersions.assetId })
        .from(assetVersions)
        .where(eq(assetVersions.id, comment.versionId))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound("Comment was not found.");
    const asset = (
      await env.db
        .select({ projectId: assets.projectId })
        .from(assets)
        .where(eq(assets.id, version.assetId))
        .limit(1)
        .all()
    )[0];
    if (!asset) throw errors.notFound("Comment was not found.");
    await requireProject(asset.projectId, actor, "manager");
  };

  api.patch("/comments/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    requireCommentAuthor(comment, actor);
    const body = await jsonBody(c, bodies.commentPatch);
    validateCommentAnchor(body);
    /* A PATCH writes frame_in and frame_out independently, so the body-only
       guard above misses an inversion made against the STORED other end: a
       comment at [100,200] patched with just {frame_out:50} would persist an
       inverted range. Validate the effective range -- the merge of the body
       over what is already there -- including the version-bound check the
       create path does. */
    const effIn = body.frame_in === undefined ? comment.frameIn : body.frame_in;
    const effOut =
      body.frame_out === undefined ? comment.frameOut : body.frame_out;
    if (effIn !== null && effIn < 0)
      throw errors.validation("Frame anchors must be non-negative.");
    if (effIn !== null && effOut !== null && effOut < effIn)
      throw errors.validation(
        "frame_out must be greater than or equal to frame_in.",
      );
    if (
      effIn !== null &&
      (body.frame_in !== undefined || body.frame_out !== undefined)
    ) {
      const versionRow = (
        await env.db
          .select({ durationFrames: assetVersions.durationFrames })
          .from(assetVersions)
          .where(eq(assetVersions.id, comment.versionId))
          .limit(1)
          .all()
      )[0];
      if (
        versionRow?.durationFrames != null &&
        effIn >= versionRow.durationFrames
      )
        throw errors.validation("Frame anchor is outside the version.");
    }
    await env.db
      .update(comments)
      .set({
        ...(body.body_text ? { bodyText: body.body_text.trim() } : {}),
        ...(body.frame_in === undefined ? {} : { frameIn: body.frame_in }),
        ...(body.frame_out === undefined ? {} : { frameOut: body.frame_out }),
        ...(body.annotation === undefined
          ? {}
          : { annotationJson: JSON.stringify(body.annotation) }),
        ...(body.pin_xy === undefined
          ? {}
          : { pinXyJson: JSON.stringify(body.pin_xy) }),
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
    const patchedProjectId = await projectIdForVersion(updated.versionId);
    if (patchedProjectId)
      await appendProjectEvent(patchedProjectId, "comment.updated", {
        comment_id: updated.id,
        version_id: updated.versionId,
        frame_in: updated.frameIn,
      });
    return c.json(commentWire(updated));
  });

  api.delete("/comments/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await requireCommentAuthorOrModerator(comment, actor);
    await deleteAttachmentsForComment(comment.id);
    await env.db
      .update(comments)
      .set({ deletedAt: env.clock.now() })
      .where(eq(comments.id, comment.id))
      .run();
    const deletedProjectId = await projectIdForVersion(comment.versionId);
    if (deletedProjectId)
      await appendProjectEvent(deletedProjectId, "comment.deleted", {
        comment_id: comment.id,
        version_id: comment.versionId,
      });
    return c.body(null, 204);
  });

  api.post("/comments/:id/attachments", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    requireCommentAuthor(comment, actor);
    return c.json(
      await storeCommentAttachment(
        comment,
        actor.workspaceId,
        await attachmentFileFrom(c),
      ),
      201,
    );
  });

  api.get("/comments/:id/attachments/:attachmentId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(c.req.param("id"), actor);
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
      url: await privateMediaUrl(
        { versionId: comment.versionId },
        attachment.blobKey,
        attachmentDisposition(attachment.filename),
      ),
      expires_at: env.clock.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
  });

  api.delete(
    "/comments/:id/attachments/:attachmentId",
    requireAuth,
    async (c) => {
      const actor = userFromContext(c);
      const comment = await commentForActor(
        c.req.param("id"),
        actor,
        "commenter",
      );
      requireCommentAuthor(comment, actor);
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

  api.post("/comments/:id/replies", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const parent = await commentForActor(c.req.param("id"), actor, "commenter");
    if (parent.parentId) throw errors.validation("Replies cannot be nested.");
    const body = await jsonBody(c, bodies.replyCreate);
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(comments)
      .values({
        id,
        versionId: parent.versionId,
        parentId: parent.id,
        authorUserId: actor.id,
        authorName: actor.name,
        authorEmail: actor.email,
        viewerKey: null,
        frameIn: parent.frameIn,
        frameOut: parent.frameOut,
        bodyText: body.body_text.trim(),
        annotationJson:
          body.annotation === undefined
            ? null
            : JSON.stringify(body.annotation),
        pinXyJson: null,
        pageNo: null,
        internal: parent.internal,
        completedAt: null,
        completedBy: null,
        carriedFromCommentId: null,
        deletedAt: null,
        createdAt: now,
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
    // Replies notify the parent author and the other thread participants
    // with a user account (share viewers have none), never the actor.
    const repliedVersion = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, parent.versionId))
        .limit(1)
        .all()
    )[0];
    const repliedAsset = repliedVersion
      ? (
          await env.db
            .select()
            .from(assets)
            .where(eq(assets.id, repliedVersion.assetId))
            .limit(1)
            .all()
        )[0]
      : undefined;
    if (repliedAsset) {
      const payload = {
        project_id: repliedAsset.projectId,
        asset_id: repliedAsset.id,
        asset_name: repliedAsset.name,
        version_id: parent.versionId,
        comment_id: id,
        parent_comment_id: parent.id,
        actor_name: actor.name,
        preview: notificationPreview(body.body_text.trim()),
      };
      // Mention dedup, same rule as top-level comments: mention wins.
      const mentioned = await visibleMentionIds(
        repliedAsset.projectId,
        body.mentions,
      );
      if (mentioned.length)
        await createNotifications({
          projectId: repliedAsset.projectId,
          actorUserId: actor.id,
          recipients: mentioned,
          kind: "comment.mention",
          payload,
        });
      const mentionedSet = new Set(mentioned);
      await createNotifications({
        projectId: repliedAsset.projectId,
        actorUserId: actor.id,
        recipients: (await threadParticipantIds(parent.id)).filter(
          (participant) => !mentionedSet.has(participant),
        ),
        kind: "comment.reply",
        payload,
      });
      await appendProjectEvent(repliedAsset.projectId, "comment.created", {
        comment_id: id,
        version_id: parent.versionId,
        frame_in: parent.frameIn,
        parent_id: parent.id,
      });
    }
    return c.json(commentWire(reply), 201);
  });

  api.post("/comments/:id/complete", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await env.db
      .update(comments)
      .set({ completedAt: env.clock.now(), completedBy: actor.id })
      .where(eq(comments.id, comment.id))
      .run();
    const completed = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!completed) throw errors.notFound();
    const completedProjectId = await projectIdForVersion(completed.versionId);
    if (completedProjectId)
      await appendProjectEvent(completedProjectId, "comment.updated", {
        comment_id: completed.id,
        version_id: completed.versionId,
        frame_in: completed.frameIn,
      });
    return c.json(commentWire(completed));
  });

  /* Resolving was one-way: completedAt could be set and never cleared, so a
     note resolved by mistake -- or reopened because the fix did not hold, which
     is the ordinary life of a note -- was stuck resolved forever. The inverse of
     POST /complete is DELETE /complete. */
  api.delete("/comments/:id/complete", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await env.db
      .update(comments)
      .set({ completedAt: null, completedBy: null })
      .where(eq(comments.id, comment.id))
      .run();
    const reopened = (
      await env.db
        .select()
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1)
        .all()
    )[0];
    if (!reopened) throw errors.notFound();
    const reopenedProjectId = await projectIdForVersion(reopened.versionId);
    if (reopenedProjectId)
      await appendProjectEvent(reopenedProjectId, "comment.updated", {
        comment_id: reopened.id,
        version_id: reopened.versionId,
        frame_in: reopened.frameIn,
      });
    return c.json(commentWire(reopened));
  });

  api.post("/comments/:id/reactions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    const body = await jsonBody(c, bodies.reactionCreate);
    await env.db
      .insert(commentReactions)
      .values({
        commentId: comment.id,
        userId: actor.id,
        code: body.code,
        createdAt: env.clock.now(),
      })
      .onConflictDoNothing()
      .run();
    return c.body(null, 204);
  });

  api.delete("/comments/:id/reactions/:code", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const comment = await commentForActor(
      c.req.param("id"),
      actor,
      "commenter",
    );
    await env.db
      .delete(commentReactions)
      .where(
        and(
          eq(commentReactions.commentId, comment.id),
          eq(commentReactions.userId, actor.id),
          eq(commentReactions.code, c.req.param("code")),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  api.post("/versions/:id/carry-forward", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const target = await versionForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.carryForward);
    const source = await versionForActor(body.from_version_id, actor, "viewer");
    const copied = await copyUnresolvedComments(source.id, target.id);
    return c.json({ items: copied });
  });

  api.patch("/assets/:id/approval", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const asset = await assetForActor(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.approvalPatch);
    await env.db
      .update(assets)
      .set({ status: body.status, updatedAt: env.clock.now() })
      .where(eq(assets.id, asset.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(assets)
        .where(eq(assets.id, asset.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await notifyApprovalChange({
      asset: updated,
      status: body.status,
      actorUserId: actor.id,
      actorName: actor.name,
    });
    return c.json(assetWire(updated));
  });
};
