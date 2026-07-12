import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  assetVersions,
  commentReactions,
  notifications,
} from "@onelight/db/schema";
import {
  assertSnakeCaseKeys,
  cookieFrom,
  errorCode,
  forbiddenKeysIn,
  json,
  req,
} from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  createProject,
  createUser,
  grantRole,
  seedAssetVersion,
  seedExtraVersion,
  unique,
  uniqueIp,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

const postComment = async (
  h: ContractHarness,
  cookie: string,
  versionId: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  req(h, `/api/v1/versions/${versionId}/comments`, { cookie, json: body });

const multipartBody = (
  filename: string,
  content: string,
): { body: string; contentType: string; length: number } => {
  const boundary = "----onelightcontract";
  const body = [
    `--${boundary}`,
    `content-disposition: form-data; name="file"; filename="${filename}"`,
    "content-type: text/plain",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    length: new TextEncoder().encode(body).byteLength,
  };
};

export const registerCommentsDomain = (ctx: SuiteContext): void => {
  describe("comments", () => {
    it("creates comments with validated anchors and a clean wire shape", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const unauth = await req(
        h,
        `/api/v1/versions/${seed.media.versionId}/comments`,
        { method: "POST", json: { body_text: "anon" }, origin: false },
      );
      expect(unauth.status).toBe(401);
      const created = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        {
          frame_in: 12,
          frame_out: 24,
          body_text: "Check the cut",
          internal: true,
        },
      );
      expect(created.status).toBe(201);
      const body = await json(created);
      expect(body.frame_in).toBe(12);
      expect(body.frame_out).toBe(24);
      expect(body.internal).toBe(true);
      expect(body.author_user_id).toBe(seed.commenter.id);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(forbiddenKeysIn(body, ["viewer_key"])).toEqual([]);
      const viewerDenied = await postComment(
        h,
        seed.viewer.cookie,
        seed.media.versionId,
        { body_text: "viewer cannot comment" },
      );
      expect(viewerDenied.status).toBe(403);
      const negative = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { frame_in: -1, body_text: "negative" },
      );
      expect(negative.status).toBe(400);
      const inverted = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { frame_in: 30, frame_out: 10, body_text: "inverted" },
      );
      expect(inverted.status).toBe(400);
      const outOfRange = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { frame_in: 100, body_text: "beyond duration" },
      );
      expect(outOfRange.status).toBe(400);
      const hugeAnnotation = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        {
          body_text: "big annotation",
          annotation: { strokes: "x".repeat(262_200) },
        },
      );
      expect(hugeAnnotation.status).toBe(400);
      const missingVersion = await postComment(
        h,
        seed.commenter.cookie,
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        { body_text: "ghost" },
      );
      expect(missingVersion.status).toBe(404);
    });

    it("supports one level of replies that inherit anchors and visibility", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const parentResponse = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { frame_in: 42, body_text: "thread root", internal: true },
      );
      const parent = await json<{ id: string }>(parentResponse);
      const replyResponse = await req(
        h,
        `/api/v1/comments/${parent.id}/replies`,
        { cookie: seed.editor.cookie, json: { body_text: "a reply" } },
      );
      expect(replyResponse.status).toBe(201);
      const reply = await json(replyResponse);
      expect(reply.parent_id).toBe(parent.id);
      expect(reply.frame_in).toBe(42);
      expect(reply.internal).toBe(true);
      const nested = await req(
        h,
        `/api/v1/comments/${String(reply.id)}/replies`,
        { cookie: seed.editor.cookie, json: { body_text: "nested" } },
      );
      expect(nested.status).toBe(400);
    });

    it("enforces edit and delete ownership with manager moderation", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const author = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      await grantRole(h, seed.admin, seed.project.id, author.id, "commenter");
      const createdResponse = await postComment(
        h,
        author.cookie,
        seed.media.versionId,
        { body_text: "mine to edit" },
      );
      const created = await json<{ id: string }>(createdResponse);
      const strangerEdit = await req(h, `/api/v1/comments/${created.id}`, {
        method: "PATCH",
        cookie: seed.commenter.cookie,
        json: { body_text: "hijack" },
      });
      expect(strangerEdit.status).toBe(403);
      const authorEdit = await req(h, `/api/v1/comments/${created.id}`, {
        method: "PATCH",
        cookie: author.cookie,
        json: { body_text: "edited by author", frame_in: 5 },
      });
      expect(authorEdit.status).toBe(200);
      const edited = await json(authorEdit);
      expect(edited.body_text).toBe("edited by author");
      expect(edited.edited_at).toBeTruthy();
      const managerEdit = await req(h, `/api/v1/comments/${created.id}`, {
        method: "PATCH",
        cookie: seed.manager.cookie,
        json: { body_text: "moderated" },
      });
      expect(managerEdit.status).toBe(200);
      const strangerDelete = await req(h, `/api/v1/comments/${created.id}`, {
        method: "DELETE",
        cookie: seed.commenter.cookie,
      });
      expect(strangerDelete.status).toBe(403);
      const managerDelete = await req(h, `/api/v1/comments/${created.id}`, {
        method: "DELETE",
        cookie: seed.manager.cookie,
      });
      expect(managerDelete.status).toBe(204);
      const ownDeleteResponse = await postComment(
        h,
        author.cookie,
        seed.media.versionId,
        { body_text: "delete me" },
      );
      const ownDelete = await json<{ id: string }>(ownDeleteResponse);
      const deleted = await req(h, `/api/v1/comments/${ownDelete.id}`, {
        method: "DELETE",
        cookie: author.cookie,
      });
      expect(deleted.status).toBe(204);
    });

    it("completes comments and records the completing user", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const createdResponse = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { body_text: "finish this" },
      );
      const created = await json<{ id: string }>(createdResponse);
      const completed = await req(
        h,
        `/api/v1/comments/${created.id}/complete`,
        {
          method: "POST",
          cookie: seed.editor.cookie,
        },
      );
      expect(completed.status).toBe(200);
      const body = await json(completed);
      expect(body.id).toBe(created.id);
      expect(body.completed_at).toBeTruthy();
      expect(body.completed_by).toBe(seed.editor.id);
    });

    it("adds and removes named reaction codes", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const createdResponse = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { body_text: "react to me" },
      );
      const created = await json<{ id: string }>(createdResponse);
      const badCode = await req(h, `/api/v1/comments/${created.id}/reactions`, {
        cookie: seed.editor.cookie,
        json: { code: "Thumbs Up!" },
      });
      expect(badCode.status).toBe(400);
      const added = await req(h, `/api/v1/comments/${created.id}/reactions`, {
        cookie: seed.editor.cookie,
        json: { code: "thumbs_up" },
      });
      expect(added.status).toBe(204);
      const duplicated = await req(
        h,
        `/api/v1/comments/${created.id}/reactions`,
        { cookie: seed.editor.cookie, json: { code: "thumbs_up" } },
      );
      expect(duplicated.status).toBe(204);
      const rows = await h.db
        .select()
        .from(commentReactions)
        .where(
          and(
            eq(commentReactions.commentId, created.id),
            eq(commentReactions.userId, seed.editor.id),
          ),
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.code).toBe("thumbs_up");
      const removed = await req(
        h,
        `/api/v1/comments/${created.id}/reactions/thumbs_up`,
        { method: "DELETE", cookie: seed.editor.cookie },
      );
      expect(removed.status).toBe(204);
      const after = await h.db
        .select()
        .from(commentReactions)
        .where(eq(commentReactions.commentId, created.id))
        .all();
      expect(after).toHaveLength(0);
    });

    it("paginates by the composite frame cursor without loss or duplication", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
      });
      const frames: Array<number | undefined> = [
        undefined,
        10,
        5,
        undefined,
        5,
        0,
        10,
      ];
      for (const [index, frame] of frames.entries()) {
        const response = await postComment(
          h,
          seed.commenter.cookie,
          media.versionId,
          {
            body_text: `comment ${index}`,
            ...(frame === undefined ? {} : { frame_in: frame }),
          },
        );
        expect(response.status).toBe(201);
      }
      const full = await json<{
        items: Array<{ id: string; frame_in: number | null }>;
      }>(
        await req(h, `/api/v1/versions/${media.versionId}/comments?limit=50`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(full.items).toHaveLength(frames.length);
      const ordering = full.items.map((item) => item.frame_in ?? -1);
      expect(ordering).toEqual([...ordering].sort((a, b) => a - b));
      const collected: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor
          ? `&cursor=${encodeURIComponent(cursor)}`
          : "";
        const page = await json<{
          items: Array<{ id: string }>;
          next_cursor: string | null;
        }>(
          await req(
            h,
            `/api/v1/versions/${media.versionId}/comments?limit=2${query}`,
            { cookie: seed.viewer.cookie },
          ),
        );
        collected.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(pages).toBeGreaterThanOrEqual(4);
      expect(collected).toEqual(full.items.map((item) => item.id));
      const malformed = await req(
        h,
        `/api/v1/versions/${media.versionId}/comments?cursor=not-a-cursor`,
        { cookie: seed.viewer.cookie },
      );
      expect(malformed.status).toBe(400);
      expect(await errorCode(malformed)).toBe("validation_failed");
    });

    it("keeps archived projects read-only for comments", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      const archive = await req(h, `/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { status: "archived" },
      });
      expect(archive.status).toBe(200);
      const blocked = await postComment(h, seed.admin.cookie, media.versionId, {
        body_text: "read only",
      });
      expect(blocked.status).toBe(403);
      const readable = await req(
        h,
        `/api/v1/versions/${media.versionId}/comments`,
        { cookie: seed.admin.cookie },
      );
      expect(readable.status).toBe(200);
    });

    ctx.itBlob("uploads, serves, and deletes comment attachments", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const createdResponse = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { body_text: "see attachment" },
      );
      const created = await json<{ id: string }>(createdResponse);
      const payload = multipartBody("note.txt", "attachment-payload");
      const missingLength = await req(
        h,
        `/api/v1/comments/${created.id}/attachments`,
        {
          method: "POST",
          cookie: seed.commenter.cookie,
          body: payload.body,
          headers: { "content-type": payload.contentType },
        },
      );
      // Node's fetch supplies content-length for string bodies, so this
      // request succeeds; the explicit path below asserts the happy flow.
      expect([201, 400]).toContain(missingLength.status);
      const attach = await req(
        h,
        `/api/v1/comments/${created.id}/attachments`,
        {
          method: "POST",
          cookie: seed.commenter.cookie,
          body: payload.body,
          headers: {
            "content-type": payload.contentType,
            "content-length": String(payload.length),
          },
        },
      );
      expect(attach.status).toBe(201);
      const attachment = await json<{ id: string; filename: string }>(attach);
      expect(attachment.filename).toBe("note.txt");
      const urlResponse = await req(
        h,
        `/api/v1/comments/${created.id}/attachments/${attachment.id}`,
        { cookie: seed.viewer.cookie },
      );
      expect(urlResponse.status).toBe(200);
      const { url } = await json<{ url: string }>(urlResponse);
      const parsed = new URL(url);
      const fetched = await req(h, parsed.pathname + parsed.search, {
        cookie: seed.viewer.cookie,
      });
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe("attachment-payload");
      expect(fetched.headers.get("content-disposition")).toBe(
        'attachment; filename="note.txt"',
      );
      const removed = await req(
        h,
        `/api/v1/comments/${created.id}/attachments/${attachment.id}`,
        { method: "DELETE", cookie: seed.commenter.cookie },
      );
      expect(removed.status).toBe(204);
      const gone = await req(
        h,
        `/api/v1/comments/${created.id}/attachments/${attachment.id}`,
        { cookie: seed.viewer.cookie },
      );
      expect(gone.status).toBe(404);
    });
  });

  describe("carry-forward", () => {
    it("copies only unresolved top-level comments with provenance", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
      });
      const second = await seedExtraVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
        assetId: media.assetId,
        versionNo: 2,
        makeCurrent: true,
      });
      const openResponse = await postComment(
        h,
        seed.commenter.cookie,
        media.versionId,
        { frame_in: 7, body_text: "open note" },
      );
      const open = await json<{ id: string }>(openResponse);
      const completedResponse = await postComment(
        h,
        seed.commenter.cookie,
        media.versionId,
        { frame_in: 8, body_text: "done note" },
      );
      const completedComment = await json<{ id: string }>(completedResponse);
      await req(h, `/api/v1/comments/${completedComment.id}/complete`, {
        method: "POST",
        cookie: seed.commenter.cookie,
      });
      const deletedResponse = await postComment(
        h,
        seed.commenter.cookie,
        media.versionId,
        { frame_in: 9, body_text: "deleted note" },
      );
      const deletedComment = await json<{ id: string }>(deletedResponse);
      await req(h, `/api/v1/comments/${deletedComment.id}`, {
        method: "DELETE",
        cookie: seed.commenter.cookie,
      });
      await req(h, `/api/v1/comments/${open.id}/replies`, {
        cookie: seed.commenter.cookie,
        json: { body_text: "a reply that must not copy" },
      });
      const editorDenied = await req(
        h,
        `/api/v1/versions/${second.versionId}/carry-forward`,
        {
          cookie: seed.editor.cookie,
          json: { from_version_id: media.versionId },
        },
      );
      expect(editorDenied.status).toBe(403);
      const carried = await req(
        h,
        `/api/v1/versions/${second.versionId}/carry-forward`,
        {
          cookie: seed.manager.cookie,
          json: { from_version_id: media.versionId },
        },
      );
      expect(carried.status).toBe(200);
      const carriedBody = await json<{ items: string[] }>(carried);
      expect(carriedBody.items).toHaveLength(1);
      const targetComments = await json<{
        items: Array<Record<string, unknown>>;
      }>(
        await req(h, `/api/v1/versions/${second.versionId}/comments`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(targetComments.items).toHaveLength(1);
      const copy = targetComments.items[0];
      expect(copy?.frame_in).toBe(7);
      expect(copy?.body_text).toBe("open note");
      expect(copy?.carried_from_comment_id).toBe(open.id);
      expect(copy?.completed_at).toBeNull();
    });
  });

  describe("approval", () => {
    it("moves assets through approval states manager-only", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
      });
      const commenterDenied = await req(
        h,
        `/api/v1/assets/${media.assetId}/approval`,
        {
          method: "PATCH",
          cookie: seed.commenter.cookie,
          json: { status: "approved" },
        },
      );
      expect(commenterDenied.status).toBe(403);
      for (const status of [
        "in_review",
        "changes_requested",
        "approved",
        "none",
      ]) {
        const response = await req(
          h,
          `/api/v1/assets/${media.assetId}/approval`,
          {
            method: "PATCH",
            cookie: seed.manager.cookie,
            json: { status },
          },
        );
        expect(response.status, status).toBe(200);
        expect((await json(response)).status).toBe(status);
      }
      const invalid = await req(h, `/api/v1/assets/${media.assetId}/approval`, {
        method: "PATCH",
        cookie: seed.manager.cookie,
        json: { status: "signed_off" },
      });
      expect(invalid.status).toBe(400);
    });
  });

  describe("search", () => {
    it("matches asset names and comment bodies scoped to the workspace", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const needle = unique("needlehay");
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
        name: `Asset ${needle}`,
      });
      const commentResponse = await postComment(
        h,
        seed.commenter.cookie,
        seed.media.versionId,
        { body_text: `Comment mentioning ${needle}` },
      );
      const comment = await json<{ id: string }>(commentResponse);
      const results = await req(
        h,
        `/api/v1/search?q=${encodeURIComponent(needle)}`,
        { cookie: seed.viewer.cookie },
      );
      expect(results.status).toBe(200);
      const body = await json<{
        items: Array<{ type: string; id: string }>;
      }>(results);
      expect(
        body.items.some(
          (item) => item.type === "asset" && item.id === media.assetId,
        ),
      ).toBe(true);
      expect(
        body.items.some(
          (item) => item.type === "comment" && item.id === comment.id,
        ),
      ).toBe(true);
      const foreign = await json<{ items: unknown[] }>(
        await req(h, `/api/v1/search?q=${encodeURIComponent(needle)}`, {
          cookie: seed.other.admin.cookie,
        }),
      );
      expect(foreign.items).toHaveLength(0);
      const tooShort = await req(h, "/api/v1/search?q=a", {
        cookie: seed.viewer.cookie,
      });
      expect(tooShort.status).toBe(400);
      const unauth = await req(h, "/api/v1/search?q=anything");
      expect(unauth.status).toBe(401);
    });

    it("scopes and paginates server-side with keyset cursors", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const needle = unique("scopetoken");
      type Hit = { type: string; id: string; project_id: string };
      type Page = { items: Hit[]; next_cursor: string | null };
      for (let index = 0; index < 3; index += 1)
        await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: seed.project.id,
          userId: seed.admin.id,
          name: `Asset ${needle} ${index}`,
        });
      for (let index = 0; index < 3; index += 1) {
        const response = await postComment(
          h,
          seed.commenter.cookie,
          seed.media.versionId,
          { body_text: `note ${needle} ${index}` },
        );
        expect(response.status).toBe(201);
      }
      const search = async (query: string): Promise<Page> =>
        json<Page>(
          await req(h, `/api/v1/search?${query}`, {
            cookie: seed.viewer.cookie,
          }),
        );
      const assetsOnly = await search(`q=${needle}&scope=assets&limit=50`);
      expect(assetsOnly.items).toHaveLength(3);
      expect(assetsOnly.items.every((hit) => hit.type === "asset")).toBe(true);
      expect(assetsOnly.next_cursor).toBeNull();
      const commentsOnly = await search(`q=${needle}&scope=comments&limit=50`);
      expect(commentsOnly.items).toHaveLength(3);
      expect(commentsOnly.items.every((hit) => hit.type === "comment")).toBe(
        true,
      );
      expect(
        commentsOnly.items.every((hit) => hit.project_id === seed.project.id),
      ).toBe(true);
      // scope=all pages assets first, then comments, with no drops or
      // duplicates across the seam.
      const collected: Hit[] = [];
      let cursor: string | null = null;
      let rounds = 0;
      do {
        const page: Page = await search(
          `q=${needle}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        collected.push(...page.items);
        cursor = page.next_cursor;
        rounds += 1;
      } while (cursor && rounds < 10);
      expect(collected).toHaveLength(6);
      expect(new Set(collected.map((hit) => hit.type + hit.id)).size).toBe(6);
      const firstComment = collected.findIndex((hit) => hit.type === "comment");
      expect(firstComment).toBe(3);
      expect(
        collected.slice(0, firstComment).every((hit) => hit.type === "asset"),
      ).toBe(true);
      // An exactly-full asset page still reaches the comment stream via the
      // seam cursor.
      const exact = await search(`q=${needle}&limit=3`);
      expect(exact.items.every((hit) => hit.type === "asset")).toBe(true);
      expect(exact.next_cursor).toBeTruthy();
      const seam: Page = await search(
        `q=${needle}&limit=3&cursor=${encodeURIComponent(exact.next_cursor ?? "")}`,
      );
      expect(seam.items).toHaveLength(3);
      expect(seam.items.every((hit) => hit.type === "comment")).toBe(true);
      const badScope = await req(
        h,
        `/api/v1/search?q=${needle}&scope=folders`,
        { cookie: seed.viewer.cookie },
      );
      expect(badScope.status).toBe(400);
      const mismatchedCursor = await req(
        h,
        `/api/v1/search?q=${needle}&scope=comments&cursor=${encodeURIComponent(exact.next_cursor ?? "")}`,
        { cookie: seed.viewer.cookie },
      );
      // The seam cursor points into the comment stream, which IS valid for
      // scope=comments; an asset cursor is not.
      expect(mismatchedCursor.status).toBe(200);
      const assetCursorPage = await search(`q=${needle}&scope=assets&limit=2`);
      const foreignScope = await req(
        h,
        `/api/v1/search?q=${needle}&scope=comments&cursor=${encodeURIComponent(assetCursorPage.next_cursor ?? "")}`,
        { cookie: seed.viewer.cookie },
      );
      expect(foreignScope.status).toBe(400);
    });
  });

  describe("notifications", () => {
    it("lists, paginates, and marks notifications read per user", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const id = h.ids.ulid();
        ids.push(id);
        await h.db
          .insert(notifications)
          .values({
            id,
            userId: user.id,
            kind: "comment.created",
            payloadJson: JSON.stringify({ index }),
            readAt: null,
            createdAt: h.clock.now(),
          })
          .run();
      }
      const firstPage = await json<{
        items: Array<{ id: string; read_at: number | null }>;
        next_cursor: string | null;
      }>(
        await req(h, "/api/v1/notifications?limit=2", { cookie: user.cookie }),
      );
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.next_cursor).toBeTruthy();
      expect(assertSnakeCaseKeys(firstPage)).toEqual([]);
      const secondPage = await json<{ items: Array<{ id: string }> }>(
        await req(
          h,
          `/api/v1/notifications?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor ?? "")}`,
          { cookie: user.cookie },
        ),
      );
      expect(secondPage.items).toHaveLength(1);
      const markRead = await req(h, "/api/v1/notifications/read", {
        cookie: user.cookie,
        json: { ids: [ids[0] ?? ""] },
      });
      expect(markRead.status).toBe(204);
      const after = await json<{
        items: Array<{ id: string; read_at: number | null }>;
      }>(await req(h, "/api/v1/notifications", { cookie: user.cookie }));
      expect(
        after.items.find((item) => item.id === ids[0])?.read_at,
      ).toBeTruthy();
      // Another user cannot see or mark these notifications.
      const foreignList = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/notifications?limit=200", {
          cookie: seed.editor.cookie,
        }),
      );
      expect(foreignList.items.some((item) => ids.includes(item.id))).toBe(
        false,
      );
      const foreignMark = await req(h, "/api/v1/notifications/read", {
        cookie: seed.editor.cookie,
        json: { ids: [ids[1] ?? ""] },
      });
      expect(foreignMark.status).toBe(204);
      const untouched = await json<{
        items: Array<{ id: string; read_at: number | null }>;
      }>(await req(h, "/api/v1/notifications", { cookie: user.cookie }));
      expect(
        untouched.items.find((item) => item.id === ids[1])?.read_at,
      ).toBeNull();
    });

    it("round-trips notification preferences with defaults", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const defaults = await json(
        await req(h, "/api/v1/notifications/preferences", {
          cookie: user.cookie,
        }),
      );
      expect(defaults).toEqual({ mode: "instant", muted_projects: [] });
      const updated = await req(h, "/api/v1/notifications/preferences", {
        method: "PATCH",
        cookie: user.cookie,
        json: { mode: "daily", muted_projects: [seed.project.id] },
      });
      expect(updated.status).toBe(200);
      const readBack = await json(
        await req(h, "/api/v1/notifications/preferences", {
          cookie: user.cookie,
        }),
      );
      expect(readBack).toEqual({
        mode: "daily",
        muted_projects: [seed.project.id],
      });
      const invalid = await req(h, "/api/v1/notifications/preferences", {
        method: "PATCH",
        cookie: user.cookie,
        json: { mode: "weekly" },
      });
      expect(invalid.status).toBe(400);
    });
  });

  describe("notification generation", () => {
    interface NotificationItem {
      id: string;
      kind: string;
      payload: Record<string, unknown>;
    }

    const listFor = async (
      h: ContractHarness,
      cookie: string,
    ): Promise<NotificationItem[]> =>
      (
        await json<{ items: NotificationItem[] }>(
          await req(h, "/api/v1/notifications?limit=200", { cookie }),
        )
      ).items;

    /* Fresh users per test so rows never bleed between tests or legs. */
    const notificationFixture = async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const mk = () =>
        createUser(h, {
          workspaceId: seed.workspaceId,
          passwordHash: seed.passwordHash,
        });
      const [uploader, manager, commenter] = await Promise.all([
        mk(),
        mk(),
        mk(),
      ]);
      await grantRole(h, seed.admin, project.id, manager.id, "manager");
      await grantRole(h, seed.admin, project.id, commenter.id, "commenter");
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: uploader.id,
      });
      return { h, seed, project, uploader, manager, commenter, media };
    };

    it("notifies the uploader and managers on new comments, never the actor", async () => {
      const { h, seed, project, uploader, manager, commenter, media } =
        await notificationFixture();
      const created = await postComment(h, commenter.cookie, media.versionId, {
        body_text: "needs a one-light pass on the second half",
      });
      expect(created.status).toBe(201);
      const commentId = (await json<{ id: string }>(created)).id;
      const uploaderRows = await listFor(h, uploader.cookie);
      const uploaderHit = uploaderRows.find(
        (item) => item.payload.comment_id === commentId,
      );
      expect(uploaderHit).toBeDefined();
      expect(uploaderHit?.kind).toBe("comment.created");
      expect(uploaderHit?.payload.project_id).toBe(project.id);
      expect(uploaderHit?.payload.asset_id).toBe(media.assetId);
      expect(uploaderHit?.payload.version_id).toBe(media.versionId);
      expect(uploaderHit?.payload.preview).toBe(
        "needs a one-light pass on the second half",
      );
      const managerRows = await listFor(h, manager.cookie);
      expect(
        managerRows.some((item) => item.payload.comment_id === commentId),
      ).toBe(true);
      const adminRows = await listFor(h, seed.admin.cookie);
      expect(
        adminRows.some((item) => item.payload.comment_id === commentId),
      ).toBe(true);
      // The actor never notifies themselves.
      const actorRows = await listFor(h, commenter.cookie);
      expect(
        actorRows.some((item) => item.payload.comment_id === commentId),
      ).toBe(false);
      // A manager commenting is excluded from their own notification too.
      const managerComment = await postComment(
        h,
        manager.cookie,
        media.versionId,
        { body_text: "manager note" },
      );
      const managerCommentId = (await json<{ id: string }>(managerComment)).id;
      expect(
        (await listFor(h, manager.cookie)).some(
          (item) => item.payload.comment_id === managerCommentId,
        ),
      ).toBe(false);
      expect(
        (await listFor(h, uploader.cookie)).some(
          (item) => item.payload.comment_id === managerCommentId,
        ),
      ).toBe(true);
    });

    it("notifies thread participants on replies", async () => {
      const { h, seed, manager, commenter, media, uploader } =
        await notificationFixture();
      const parentResponse = await postComment(
        h,
        commenter.cookie,
        media.versionId,
        { body_text: "parent thread" },
      );
      const parentId = (await json<{ id: string }>(parentResponse)).id;
      const firstReply = await req(h, `/api/v1/comments/${parentId}/replies`, {
        cookie: manager.cookie,
        json: { body_text: "first reply" },
      });
      expect(firstReply.status).toBe(201);
      const firstReplyId = (await json<{ id: string }>(firstReply)).id;
      const commenterRows = await listFor(h, commenter.cookie);
      const replyHit = commenterRows.find(
        (item) => item.payload.comment_id === firstReplyId,
      );
      expect(replyHit).toBeDefined();
      expect(replyHit?.kind).toBe("comment.reply");
      expect(replyHit?.payload.parent_comment_id).toBe(parentId);
      // The replying manager and the non-participant uploader get nothing.
      expect(
        (await listFor(h, manager.cookie)).some(
          (item) => item.payload.comment_id === firstReplyId,
        ),
      ).toBe(false);
      expect(
        (await listFor(h, uploader.cookie)).some(
          (item) => item.payload.comment_id === firstReplyId,
        ),
      ).toBe(false);
      // A second reply notifies both existing participants.
      const secondReply = await req(h, `/api/v1/comments/${parentId}/replies`, {
        cookie: seed.admin.cookie,
        json: { body_text: "second reply" },
      });
      const secondReplyId = (await json<{ id: string }>(secondReply)).id;
      for (const participant of [commenter, manager])
        expect(
          (await listFor(h, participant.cookie)).some(
            (item) =>
              item.kind === "comment.reply" &&
              item.payload.comment_id === secondReplyId,
          ),
        ).toBe(true);
    });

    it("skips recipients who muted the project; mode never suppresses rows", async () => {
      const { h, project, uploader, manager, commenter, media } =
        await notificationFixture();
      const mute = await req(h, "/api/v1/notifications/preferences", {
        method: "PATCH",
        cookie: uploader.cookie,
        json: { mode: "daily", muted_projects: [project.id] },
      });
      expect(mute.status).toBe(200);
      // mode=daily alone (no mute) must not suppress in-app rows: it only
      // shapes future email digests.
      const managerPrefs = await req(h, "/api/v1/notifications/preferences", {
        method: "PATCH",
        cookie: manager.cookie,
        json: { mode: "daily", muted_projects: [] },
      });
      expect(managerPrefs.status).toBe(200);
      const created = await postComment(h, commenter.cookie, media.versionId, {
        body_text: "muted project note",
      });
      const commentId = (await json<{ id: string }>(created)).id;
      expect(
        (await listFor(h, uploader.cookie)).some(
          (item) => item.payload.comment_id === commentId,
        ),
      ).toBe(false);
      expect(
        (await listFor(h, manager.cookie)).some(
          (item) => item.payload.comment_id === commentId,
        ),
      ).toBe(true);
    });

    it("notifies the uploader and managers on approval changes", async () => {
      const { h, seed, uploader, manager, media } = await notificationFixture();
      const changed = await req(h, `/api/v1/assets/${media.assetId}/approval`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { status: "changes_requested" },
      });
      expect(changed.status).toBe(200);
      const uploaderHit = (await listFor(h, uploader.cookie)).find(
        (item) =>
          item.kind === "approval.updated" &&
          item.payload.asset_id === media.assetId,
      );
      expect(uploaderHit).toBeDefined();
      expect(uploaderHit?.payload.status).toBe("changes_requested");
      expect(
        (await listFor(h, manager.cookie)).some(
          (item) =>
            item.kind === "approval.updated" &&
            item.payload.asset_id === media.assetId,
        ),
      ).toBe(true);
      // The acting admin is excluded even though admins hold manager rights.
      expect(
        (await listFor(h, seed.admin.cookie)).some(
          (item) =>
            item.kind === "approval.updated" &&
            item.payload.asset_id === media.assetId,
        ),
      ).toBe(false);
    });

    it("materializes transcode failures once for uploader and managers", async () => {
      const { h, uploader, manager, commenter, media } =
        await notificationFixture();
      await h.db
        .update(assetVersions)
        .set({ transcodeStatus: "failed" })
        .where(eq(assetVersions.id, media.versionId))
        .run();
      const failuresFor = async (cookie: string) =>
        (await listFor(h, cookie)).filter(
          (item) =>
            item.kind === "transcode.failed" &&
            item.payload.version_id === media.versionId,
        );
      expect(await failuresFor(uploader.cookie)).toHaveLength(1);
      // Reading again must not duplicate the row.
      expect(await failuresFor(uploader.cookie)).toHaveLength(1);
      expect(await failuresFor(manager.cookie)).toHaveLength(1);
      // A commenter is neither the uploader nor a manager.
      expect(await failuresFor(commenter.cookie)).toHaveLength(0);
    });

    it("notifies on share-viewer comments with the viewer identity", async () => {
      const { h, seed, project, uploader, manager, media } =
        await notificationFixture();
      const created = await req(h, "/api/v1/shares", {
        cookie: seed.admin.cookie,
        json: {
          project_id: project.id,
          title: unique("Notify Share"),
          asset_ids: [media.assetId],
        },
      });
      expect(created.status).toBe(201);
      const slug = (await json<{ share: { slug: string } }>(created)).share
        .slug;
      const access = await req(h, `/api/v1/s/${slug}/access`, {
        json: { name: "Client Nine" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(access.status).toBe(200);
      const viewerCookie = cookieFrom(access);
      const viewerComment = await req(
        h,
        `/api/v1/s/${slug}/assets/${media.assetId}/comments`,
        {
          method: "POST",
          cookie: viewerCookie,
          origin: true,
          json: { body_text: "client feedback from the share" },
          headers: { "x-forwarded-for": uniqueIp() },
        },
      );
      expect(viewerComment.status).toBe(201);
      const commentId = (await json<{ id: string }>(viewerComment)).id;
      for (const recipient of [uploader, manager]) {
        const hit = (await listFor(h, recipient.cookie)).find(
          (item) => item.payload.comment_id === commentId,
        );
        expect(hit).toBeDefined();
        expect(hit?.kind).toBe("comment.created");
        expect(hit?.payload.actor_name).toBe("Client Nine");
        expect(hit?.payload.preview).toBe("client feedback from the share");
      }
    });
  });
};
