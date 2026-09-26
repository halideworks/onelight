import { comments, commentAttachments } from "@onelight/db/schema";
import { and, eq, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { errors } from "@onelight/core";
import type { Context } from "hono";
import type { Variables, AppEnv } from "../types.js";
import {
  MAX_COMMENT_ATTACHMENT_BYTES,
  MAX_COMMENT_ATTACHMENTS,
  MAX_COMMENT_ATTACHMENT_TOTAL_BYTES,
} from "../limits.js";
import { limitStream } from "../helpers.js";
import { attachmentWire } from "../wire.js";
import type { Blobs } from "./blobs.js";

export const createComments = (env: AppEnv, blobs: Blobs) => {
  const { deleteBlobQuietly } = blobs;

  /**
   * Copy unresolved, non-deleted top-level comments from one version to
   * another at the same frame with carried_from_comment_id provenance.
   * Shared by POST /versions/:id/carry-forward and the carry_forward flag
   * of POST /assets/:id/versions.
   */
  const copyUnresolvedComments = async (
    sourceVersionId: string,
    targetVersionId: string,
  ): Promise<string[]> => {
    const sourceComments = await env.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.versionId, sourceVersionId),
          isNull(comments.deletedAt),
          isNull(comments.completedAt),
          isNull(comments.parentId),
        ),
      )
      .all();
    /* Already carried here once. Copying is now something a person can aim at
       any version from the version menu, so pressing it twice must not double
       the notes; provenance is what makes that answerable. A copy the reviewer
       later deleted stays deleted rather than coming back. */
    const alreadyCarried = new Set(
      (
        await env.db
          .select({ from: comments.carriedFromCommentId })
          .from(comments)
          .where(
            and(
              eq(comments.versionId, targetVersionId),
              isNotNull(comments.carriedFromCommentId),
            ),
          )
          .all()
      )
        .map((row) => row.from)
        .filter((from): from is string => from !== null),
    );
    /* Re-anchor where the host can see the pictures: frames follow the
       footage across a recut instead of the arithmetic. An unavailable or
       unconvinced matcher changes nothing. */
    let remap: ((frame: number) => number | null) | null = null;
    if (env.frameMatcher && sourceComments.length) {
      try {
        remap = await env.frameMatcher(sourceVersionId, targetVersionId);
      } catch {
        remap = null;
      }
    }
    const copied: string[] = [];
    for (const sourceComment of sourceComments as Array<
      typeof comments.$inferSelect
    >) {
      if (alreadyCarried.has(sourceComment.id)) continue;
      const id = env.ids.ulid();
      let frameIn = sourceComment.frameIn;
      let frameOut = sourceComment.frameOut;
      if (remap && frameIn !== null) {
        const moved = remap(frameIn);
        if (moved !== null && moved !== frameIn) {
          if (frameOut !== null)
            frameOut = Math.max(moved, frameOut + (moved - frameIn));
          frameIn = moved;
        }
      }
      await env.db
        .insert(comments)
        .values({
          id,
          versionId: targetVersionId,
          parentId: null,
          authorUserId: sourceComment.authorUserId,
          authorName: sourceComment.authorName,
          authorEmail: sourceComment.authorEmail,
          viewerKey: sourceComment.viewerKey,
          frameIn,
          frameOut,
          bodyText: sourceComment.bodyText,
          annotationJson: sourceComment.annotationJson,
          pinXyJson: sourceComment.pinXyJson,
          pageNo: sourceComment.pageNo,
          internal: sourceComment.internal,
          completedAt: null,
          completedBy: null,
          carriedFromCommentId: sourceComment.id,
          deletedAt: null,
          createdAt: env.clock.now(),
          editedAt: null,
        })
        .run();
      copied.push(id);
    }
    return copied;
  };

  const attachmentsFor = async (
    commentIds: string[],
  ): Promise<Map<string, ReturnType<typeof attachmentWire>[]>> => {
    const grouped = new Map<string, ReturnType<typeof attachmentWire>[]>();
    if (!commentIds.length) return grouped;
    const rows = (await env.db
      .select()
      .from(commentAttachments)
      .where(inArray(commentAttachments.commentId, commentIds))
      .all()) as Array<typeof commentAttachments.$inferSelect>;
    for (const row of rows) {
      const list = grouped.get(row.commentId) ?? [];
      list.push(attachmentWire(row));
      grouped.set(row.commentId, list);
    }
    return grouped;
  };

  const validateCommentAnchor = (body: {
    frame_in?: number | undefined;
    frame_out?: number | undefined;
    annotation?: unknown;
  }) => {
    if (body.frame_in !== undefined && body.frame_in < 0)
      throw errors.validation("Frame anchors must be non-negative.");
    if (
      body.frame_out !== undefined &&
      body.frame_in !== undefined &&
      body.frame_out < body.frame_in
    )
      throw errors.validation(
        "frame_out must be greater than or equal to frame_in.",
      );
    if (
      body.annotation !== undefined &&
      JSON.stringify(body.annotation).length > 262_144
    )
      throw errors.validation("Annotation payload is too large.");
  };

  const attachmentFileFrom = async (
    c: Context<{ Variables: Variables }>,
  ): Promise<File> => {
    if (!env.blobStore || !c.req.raw.body)
      throw errors.internal("Blob storage is not configured.");
    const declaredLength = c.req.header("content-length");
    if (!declaredLength)
      throw errors.validation(
        "Attachment uploads require a content-length header.",
      );
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_COMMENT_ATTACHMENT_BYTES + 1_048_576
    )
      throw errors.payloadTooLarge();
    let form: FormData;
    try {
      form = await new Response(
        limitStream(c.req.raw.body, MAX_COMMENT_ATTACHMENT_BYTES + 1_048_576),
        { headers: { "content-type": c.req.header("content-type") ?? "" } },
      ).formData();
    } catch (error) {
      if (error instanceof TypeError)
        throw errors.validation(
          "Request body must be valid multipart form data.",
        );
      throw error;
    }
    const candidate = form.get("file");
    if (!candidate || typeof candidate === "string")
      throw errors.validation("A file field is required.");
    const file = candidate;
    if (file.size < 1 || file.size > MAX_COMMENT_ATTACHMENT_BYTES)
      throw errors.payloadTooLarge();
    return file;
  };

  const assertAttachmentCapacity = async (
    commentId: string,
    incomingBytes: number,
  ): Promise<void> => {
    const usage = (
      await env.db
        .select({
          count: sql<number>`count(*)`,
          bytes: sql<number>`coalesce(sum(${commentAttachments.size}), 0)`,
        })
        .from(commentAttachments)
        .where(eq(commentAttachments.commentId, commentId))
        .all()
    )[0];
    if (Number(usage?.count ?? 0) >= MAX_COMMENT_ATTACHMENTS)
      throw errors.conflict(
        `A comment can have at most ${String(MAX_COMMENT_ATTACHMENTS)} attachments.`,
      );
    if (
      Number(usage?.bytes ?? 0) + incomingBytes >
      MAX_COMMENT_ATTACHMENT_TOTAL_BYTES
    )
      throw errors.payloadTooLarge();
  };

  const storeCommentAttachment = async (
    comment: typeof comments.$inferSelect,
    workspaceId: string,
    file: File,
  ) => {
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    await assertAttachmentCapacity(comment.id, file.size);
    const attachmentId = env.ids.ulid();
    const filename =
      file.name.replace(/[\\/]/g, "_").slice(0, 500) || "attachment";
    const blobKey = `${workspaceId}/comments/${comment.id}/${attachmentId}-${filename}`;
    const stream = new Response(file.stream()).body;
    if (!stream)
      throw errors.internal("Attachment stream could not be opened.");
    await env.blobStore.putStream(blobKey, stream, {
      contentType: file.type || "application/octet-stream",
      size: file.size,
    });
    try {
      await env.db
        .insert(commentAttachments)
        .values({
          id: attachmentId,
          commentId: comment.id,
          blobKey,
          filename,
          size: file.size,
          contentType: file.type || "application/octet-stream",
          checksumSha256: "",
        })
        .run();
    } catch (error) {
      await deleteBlobQuietly(blobKey);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("comment attachment count limit"))
        throw errors.conflict(
          `A comment can have at most ${String(MAX_COMMENT_ATTACHMENTS)} attachments.`,
        );
      if (
        message.includes("comment attachment byte limit") ||
        message.includes("comment attachment size is invalid")
      )
        throw errors.payloadTooLarge();
      throw error;
    }
    return {
      id: attachmentId,
      comment_id: comment.id,
      filename,
      size: file.size,
    };
  };

  const deleteAttachmentsForComment = async (commentId: string) => {
    const rows = await env.db
      .select()
      .from(commentAttachments)
      .where(eq(commentAttachments.commentId, commentId))
      .all();
    for (const attachment of rows) await deleteBlobQuietly(attachment.blobKey);
    if (rows.length)
      await env.db
        .delete(commentAttachments)
        .where(eq(commentAttachments.commentId, commentId))
        .run();
  };

  return {
    copyUnresolvedComments,
    attachmentsFor,
    validateCommentAnchor,
    attachmentFileFrom,
    storeCommentAttachment,
    deleteAttachmentsForComment,
  };
};

export type Comments = ReturnType<typeof createComments>;
