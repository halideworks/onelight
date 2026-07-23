import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { crc32cBase64 } from "@onelight/core";
import { jobs, projectEvents, uploadSessions } from "@onelight/db/schema";
import {
  assertSnakeCaseKeys,
  errorCode,
  forbiddenKeysIn,
  json,
  parseSse,
  req,
  wireUrl,
} from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  createProject,
  grantRole,
  seedAssetVersion,
  seedExtraVersion,
  seedRendition,
  unique,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

const encoder = new TextEncoder();

const createUpload = async (
  h: ContractHarness,
  cookie: string,
  projectId: string,
  options: { size: number; checksum?: string; filename?: string },
): Promise<{ id: string }> => {
  const response = await req(h, "/api/v1/uploads", {
    cookie,
    json: {
      project_id: projectId,
      filename: options.filename ?? `${unique("clip")}.mp4`,
      size: options.size,
      ...(options.checksum ? { checksum_crc32c: options.checksum } : {}),
    },
  });
  expect(response.status).toBe(201);
  const body = await json<{ upload: { id: string } }>(response);
  return { id: body.upload.id };
};

const initMultipart = async (
  h: ContractHarness,
  cookie: string,
  uploadId: string,
): Promise<{ upload_id: string; part_size: number }> => {
  const response = await req(h, `/api/v1/uploads/${uploadId}/multipart`, {
    method: "POST",
    cookie,
    json: {},
  });
  expect(response.status).toBe(200);
  return json(response);
};

const putPart = async (
  h: ContractHarness,
  cookie: string,
  uploadId: string,
  partNo: number,
  content: string,
): Promise<string> => {
  const response = await req(h, `/api/v1/uploads/${uploadId}/parts/${partNo}`, {
    method: "PUT",
    cookie,
    body: content,
    headers: { "content-type": "application/octet-stream" },
  });
  expect(response.status).toBe(204);
  return response.headers.get("etag") ?? "";
};

/** Direct-DB completed upload so asset attachment works without a store. */
const seedCompletedUpload = async (
  h: ContractHarness,
  options: {
    workspaceId: string;
    projectId: string;
    userId: string;
    filename?: string;
  },
): Promise<{ id: string }> => {
  const id = h.ids.ulid();
  const now = h.clock.now();
  await h.db
    .insert(uploadSessions)
    .values({
      id,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      createdBy: options.userId,
      clientFilename: options.filename ?? `${unique("attach")}.mp4`,
      relativePath: "",
      size: 10,
      checksumCrc32c: "abc",
      blobKey: `${options.workspaceId}/${options.projectId}/uploads/${id}/${options.filename ?? "attach.mp4"}`,
      uploadId: null,
      partSize: null,
      status: "completed",
      createdAt: now,
      completedAt: now,
    })
    .run();
  return { id };
};

export const registerMediaPipelineDomain = (ctx: SuiteContext): void => {
  describe("uploads", () => {
    it("creates upload sessions for editors only with a clean wire shape", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const response = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: { project_id: seed.project.id, filename: "shot.mov", size: 12 },
      });
      expect(response.status).toBe(201);
      const body = await json<{
        upload: Record<string, unknown>;
        upload_url: string;
      }>(response);
      expect(body.upload.status).toBe("pending");
      expect(body.upload.client_filename).toBe("shot.mov");
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(forbiddenKeysIn(body, ["blob_key", "blobKey"])).toEqual([]);
      const denied = await req(h, "/api/v1/uploads", {
        cookie: seed.commenter.cookie,
        json: { project_id: seed.project.id, filename: "shot.mov", size: 12 },
      });
      expect(denied.status).toBe(403);
      const traversal = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: {
          project_id: seed.project.id,
          filename: "shot.mov",
          relative_path: "a/../../b",
          size: 12,
        },
      });
      expect(traversal.status).toBe(400);
      const badSize = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: { project_id: seed.project.id, filename: "shot.mov", size: 0 },
      });
      expect(badSize.status).toBe(400);
      const foreignProject = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: {
          project_id: seed.other.projectId,
          filename: "shot.mov",
          size: 12,
        },
      });
      expect(foreignProject.status).toBe(404);
    });

    it("replays upload creation for a repeated Idempotency-Key", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const filename = `${unique("idem")}.mp4`;
      const payload = {
        project_id: seed.project.id,
        filename,
        size: 2048,
      };
      const first = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: payload,
        headers: { "idempotency-key": "contract-idem-1" },
      });
      expect(first.status).toBe(201);
      const firstBody = await json<{ upload: { id: string } }>(first);
      // The retried create returns the original still-open session (scoped
      // Idempotency-Key semantics, phase-1 section 3 supersession).
      const replay = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: payload,
        headers: { "idempotency-key": "contract-idem-1" },
      });
      expect(replay.status).toBe(200);
      const replayBody = await json<{
        upload: { id: string };
        upload_url: string;
      }>(replay);
      expect(replayBody.upload.id).toBe(firstBody.upload.id);
      expect(replayBody.upload_url).toContain(firstBody.upload.id);
      // Without the header a duplicate create opens a new session.
      const fresh = await req(h, "/api/v1/uploads", {
        cookie: seed.editor.cookie,
        json: payload,
      });
      expect(fresh.status).toBe(201);
      expect(
        (await json<{ upload: { id: string } }>(fresh)).upload.id,
      ).not.toBe(firstBody.upload.id);
    });

    ctx.itBlob(
      "initializes multipart idempotently, uploads parts, and lists them",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const upload = await createUpload(
          h,
          seed.editor.cookie,
          seed.project.id,
          {
            size: 10,
          },
        );
        const first = await initMultipart(h, seed.editor.cookie, upload.id);
        expect(first.upload_id).toBeTruthy();
        expect(first.part_size).toBeGreaterThan(0);
        const again = await initMultipart(h, seed.editor.cookie, upload.id);
        expect(again.upload_id).toBe(first.upload_id);
        expect(again.part_size).toBe(first.part_size);
        const partUrl = await req(
          h,
          `/api/v1/uploads/${upload.id}/parts/1/url`,
          { cookie: seed.editor.cookie },
        );
        expect(partUrl.status).toBe(200);
        expect((await json<{ url: string }>(partUrl)).url).toContain(
          `/uploads/${upload.id}/parts/1`,
        );
        const badPartNo = await req(h, `/api/v1/uploads/${upload.id}/parts/0`, {
          method: "PUT",
          cookie: seed.editor.cookie,
          body: "xx",
          headers: { "content-type": "application/octet-stream" },
        });
        expect(badPartNo.status).toBe(400);
        const excessivePartNo = await req(
          h,
          `/api/v1/uploads/${upload.id}/parts/8193`,
          {
            method: "PUT",
            cookie: seed.editor.cookie,
            body: "xx",
            headers: { "content-type": "application/octet-stream" },
          },
        );
        expect(excessivePartNo.status).toBe(400);
        const etag1 = await putPart(
          h,
          seed.editor.cookie,
          upload.id,
          1,
          "01234",
        );
        const etag2 = await putPart(
          h,
          seed.editor.cookie,
          upload.id,
          2,
          "56789",
        );
        expect(etag1).toBeTruthy();
        const parts = await req(h, `/api/v1/uploads/${upload.id}/parts`, {
          cookie: seed.editor.cookie,
        });
        expect(parts.status).toBe(200);
        const partsBody = await json<{
          items: Array<{ part_no: number; etag: string; size: number }>;
        }>(parts);
        expect(partsBody.items.map((item) => item.part_no)).toEqual([1, 2]);
        expect(partsBody.items[0]?.etag).toBe(etag1);
        expect(partsBody.items[1]?.etag).toBe(etag2);
      },
    );

    ctx.itBlob(
      "completes with a matching checksum and is idempotent on re-complete",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const content = "hello-upload";
        const checksum = crc32cBase64(encoder.encode(content));
        const upload = await createUpload(
          h,
          seed.editor.cookie,
          seed.project.id,
          {
            size: content.length,
            checksum,
          },
        );
        await initMultipart(h, seed.editor.cookie, upload.id);
        const etag = await putPart(
          h,
          seed.editor.cookie,
          upload.id,
          1,
          content,
        );
        const completed = await req(
          h,
          `/api/v1/uploads/${upload.id}/complete`,
          {
            method: "POST",
            cookie: seed.editor.cookie,
            json: { parts: [{ part_no: 1, etag }], checksum_crc32c: checksum },
          },
        );
        expect(completed.status).toBe(202);
        const body = await json<{ upload: Record<string, unknown> }>(completed);
        expect(body.upload.status).toBe("completed");
        expect(body.upload.completed_at).toBeTruthy();
        const recompleted = await req(
          h,
          `/api/v1/uploads/${upload.id}/complete`,
          {
            method: "POST",
            cookie: seed.editor.cookie,
            json: { parts: [{ part_no: 1, etag }], checksum_crc32c: checksum },
          },
        );
        expect(recompleted.status).toBe(202);
        expect(
          (await json<{ upload: { status: string } }>(recompleted)).upload
            .status,
        ).toBe("completed");
      },
    );

    ctx.itBlob("quarantines on checksum mismatch", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const content = "checksum-mismatch";
      const upload = await createUpload(
        h,
        seed.editor.cookie,
        seed.project.id,
        {
          size: content.length,
        },
      );
      await initMultipart(h, seed.editor.cookie, upload.id);
      const etag = await putPart(h, seed.editor.cookie, upload.id, 1, content);
      const completed = await req(h, `/api/v1/uploads/${upload.id}/complete`, {
        method: "POST",
        cookie: seed.editor.cookie,
        json: {
          parts: [{ part_no: 1, etag }],
          checksum_crc32c: "AAAAAAAA",
        },
      });
      expect(completed.status).toBe(400);
      const row = (
        await h.db
          .select()
          .from(uploadSessions)
          .where(eq(uploadSessions.id, upload.id))
          .limit(1)
          .all()
      )[0];
      expect(row?.status).toBe("quarantined");
      const resumed = await req(h, `/api/v1/uploads/${upload.id}/multipart`, {
        method: "POST",
        cookie: seed.editor.cookie,
        json: {},
      });
      expect(resumed.status).toBe(409);
    });

    ctx.itBlob("quarantines on size mismatch", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const content = "short";
      const upload = await createUpload(
        h,
        seed.editor.cookie,
        seed.project.id,
        {
          size: 9999,
        },
      );
      await initMultipart(h, seed.editor.cookie, upload.id);
      const etag = await putPart(h, seed.editor.cookie, upload.id, 1, content);
      const completed = await req(h, `/api/v1/uploads/${upload.id}/complete`, {
        method: "POST",
        cookie: seed.editor.cookie,
        json: { parts: [{ part_no: 1, etag }] },
      });
      expect(completed.status).toBe(400);
      const row = (
        await h.db
          .select()
          .from(uploadSessions)
          .where(eq(uploadSessions.id, upload.id))
          .limit(1)
          .all()
      )[0];
      expect(row?.status).toBe("quarantined");
    });

    ctx.itBlob(
      "rejects completion when a claimed part was never uploaded",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const upload = await createUpload(
          h,
          seed.editor.cookie,
          seed.project.id,
          {
            size: 5,
          },
        );
        await initMultipart(h, seed.editor.cookie, upload.id);
        const completed = await req(
          h,
          `/api/v1/uploads/${upload.id}/complete`,
          {
            method: "POST",
            cookie: seed.editor.cookie,
            json: { parts: [{ part_no: 1, etag: "fabricated" }] },
          },
        );
        expect(completed.status).toBe(400);
      },
    );

    ctx.itAssembly("assembles multiple small parts in order", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const partA = "abcd";
      const partB = "efgh";
      const upload = await createUpload(
        h,
        seed.editor.cookie,
        seed.project.id,
        {
          size: partA.length + partB.length,
        },
      );
      await initMultipart(h, seed.editor.cookie, upload.id);
      const etag1 = await putPart(h, seed.editor.cookie, upload.id, 1, partA);
      const etag2 = await putPart(h, seed.editor.cookie, upload.id, 2, partB);
      const completed = await req(h, `/api/v1/uploads/${upload.id}/complete`, {
        method: "POST",
        cookie: seed.editor.cookie,
        json: {
          parts: [
            { part_no: 2, etag: etag2 },
            { part_no: 1, etag: etag1 },
          ],
          checksum_crc32c: crc32cBase64(encoder.encode(partA + partB)),
        },
      });
      expect(completed.status).toBe(202);
    });

    ctx.itBlob("aborts uploads and refuses completing them after", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const upload = await createUpload(
        h,
        seed.editor.cookie,
        seed.project.id,
        {
          size: 4,
        },
      );
      await initMultipart(h, seed.editor.cookie, upload.id);
      const etag = await putPart(h, seed.editor.cookie, upload.id, 1, "data");
      const aborted = await req(h, `/api/v1/uploads/${upload.id}/abort`, {
        method: "POST",
        cookie: seed.editor.cookie,
      });
      expect(aborted.status).toBe(204);
      const row = (
        await h.db
          .select()
          .from(uploadSessions)
          .where(eq(uploadSessions.id, upload.id))
          .limit(1)
          .all()
      )[0];
      expect(row?.status).toBe("aborted");
      const completed = await req(h, `/api/v1/uploads/${upload.id}/complete`, {
        method: "POST",
        cookie: seed.editor.cookie,
        json: { parts: [{ part_no: 1, etag }] },
      });
      expect(completed.status).toBe(409);
    });

    it("deletes unattached uploads and 409s attached ones", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fresh = await createUpload(h, seed.editor.cookie, seed.project.id, {
        size: 4,
      });
      const deleted = await req(h, `/api/v1/uploads/${fresh.id}`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
      expect(deleted.status).toBe(204);
      const gone = await req(h, `/api/v1/uploads/${fresh.id}/parts`, {
        cookie: seed.editor.cookie,
      });
      expect(gone.status).toBe(404);
      const attached = await req(
        h,
        `/api/v1/uploads/${seed.media.uploadSessionId}`,
        { method: "DELETE", cookie: seed.editor.cookie },
      );
      expect(attached.status).toBe(409);
    });
  });

  describe("assets and versions", () => {
    /* The chosen thumbnail (migration 0019): the picture an asset shows in
       every grid and every share room, decided instead of guessed. */
    it("sets, reports and clears a chosen thumbnail", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const source = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.editor.id,
      });
      const created = await req(
        h,
        `/api/v1/projects/${seed.project.id}/assets`,
        {
          cookie: seed.editor.cookie,
          json: { upload_id: source.id, name: unique("Thumbed") },
        },
      );
      expect(created.status).toBe(201);
      const asset = await json<{ id: string }>(created);
      const fresh = await json<{ has_thumbnail: boolean }>(
        await req(h, `/api/v1/assets/${asset.id}`, {
          cookie: seed.editor.cookie,
        }),
      );
      expect(fresh.has_thumbnail).toBe(false);

      /* Only pictures: the poster pipeline is what turns footage into a
         still, and this path deliberately skips it. */
      const notAnImage = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.editor.id,
      });
      const rejected = await req(h, `/api/v1/assets/${asset.id}/thumbnail`, {
        method: "PUT",
        cookie: seed.editor.cookie,
        json: { upload_id: notAnImage.id },
      });
      expect(rejected.status).toBe(400);

      const picture = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.editor.id,
        filename: `${unique("chosen")}.png`,
      });
      const set = await req(h, `/api/v1/assets/${asset.id}/thumbnail`, {
        method: "PUT",
        cookie: seed.editor.cookie,
        json: { upload_id: picture.id },
      });
      expect(set.status).toBe(200);
      const withThumb = await json<Record<string, unknown>>(set);
      expect(withThumb.has_thumbnail).toBe(true);
      /* The blob key is the store's business and never the viewer's. */
      expect(forbiddenKeysIn(withThumb, ["blob_key", "blobKey"])).toEqual([]);
      expect(assertSnakeCaseKeys(withThumb)).toEqual([]);

      /* A commenter may look at the room but not redecorate it. */
      const denied = await req(h, `/api/v1/assets/${asset.id}/thumbnail`, {
        method: "PUT",
        cookie: seed.commenter.cookie,
        json: { upload_id: picture.id },
      });
      expect(denied.status).toBe(403);

      const cleared = await req(h, `/api/v1/assets/${asset.id}/thumbnail`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
      expect(cleared.status).toBe(204);
      const after = await req(h, `/api/v1/assets/${asset.id}`, {
        cookie: seed.editor.cookie,
      });
      expect(
        (await json<{ has_thumbnail: boolean }>(after)).has_thumbnail,
      ).toBe(false);
    });

    it("attaches a completed upload once and enqueues the probe job", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.editor.id,
      });
      const created = await req(
        h,
        `/api/v1/projects/${seed.project.id}/assets`,
        {
          cookie: seed.editor.cookie,
          json: { upload_id: upload.id, name: unique("Attached") },
        },
      );
      expect(created.status).toBe(201);
      const body = await json<{
        id: string;
        version_id: string;
        job_id: string;
        current_version_id: string;
      }>(created);
      expect(body.version_id).toBe(body.current_version_id);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      const doubled = await req(
        h,
        `/api/v1/projects/${seed.project.id}/assets`,
        {
          cookie: seed.editor.cookie,
          json: { upload_id: upload.id },
        },
      );
      expect(doubled.status).toBe(409);
      const job = await req(h, `/api/v1/jobs/${body.job_id}`, {
        cookie: seed.editor.cookie,
      });
      expect(job.status).toBe(200);
      const jobBody = await json(job);
      expect(jobBody.kind).toBe("probe");
      expect(jobBody.status).toBe("queued");
      expect(forbiddenKeysIn(jobBody, ["blob_key", "blobKey"])).toEqual([]);
      expect((jobBody.payload as Record<string, unknown>).version_id).toBe(
        body.version_id,
      );
    });

    it("rejects attaching incomplete uploads or foreign-project uploads", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const pending = await createUpload(
        h,
        seed.editor.cookie,
        seed.project.id,
        {
          size: 4,
        },
      );
      const notCompleted = await req(
        h,
        `/api/v1/projects/${seed.project.id}/assets`,
        { cookie: seed.editor.cookie, json: { upload_id: pending.id } },
      );
      expect(notCompleted.status).toBe(400);
      const otherProject = await createProject(h, seed.admin);
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: otherProject.id,
        userId: seed.admin.id,
      });
      const wrongProject = await req(
        h,
        `/api/v1/projects/${seed.project.id}/assets`,
        { cookie: seed.admin.cookie, json: { upload_id: upload.id } },
      );
      expect(wrongProject.status).toBe(400);
      const commenterDenied = await req(
        h,
        `/api/v1/projects/${seed.project.id}/assets`,
        { cookie: seed.commenter.cookie, json: { upload_id: upload.id } },
      );
      expect(commenterDenied.status).toBe(403);
    });

    it("reads and edits assets with the snake_case wire shape", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
      });
      const read = await req(h, `/api/v1/assets/${media.assetId}`, {
        cookie: seed.viewer.cookie,
      });
      expect(read.status).toBe(200);
      const asset = await json(read);
      expect(asset.tags).toEqual([]);
      expect(assertSnakeCaseKeys(asset)).toEqual([]);
      expect(forbiddenKeysIn(asset, ["blob_key", "blobKey"])).toEqual([]);
      const edited = await req(h, `/api/v1/assets/${media.assetId}`, {
        method: "PATCH",
        cookie: seed.editor.cookie,
        json: {
          name: "Edited Asset",
          description: "A cut",
          tags: ["vfx", "day-1"],
          status: "in_review",
        },
      });
      expect(edited.status).toBe(200);
      const editedBody = await json(edited);
      expect(editedBody.name).toBe("Edited Asset");
      expect(editedBody.tags).toEqual(["vfx", "day-1"]);
      const commenterDenied = await req(h, `/api/v1/assets/${media.assetId}`, {
        method: "PATCH",
        cookie: seed.commenter.cookie,
        json: { name: "Nope" },
      });
      expect(commenterDenied.status).toBe(403);
      const missing = await req(
        h,
        "/api/v1/assets/01ARZ3NDEKTSV4RRFFQ69G5FAV",
        { cookie: seed.viewer.cookie },
      );
      expect(missing.status).toBe(404);
    });

    it("paginates asset listings with cursors and filters by folder", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const seededIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const media = await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
        });
        seededIds.push(media.assetId);
      }
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
            `/api/v1/projects/${project.id}/assets?limit=2${query}`,
            {
              cookie: seed.admin.cookie,
            },
          ),
        );
        collected.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(collected).toEqual([...seededIds].reverse());
      const malformed = await req(
        h,
        `/api/v1/projects/${project.id}/assets?cursor=nope`,
        { cookie: seed.admin.cookie },
      );
      expect(malformed.status).toBe(400);
      expect(await errorCode(malformed)).toBe("validation_failed");
      const folderResponse = await req(
        h,
        `/api/v1/projects/${project.id}/folders`,
        {
          cookie: seed.admin.cookie,
          json: { name: "Filter Folder" },
        },
      );
      const folder = await json<{ id: string }>(folderResponse);
      const inFolder = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        folderId: folder.id,
      });
      const filtered = await json<{ items: Array<{ id: string }> }>(
        await req(
          h,
          `/api/v1/projects/${project.id}/assets?folder_id=${folder.id}`,
          { cookie: seed.admin.cookie },
        ),
      );
      expect(filtered.items.map((item) => item.id)).toEqual([inFolder.assetId]);
    });

    it("trashes, hides, and restores assets", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
      });
      const commenterDenied = await req(
        h,
        `/api/v1/assets/${media.assetId}/trash`,
        { method: "POST", cookie: seed.commenter.cookie },
      );
      expect(commenterDenied.status).toBe(403);
      const trashed = await req(h, `/api/v1/assets/${media.assetId}/trash`, {
        method: "POST",
        cookie: seed.editor.cookie,
      });
      expect(trashed.status).toBe(204);
      const listing = await json<{ items: Array<{ id: string }> }>(
        await req(h, `/api/v1/projects/${seed.project.id}/assets?limit=200`, {
          cookie: seed.editor.cookie,
        }),
      );
      expect(listing.items.some((item) => item.id === media.assetId)).toBe(
        false,
      );
      /* Hidden from the list is not enough: reading one by id has to refuse
         too, or a stale asset.created event puts the row back in the browser
         by fetching it straight from here. */
      const readWhileTrashed = await req(h, `/api/v1/assets/${media.assetId}`, {
        cookie: seed.editor.cookie,
      });
      expect(readWhileTrashed.status).toBe(404);
      const restored = await req(h, `/api/v1/assets/${media.assetId}/restore`, {
        method: "POST",
        cookie: seed.editor.cookie,
      });
      expect(restored.status).toBe(200);
      expect((await json(restored)).deleted_at).toBeNull();
      const readAfterRestore = await req(h, `/api/v1/assets/${media.assetId}`, {
        cookie: seed.editor.cookie,
      });
      expect(readAfterRestore.status).toBe(200);
      const softDeleted = await req(h, `/api/v1/assets/${media.assetId}`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
      expect(softDeleted.status).toBe(204);
    });

    it("lists versions, mutates the stack, and validates version numbers", async () => {
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
      const versions = await req(
        h,
        `/api/v1/assets/${media.assetId}/versions`,
        {
          cookie: seed.viewer.cookie,
        },
      );
      expect(versions.status).toBe(200);
      const versionsBody = await json<{
        items: Array<{ id: string; version_no: number }>;
      }>(versions);
      expect(versionsBody.items.map((item) => item.version_no)).toEqual([2, 1]);
      expect(
        forbiddenKeysIn(versionsBody, [
          "original_blob_key",
          "originalBlobKey",
          "upload_session_id",
          "uploadSessionId",
        ]),
      ).toEqual([]);
      const version = await req(h, `/api/v1/versions/${second.versionId}`, {
        cookie: seed.viewer.cookie,
      });
      expect(version.status).toBe(200);
      const versionBody = await json(version);
      expect(versionBody.asset_id).toBe(media.assetId);
      expect(versionBody.frame_rate_num).toBe(24);
      expect(assertSnakeCaseKeys(versionBody)).toEqual([]);
      const editorDenied = await req(
        h,
        `/api/v1/versions/${second.versionId}/stack`,
        {
          method: "PATCH",
          cookie: seed.editor.cookie,
          json: { version_no: 1 },
        },
      );
      expect(editorDenied.status).toBe(403);
      const stacked = await req(
        h,
        `/api/v1/versions/${second.versionId}/stack`,
        {
          method: "PATCH",
          cookie: seed.manager.cookie,
          json: { version_no: 1 },
        },
      );
      expect(stacked.status).toBe(200);
      const stackedBody = await json<{ current_version_id: string }>(stacked);
      expect(stackedBody.current_version_id).toBe(media.versionId);
      const badNo = await req(h, `/api/v1/versions/${second.versionId}/stack`, {
        method: "PATCH",
        cookie: seed.manager.cookie,
        json: { version_no: 42 },
      });
      expect(badNo.status).toBe(404);
    });

    it("serves rendition metadata with signed URLs when a store exists", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
      });
      const rendition = await seedRendition(h, { versionId: media.versionId });
      const response = await req(
        h,
        `/api/v1/versions/${media.versionId}/renditions`,
        { cookie: seed.viewer.cookie },
      );
      expect(response.status).toBe(200);
      const body = await json<{
        items: Array<{ id: string; kind: string; url: string | null }>;
      }>(response);
      const item = body.items.find((entry) => entry.id === rendition.id);
      expect(item?.kind).toBe("proxy_1080");
      if (ctx.caps.blob) expect(item?.url).toContain("token=");
      else expect(item?.url).toBeNull();
    });
  });

  describe("jobs", () => {
    it("serves job status scoped to the workspace with admin queue filters", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const jobId = h.ids.ulid();
      const now = h.clock.now();
      await h.db
        .insert(jobs)
        .values({
          id: jobId,
          kind: "probe",
          payloadJson: JSON.stringify({
            workspace_id: seed.workspaceId,
            project_id: seed.project.id,
            blob_key: "secret/key.mp4",
          }),
          idempotencyKey: `probe:${jobId}`,
          status: "queued",
          priority: 0,
          capabilityJson: "{}",
          maxAttempts: 5,
          attempts: 0,
          runAfter: now,
          createdAt: now,
          startedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          finishedAt: null,
          error: null,
          workerId: null,
        })
        .run();
      const job = await req(h, `/api/v1/jobs/${jobId}`, {
        cookie: seed.viewer.cookie,
      });
      expect(job.status).toBe(200);
      const jobBody = await json(job);
      expect(
        (jobBody.payload as Record<string, unknown>).blob_key,
      ).toBeUndefined();
      const foreign = await req(h, `/api/v1/jobs/${jobId}`, {
        cookie: seed.other.admin.cookie,
      });
      expect(foreign.status).toBe(404);
      const adminList = await req(h, "/api/v1/admin/jobs?status=queued", {
        cookie: seed.admin.cookie,
      });
      expect(adminList.status).toBe(200);
      const adminBody = await json<{ items: Array<{ id: string }> }>(adminList);
      expect(adminBody.items.some((item) => item.id === jobId)).toBe(true);
      const memberDenied = await req(h, "/api/v1/admin/jobs", {
        cookie: seed.manager.cookie,
      });
      expect(memberDenied.status).toBe(403);
      const badStatus = await req(h, "/api/v1/admin/jobs?status=bogus", {
        cookie: seed.admin.cookie,
      });
      expect(badStatus.status).toBe(400);
      const foreignQueue = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/admin/jobs?limit=200", {
          cookie: seed.other.admin.cookie,
        }),
      );
      expect(foreignQueue.items.some((item) => item.id === jobId)).toBe(false);
    });
  });

  describe("project events (SSE)", () => {
    it("replays events and honors Last-Event-ID without loss or duplication", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      await grantRole(h, seed.admin, project.id, seed.viewer.id, "viewer");
      const extraIds: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const id = h.ids.ulid();
        extraIds.push(id);
        await h.db
          .insert(projectEvents)
          .values({
            id,
            projectId: project.id,
            type: "contract.test",
            payloadJson: JSON.stringify({ index }),
            createdAt: h.clock.now(),
          })
          .run();
      }
      /* A first connection replays nothing: it gets one cursor naming the
         newest event, which is what the browser sends back as Last-Event-ID.
         Replaying here re-announced every historical asset.created to a
         client that had just loaded the same assets over REST. */
      const fresh = await req(h, `/api/v1/projects/${project.id}/events`, {
        cookie: seed.viewer.cookie,
      });
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("content-type")).toContain("text/event-stream");
      const opening = parseSse(await fresh.text());
      expect(opening.map((event) => event.event)).toEqual(["stream.cursor"]);
      const cursor = opening[0]?.id ?? "";
      expect(cursor).toBe(extraIds[1]);

      /* Reconnecting on that cursor is caught up, and stays caught up until
         something new lands. */
      const caughtUp = parseSse(
        await (
          await req(h, `/api/v1/projects/${project.id}/events`, {
            cookie: seed.viewer.cookie,
            headers: { "last-event-id": cursor },
          })
        ).text(),
      );
      expect(caughtUp).toEqual([]);

      const freshId = h.ids.ulid();
      await h.db
        .insert(projectEvents)
        .values({
          id: freshId,
          projectId: project.id,
          type: "contract.test",
          payloadJson: JSON.stringify({ index: 2 }),
          createdAt: h.clock.now(),
        })
        .run();
      const delivered = parseSse(
        await (
          await req(h, `/api/v1/projects/${project.id}/events`, {
            cookie: seed.viewer.cookie,
            headers: { "last-event-id": cursor },
          })
        ).text(),
      );
      expect(delivered.map((event) => event.id)).toEqual([freshId]);

      /* Catch-up from an older anchor still returns everything after it, in
         order, with no duplicates and no cursor mixed in. */
      const anchor = extraIds[0] ?? "";
      const replayed = parseSse(
        await (
          await req(h, `/api/v1/projects/${project.id}/events`, {
            cookie: seed.viewer.cookie,
            headers: { "last-event-id": anchor },
          })
        ).text(),
      );
      const replayedIds = replayed.map((event) => event.id);
      expect(replayedIds).toEqual([extraIds[1], freshId]);
      expect(new Set(replayedIds).size).toBe(replayedIds.length);
      expect(replayedIds).toEqual([...replayedIds].sort());
      expect(replayed.every((event) => event.event !== "stream.cursor")).toBe(
        true,
      );

      const foreign = await req(h, `/api/v1/projects/${project.id}/events`, {
        cookie: seed.other.admin.cookie,
      });
      expect(foreign.status).toBe(404);
    });

    /* A project with no events yet cannot name a newest id. The floor cursor
       keeps such a client subscribed to whatever arrives next instead of
       pinning it to an id that never comes. */
    it("hands an empty project a floor cursor that still delivers later events", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      await h.db
        .delete(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .run();
      const opening = parseSse(
        await (
          await req(h, `/api/v1/projects/${project.id}/events`, {
            cookie: seed.admin.cookie,
          })
        ).text(),
      );
      expect(opening.map((event) => event.event)).toEqual(["stream.cursor"]);
      expect(opening[0]?.id).toBe("0");

      const laterId = h.ids.ulid();
      await h.db
        .insert(projectEvents)
        .values({
          id: laterId,
          projectId: project.id,
          type: "contract.test",
          payloadJson: "{}",
          createdAt: h.clock.now(),
        })
        .run();
      const delivered = parseSse(
        await (
          await req(h, `/api/v1/projects/${project.id}/events`, {
            cookie: seed.admin.cookie,
            headers: { "last-event-id": "0" },
          })
        ).text(),
      );
      expect(delivered.map((event) => event.id)).toEqual([laterId]);
    });

    it("keeps a live event stream open and wakes it without polling", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const opening = parseSse(
        await (
          await req(h, `/api/v1/projects/${seed.project.id}/events`, {
            cookie: seed.commenter.cookie,
          })
        ).text(),
      );
      const cursor = opening[0]?.id ?? "0";
      const abort = new AbortController();
      const live = await h.app.request(
        `/api/v1/projects/${seed.project.id}/events`,
        {
          headers: {
            accept: "text/event-stream",
            cookie: seed.commenter.cookie,
            "last-event-id": cursor,
          },
          signal: abort.signal,
        },
      );
      expect(live.status).toBe(200);
      const reader = live.body?.getReader();
      expect(reader).toBeTruthy();
      if (!reader) throw new Error("The live event stream has no body.");

      const posted = await req(
        h,
        `/api/v1/versions/${seed.media.versionId}/comments`,
        {
          cookie: seed.commenter.cookie,
          json: { body_text: "wake the stream" },
        },
      );
      expect(posted.status).toBe(201);
      let received = "";
      const decoder = new TextDecoder();
      const deadline = Date.now() + 2_000;
      while (!received.includes("event: comment.created")) {
        if (Date.now() >= deadline)
          throw new Error("The live event stream did not wake.");
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("The live event stream stalled.")),
              2_000,
            );
          }),
        ]);
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("event: comment.created");
      abort.abort();
      await reader.cancel();
    });
  });

  describe("private media route", () => {
    ctx.itBlob(
      "requires a valid token and serves ranges with 206/416 semantics",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const media = await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: seed.project.id,
          userId: seed.admin.id,
        });
        const rendition = await seedRendition(h, {
          versionId: media.versionId,
          content: "0123456789abcdef",
        });
        const listing = await json<{
          items: Array<{ id: string; url: string | null }>;
        }>(
          await req(h, `/api/v1/versions/${media.versionId}/renditions`, {
            cookie: seed.viewer.cookie,
          }),
        );
        const url = listing.items.find((item) => item.id === rendition.id)?.url;
        expect(url).toBeTruthy();
        const parsed = wireUrl(url);
        const withToken = await req(h, parsed.pathname + parsed.search, {
          cookie: seed.viewer.cookie,
        });
        expect(withToken.status).toBe(200);
        expect(await withToken.text()).toBe("0123456789abcdef");
        expect(withToken.headers.get("accept-ranges")).toBe("bytes");
        const noToken = await req(h, parsed.pathname, {
          cookie: seed.viewer.cookie,
        });
        expect(noToken.status).toBe(401);
        const noAuth = await req(h, parsed.pathname + parsed.search);
        expect(noAuth.status).toBe(401);
        const badToken = await req(h, `${parsed.pathname}?token=garbage`, {
          cookie: seed.viewer.cookie,
        });
        expect(badToken.status).toBe(401);
        const ranged = await req(h, parsed.pathname + parsed.search, {
          cookie: seed.viewer.cookie,
          headers: { range: "bytes=4-7" },
        });
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("content-range")).toBe("bytes 4-7/16");
        expect(await ranged.text()).toBe("4567");
        const suffix = await req(h, parsed.pathname + parsed.search, {
          cookie: seed.viewer.cookie,
          headers: { range: "bytes=-4" },
        });
        expect(suffix.status).toBe(206);
        expect(await suffix.text()).toBe("cdef");
        const unsatisfiable = await req(h, parsed.pathname + parsed.search, {
          cookie: seed.viewer.cookie,
          headers: { range: "bytes=99-" },
        });
        expect(unsatisfiable.status).toBe(416);
        expect(unsatisfiable.headers.get("content-range")).toBe("bytes */16");
      },
    );
  });
};
