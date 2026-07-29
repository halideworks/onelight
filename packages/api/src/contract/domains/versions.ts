import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  assetVersions,
  jobs,
  projectEvents,
  projects,
  uploadSessions,
} from "@onelight/db/schema";
import { errorCode, json, req } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  createProject,
  createUser,
  grantRole,
  seedAssetVersion,
  seedCompletedUpload,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

interface VersionCreateResponse {
  asset: {
    id: string;
    name: string;
    current_version_id: string;
    updated_at: number;
  };
  version: { id: string; version_no: number; uploaded_by: string };
  job_id: string;
}

const listNotifications = async (
  h: ContractHarness,
  cookie: string,
): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> =>
  (
    await json<{
      items: Array<{ kind: string; payload: Record<string, unknown> }>;
    }>(await req(h, "/api/v1/notifications?limit=200", { cookie }))
  ).items;

export const registerVersionsDomain = (ctx: SuiteContext): void => {
  describe("captions", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello there\n";

    it("uploads a WebVTT per language and serves it with the renditions", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const put = (
        cookie: string,
        query = "language=en&label=English",
        body = vtt,
      ) =>
        req(h, `/api/v1/versions/${seed.media.versionId}/captions?${query}`, {
          method: "PUT",
          cookie,
          headers: { "content-type": "text/vtt" },
          body,
        });
      const denied = await put(seed.commenter.cookie);
      expect(denied.status).toBe(403);
      const notVtt = await put(
        seed.editor.cookie,
        "language=en",
        "1\n00:00:01,000 --> 00:00:02,000\nSRT lines",
      );
      expect(notVtt.status).toBe(400);
      const badLang = await put(seed.editor.cookie, "language=english!!");
      expect(badLang.status).toBe(400);
      const created = await put(seed.editor.cookie);
      expect(created.status).toBe(201);
      const track = await json<{
        language: string;
        label: string;
        url: string;
      }>(created);
      expect(track).toMatchObject({ language: "en", label: "English" });
      const parsedUrl = new URL(track.url, "http://contract.invalid");
      const fetched = await req(h, parsedUrl.pathname + parsedUrl.search, {
        cookie: seed.editor.cookie,
      });
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe(vtt);
      // Replace-on-put: same language, new content, still one track.
      const replaced = await put(
        seed.editor.cookie,
        "language=en&label=English",
        vtt.replace("Hello there", "Hello again"),
      );
      expect(replaced.status).toBe(201);
      const listing = await json<{ captions: Array<{ language: string }> }>(
        await req(h, `/api/v1/versions/${seed.media.versionId}/renditions`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(listing.captions).toHaveLength(1);
      const removed = await req(
        h,
        `/api/v1/versions/${seed.media.versionId}/captions/en`,
        { method: "DELETE", cookie: seed.editor.cookie },
      );
      expect(removed.status).toBe(204);
      const after = await json<{ captions: unknown[] }>(
        await req(h, `/api/v1/versions/${seed.media.versionId}/renditions`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(after.captions).toHaveLength(0);
    });
  });

  describe("version stacking", () => {
    /* Fresh users and project per test so notification rows never bleed. */
    const fixture = async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const mk = () =>
        createUser(h, {
          workspaceId: seed.workspaceId,
          passwordHash: seed.passwordHash,
        });
      const [uploader, manager, editor, commenter] = await Promise.all([
        mk(),
        mk(),
        mk(),
        mk(),
      ]);
      await grantRole(h, seed.admin, project.id, manager.id, "manager");
      await grantRole(h, seed.admin, project.id, editor.id, "editor");
      await grantRole(h, seed.admin, project.id, commenter.id, "commenter");
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: uploader.id,
      });
      return { h, seed, project, uploader, manager, editor, commenter, media };
    };

    const attach = async (
      h: ContractHarness,
      cookie: string,
      assetId: string,
      body: Record<string, unknown>,
    ): Promise<Response> =>
      req(h, `/api/v1/assets/${assetId}/versions`, { cookie, json: body });

    it("attaches a completed upload as the next current version with probe, accounting, event, and notifications", async () => {
      const { h, seed, project, uploader, manager, editor, media } =
        await fixture();
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: editor.id,
      });
      const bytesBefore =
        (
          await h.db
            .select({ storageBytes: projects.storageBytes })
            .from(projects)
            .where(eq(projects.id, project.id))
            .limit(1)
            .all()
        )[0]?.storageBytes ?? 0;
      h.clock.advance(5_000);
      const created = await attach(h, editor.cookie, media.assetId, {
        upload_id: upload.id,
      });
      expect(created.status).toBe(201);
      const body = await json<VersionCreateResponse>(created);
      expect(body.version.version_no).toBe(2);
      expect(body.version.uploaded_by).toBe(editor.id);
      expect(body.asset.current_version_id).toBe(body.version.id);
      expect(body.asset.updated_at).toBe(h.clock.now());
      expect(body.job_id).toBeTruthy();
      // The probe job is enqueued exactly like the initial attach.
      const job = (
        await h.db
          .select()
          .from(jobs)
          .where(eq(jobs.id, body.job_id))
          .limit(1)
          .all()
      )[0];
      expect(job?.kind).toBe("probe");
      expect(job?.idempotencyKey).toBe(`probe:${body.version.id}`);
      expect(JSON.parse(job?.payloadJson ?? "{}")).toMatchObject({
        project_id: project.id,
        asset_id: media.assetId,
        version_id: body.version.id,
      });
      // Storage accounting moves with the upload size.
      const bytesAfter =
        (
          await h.db
            .select({ storageBytes: projects.storageBytes })
            .from(projects)
            .where(eq(projects.id, project.id))
            .limit(1)
            .all()
        )[0]?.storageBytes ?? 0;
      expect(bytesAfter).toBe(bytesBefore + upload.size);
      // Live-update event with the documented payload.
      const events = await h.db
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .all();
      const versionEvent = events.find(
        (event: { type: string }) => event.type === "asset.version_created",
      );
      expect(versionEvent).toBeDefined();
      expect(JSON.parse(versionEvent?.payloadJson ?? "{}")).toEqual({
        asset_id: media.assetId,
        version_id: body.version.id,
        version_no: 2,
        job_id: body.job_id,
      });
      // Prior-version uploaders and managers are notified, never the actor.
      const uploaderHit = (await listNotifications(h, uploader.cookie)).find(
        (item) =>
          item.kind === "version.created" &&
          item.payload.version_id === body.version.id,
      );
      expect(uploaderHit).toBeDefined();
      expect(uploaderHit?.payload.version_no).toBe(2);
      expect(uploaderHit?.payload.asset_id).toBe(media.assetId);
      expect(
        (await listNotifications(h, manager.cookie)).some(
          (item) =>
            item.kind === "version.created" &&
            item.payload.version_id === body.version.id,
        ),
      ).toBe(true);
      expect(
        (await listNotifications(h, editor.cookie)).some(
          (item) => item.kind === "version.created",
        ),
      ).toBe(false);
      // The version_no sequence keeps counting on the next attach.
      const secondUpload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: editor.id,
      });
      const second = await attach(h, editor.cookie, media.assetId, {
        upload_id: secondUpload.id,
        name: "renamed by v3",
      });
      expect(second.status).toBe(201);
      const secondBody = await json<VersionCreateResponse>(second);
      expect(secondBody.version.version_no).toBe(3);
      expect(secondBody.asset.current_version_id).toBe(secondBody.version.id);
      expect(secondBody.asset.name).toBe("renamed by v3");
    });

    it("carries unresolved comments forward from the previous current version only when requested", async () => {
      const { h, seed, project, editor, commenter, media } = await fixture();
      const post = (versionId: string, body: Record<string, unknown>) =>
        req(h, `/api/v1/versions/${versionId}/comments`, {
          cookie: commenter.cookie,
          json: body,
        });
      const open = await json<{ id: string }>(
        await post(media.versionId, { frame_in: 7, body_text: "open note" }),
      );
      const done = await json<{ id: string }>(
        await post(media.versionId, { frame_in: 8, body_text: "done note" }),
      );
      await req(h, `/api/v1/comments/${done.id}/complete`, {
        method: "POST",
        cookie: commenter.cookie,
      });
      const gone = await json<{ id: string }>(
        await post(media.versionId, { frame_in: 9, body_text: "deleted note" }),
      );
      await req(h, `/api/v1/comments/${gone.id}`, {
        method: "DELETE",
        cookie: commenter.cookie,
      });
      await req(h, `/api/v1/comments/${open.id}/replies`, {
        cookie: commenter.cookie,
        json: { body_text: "reply that must not copy" },
      });
      const carriedUpload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: editor.id,
      });
      const carried = await req(h, `/api/v1/assets/${media.assetId}/versions`, {
        cookie: editor.cookie,
        json: { upload_id: carriedUpload.id, carry_forward: true },
      });
      expect(carried.status).toBe(201);
      const carriedBody = await json<VersionCreateResponse>(carried);
      const copies = await json<{
        items: Array<Record<string, unknown>>;
      }>(
        await req(h, `/api/v1/versions/${carriedBody.version.id}/comments`, {
          cookie: commenter.cookie,
        }),
      );
      expect(copies.items).toHaveLength(1);
      expect(copies.items[0]?.body_text).toBe("open note");
      expect(copies.items[0]?.frame_in).toBe(7);
      expect(copies.items[0]?.carried_from_comment_id).toBe(open.id);
      // Without the flag nothing copies, even with open comments upstream.
      const plainUpload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: editor.id,
      });
      const plain = await req(h, `/api/v1/assets/${media.assetId}/versions`, {
        cookie: editor.cookie,
        json: { upload_id: plainUpload.id },
      });
      expect(plain.status).toBe(201);
      const plainBody = await json<VersionCreateResponse>(plain);
      const empty = await json<{ items: unknown[] }>(
        await req(h, `/api/v1/versions/${plainBody.version.id}/comments`, {
          cookie: commenter.cookie,
        }),
      );
      expect(empty.items).toHaveLength(0);
    });

    it("rejects double attach, incomplete or cross-project uploads, and enforces permissions", async () => {
      const { h, seed, project, editor, commenter, media } = await fixture();
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: editor.id,
      });
      const denied = await req(h, `/api/v1/assets/${media.assetId}/versions`, {
        cookie: commenter.cookie,
        json: { upload_id: upload.id },
      });
      expect(denied.status).toBe(403);
      const first = await req(h, `/api/v1/assets/${media.assetId}/versions`, {
        cookie: editor.cookie,
        json: { upload_id: upload.id },
      });
      expect(first.status).toBe(201);
      const doubled = await req(h, `/api/v1/assets/${media.assetId}/versions`, {
        cookie: editor.cookie,
        json: { upload_id: upload.id },
      });
      expect(doubled.status).toBe(409);
      expect(await errorCode(doubled)).toBe("conflict");
      const pendingUpload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: editor.id,
        status: "pending",
      });
      const incomplete = await req(
        h,
        `/api/v1/assets/${media.assetId}/versions`,
        { cookie: editor.cookie, json: { upload_id: pendingUpload.id } },
      );
      expect(incomplete.status).toBe(409);
      const foreignProjectUpload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.editor.id,
      });
      const crossProject = await req(
        h,
        `/api/v1/assets/${media.assetId}/versions`,
        {
          cookie: seed.admin.cookie,
          json: { upload_id: foreignProjectUpload.id },
        },
      );
      expect(crossProject.status).toBe(409);
      // Cross-workspace callers see a 404, not a 403: existence never leaks.
      const crossWorkspace = await req(
        h,
        `/api/v1/assets/${media.assetId}/versions`,
        {
          cookie: seed.other.admin.cookie,
          json: { upload_id: upload.id },
        },
      );
      expect(crossWorkspace.status).toBe(404);
    });
  });

  describe("batch versioning", () => {
    /* The complaint: dragging 1200 version 2s onto 1200 version 1s. What has
       to be true for the answer to be trustworthy is that it never guesses. */
    it("offers matches for a second pass and never guesses on a tie", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Stills" });
      /* Two originals in the project, one of them duplicated under a name
         that normalizes to the same key. */
      for (const name of ["IMG_0431.jpg", "IMG_0432.jpg", "Poster.psd"]) {
        const upload = await seedCompletedUpload(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          filename: name,
        });
        const created = await req(h, `/api/v1/projects/${project.id}/assets`, {
          cookie: seed.admin.cookie,
          json: { upload_id: upload.id },
        });
        expect(created.status).toBe(201);
      }
      const response = await req(
        h,
        `/api/v1/projects/${project.id}/versions/match`,
        {
          cookie: seed.admin.cookie,
          json: {
            files: [
              { filename: "IMG_0431_v2.jpg" },
              { filename: "IMG_0432 copy.jpg" },
              { filename: "Poster_final.psd" },
              { filename: "IMG_0433.jpg" },
            ],
          },
        },
      );
      expect(response.status).toBe(200);
      const body = await json<{
        items: Array<{
          filename: string;
          asset_id: string | null;
          asset_name: string | null;
          rule: string;
          version_token: string | null;
        }>;
        matched: number;
        unmatched: number;
        ambiguous: number;
      }>(response);
      expect(body.matched).toBe(3);
      expect(body.unmatched).toBe(1);
      expect(body.ambiguous).toBe(0);
      const byName = new Map(body.items.map((item) => [item.filename, item]));
      expect(byName.get("IMG_0431_v2.jpg")?.asset_name).toBe("IMG_0431.jpg");
      expect(byName.get("IMG_0431_v2.jpg")?.version_token).toBe("v2");
      expect(byName.get("IMG_0432 copy.jpg")?.asset_name).toBe("IMG_0432.jpg");
      expect(byName.get("Poster_final.psd")?.asset_name).toBe("Poster.psd");
      /* A frame that is simply the next one along is NOT a version of the
         one before it. */
      expect(byName.get("IMG_0433.jpg")?.asset_id).toBeNull();
      expect(byName.get("IMG_0433.jpg")?.rule).toBe("none");
    });

    it("reports a tie as ambiguous with its candidates", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Ambiguous" });
      /* Same picture delivered twice under names that normalize alike. */
      for (const name of ["Shot-01.jpg", "shot_01.tif"]) {
        const upload = await seedCompletedUpload(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          filename: name,
        });
        await req(h, `/api/v1/projects/${project.id}/assets`, {
          cookie: seed.admin.cookie,
          json: { upload_id: upload.id },
        });
      }
      const response = await req(
        h,
        `/api/v1/projects/${project.id}/versions/match`,
        {
          cookie: seed.admin.cookie,
          json: { files: [{ filename: "Shot-01_v2.psd" }] },
        },
      );
      const body = await json<{
        items: Array<{
          rule: string;
          asset_id: string | null;
          candidates: Array<{ asset_id: string; asset_name: string }>;
        }>;
        ambiguous: number;
      }>(response);
      expect(body.ambiguous).toBe(1);
      expect(body.items[0]?.asset_id).toBeNull();
      expect(body.items[0]?.rule).toBe("ambiguous");
      expect(body.items[0]?.candidates).toHaveLength(2);
    });

    it("commits a batch with one event and one notification", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Batch" });
      await grantRole(h, seed.admin, project.id, seed.editor.id, "editor");
      const assetIds: string[] = [];
      for (const name of ["A001.jpg", "A002.jpg", "A003.jpg"]) {
        const upload = await seedCompletedUpload(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          filename: name,
        });
        const created = await req(h, `/api/v1/projects/${project.id}/assets`, {
          cookie: seed.admin.cookie,
          json: { upload_id: upload.id },
        });
        assetIds.push((await json<{ id: string }>(created)).id);
      }
      const uploads: string[] = [];
      for (const name of ["A001_v2.jpg", "A002_v2.jpg", "A003_v2.jpg"])
        uploads.push(
          (
            await seedCompletedUpload(h, {
              workspaceId: seed.workspaceId,
              projectId: project.id,
              userId: seed.editor.id,
              filename: name,
            })
          ).id,
        );
      const before = (
        await h.db
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id))
          .all()
      ).length;
      const response = await req(
        h,
        `/api/v1/projects/${project.id}/versions/batch`,
        {
          cookie: seed.editor.cookie,
          json: {
            carry_forward: true,
            items: uploads.map((uploadId, index) => ({
              upload_id: uploadId,
              asset_id: assetIds[index] as string,
            })),
          },
        },
      );
      expect(response.status).toBe(201);
      const body = await json<{
        items: Array<{ asset_id: string; version_no: number; job_id: string }>;
        failures: unknown[];
      }>(response);
      expect(body.items).toHaveLength(3);
      expect(body.failures).toEqual([]);
      for (const item of body.items) expect(item.version_no).toBe(2);
      /* One event for the batch. */
      const events = await h.db
        .select()
        .from(projectEvents)
        .where(eq(projectEvents.projectId, project.id))
        .all();
      expect(events.length).toBe(before + 1);
      expect(events[events.length - 1]?.type).toBe(
        "asset.versions_created_batch",
      );
      /* One notification for the batch, not one per file. */
      const notifications = (
        await listNotifications(h, seed.admin.cookie)
      ).filter((entry) => entry.kind === "versions.created_batch");
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.payload.count).toBe(3);
      /* Every new version still gets its own probe job. */
      for (const item of body.items) {
        const job = await req(h, `/api/v1/jobs/${item.job_id}`, {
          cookie: seed.editor.cookie,
        });
        expect(job.status).toBe(200);
      }
    });

    it("reports a failed pairing without sinking the batch", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Partial" });
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "B001.jpg",
      });
      const created = await req(h, `/api/v1/projects/${project.id}/assets`, {
        cookie: seed.admin.cookie,
        json: { upload_id: upload.id },
      });
      const assetId = (await json<{ id: string }>(created)).id;
      const good = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "B001_v2.jpg",
      });
      const pending = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "B001_v3.jpg",
        status: "pending",
      });
      const response = await req(
        h,
        `/api/v1/projects/${project.id}/versions/batch`,
        {
          cookie: seed.admin.cookie,
          json: {
            items: [
              { upload_id: good.id, asset_id: assetId },
              { upload_id: pending.id, asset_id: assetId },
            ],
          },
        },
      );
      expect(response.status).toBe(201);
      const body = await json<{
        items: Array<{ upload_id: string }>;
        failures: Array<{ upload_id: string }>;
      }>(response);
      expect(body.items.map((item) => item.upload_id)).toEqual([good.id]);
      expect(body.failures.map((failure) => failure.upload_id)).toEqual([
        pending.id,
      ]);
    });

    /* --- what a file IS, when its name says nothing --- */

    const fingerprintUpload = async (
      h: ContractHarness,
      uploadId: string,
      fields: { captureKey?: string; contentHash?: string; audioHash?: string },
    ): Promise<void> => {
      await h.db
        .update(uploadSessions)
        .set({
          ...(fields.captureKey ? { captureKey: fields.captureKey } : {}),
          ...(fields.contentHash ? { contentHash: fields.contentHash } : {}),
          ...(fields.audioHash ? { audioHash: fields.audioHash } : {}),
          fingerprintState: "ready",
        })
        .where(eq(uploadSessions.id, uploadId))
        .run();
    };

    const fingerprintVersion = async (
      h: ContractHarness,
      versionId: string,
      fields: { captureKey?: string; contentHash?: string; audioHash?: string },
    ): Promise<void> => {
      await h.db
        .update(assetVersions)
        .set({
          ...(fields.captureKey ? { captureKey: fields.captureKey } : {}),
          ...(fields.contentHash ? { contentHash: fields.contentHash } : {}),
          ...(fields.audioHash ? { audioHash: fields.audioHash } : {}),
        })
        .where(eq(assetVersions.id, versionId))
        .run();
    };

    const landAsset = async (
      h: ContractHarness,
      seed: ReturnType<SuiteContext["seed"]>,
      projectId: string,
      name: string,
    ): Promise<{ assetId: string; versionId: string }> => {
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId,
        userId: seed.admin.id,
        filename: name,
      });
      const created = await req(h, `/api/v1/projects/${projectId}/assets`, {
        cookie: seed.admin.cookie,
        json: { upload_id: upload.id },
      });
      const body = await json<{ id: string; version_id: string }>(created);
      return { assetId: body.id, versionId: body.version_id };
    };

    it("pairs a renamed retouch by the instant it was taken", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Capture" });
      const original = await landAsset(h, seed, project.id, "DSC_1234.NEF");
      const decoy = await landAsset(h, seed, project.id, "DSC_1235.NEF");
      await fingerprintVersion(h, original.versionId, {
        captureKey: "2026:07:29 14:03:11.470|nikon z 9 3005421|",
      });
      await fingerprintVersion(h, decoy.versionId, {
        captureKey: "2026:07:29 14:03:12.470|nikon z 9 3005421|",
      });
      /* The delivery comes back under a name that shares nothing with the
         original: only the capture identity can join them. */
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "Smith_Wedding_047_final.tif",
      });
      await fingerprintUpload(h, upload.id, {
        captureKey: "2026:07:29 14:03:11.470|nikon z 9 3005421|",
      });
      const response = await req(
        h,
        `/api/v1/projects/${project.id}/versions/match`,
        {
          cookie: seed.admin.cookie,
          json: {
            files: [
              { filename: "Smith_Wedding_047_final.tif", upload_id: upload.id },
            ],
          },
        },
      );
      const body = await json<{
        items: Array<{
          asset_id: string | null;
          asset_name: string;
          rule: string;
        }>;
        matched: number;
        pending: number;
      }>(response);
      expect(body.matched).toBe(1);
      expect(body.pending).toBe(0);
      expect(body.items[0]?.rule).toBe("capture-time");
      expect(body.items[0]?.asset_name).toBe("DSC_1234.NEF");
      expect(body.items[0]?.asset_id).toBe(original.assetId);
    });

    it("refuses a capture key two assets share", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Twins" });
      const a = await landAsset(h, seed, project.id, "A.jpg");
      const b = await landAsset(h, seed, project.id, "B.jpg");
      const shared = "2026:07:29 14:03:11.470|nikon z 9|";
      await fingerprintVersion(h, a.versionId, { captureKey: shared });
      await fingerprintVersion(h, b.versionId, { captureKey: shared });
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "renamed.tif",
      });
      await fingerprintUpload(h, upload.id, { captureKey: shared });
      const body = await json<{
        items: Array<{
          asset_id: string | null;
          rule: string;
          candidates: unknown[];
        }>;
        ambiguous: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: { files: [{ filename: "renamed.tif", upload_id: upload.id }] },
        }),
      );
      expect(body.ambiguous).toBe(1);
      expect(body.items[0]?.asset_id).toBeNull();
      expect(body.items[0]?.candidates).toHaveLength(2);
    });

    it("suggests by the picture, and refuses when two frames are equally close", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Burst" });
      const target = await landAsset(h, seed, project.id, "frame-a.jpg");
      const neighbour = await landAsset(h, seed, project.id, "frame-b.jpg");
      /* One bit from the upload, and far from anything else: the retouch. */
      await fingerprintVersion(h, target.versionId, {
        contentHash: "0000000000000001",
      });
      /* Far away: a different set-up. */
      await fingerprintVersion(h, neighbour.versionId, {
        contentHash: "ffffffffffff0000",
      });
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "totally-different-name.png",
      });
      await fingerprintUpload(h, upload.id, {
        contentHash: "0000000000000000",
      });
      const clear = await json<{
        items: Array<{
          rule: string;
          asset_id: string | null;
          distance?: number;
        }>;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [
              { filename: "totally-different-name.png", upload_id: upload.id },
            ],
          },
        }),
      );
      expect(clear.items[0]?.rule).toBe("perceptual");
      expect(clear.items[0]?.asset_id).toBe(target.assetId);
      expect(clear.items[0]?.distance).toBe(1);

      /* Now make the neighbour a burst frame: three bits away, which is what
         a real sequence looks like. The margin rule has to refuse. */
      await fingerprintVersion(h, neighbour.versionId, {
        contentHash: "0000000000000007",
      });
      const tie = await json<{
        items: Array<{
          rule: string;
          asset_id: string | null;
          candidates: unknown[];
        }>;
        ambiguous: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [
              { filename: "totally-different-name.png", upload_id: upload.id },
            ],
          },
        }),
      );
      expect(tie.ambiguous).toBe(1);
      expect(tie.items[0]?.asset_id).toBeNull();
      expect(tie.items[0]?.rule).toBe("ambiguous");
      expect((tie.items[0]?.candidates ?? []).length).toBeGreaterThan(1);
    });

    it("matches a re-grade by its sound when nothing else can tell two spots apart", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Spots" });
      /* The commercial case: both spots are thirty seconds, both start at
         01:00:00:00, both were exported this afternoon. Length, timecode and
         creation time all say the same thing about both, so only the sound
         can tell them apart. */
      const hero = await landAsset(
        h,
        seed,
        project.id,
        "20260729_1010_hero.mov",
      );
      const other = await landAsset(
        h,
        seed,
        project.id,
        "20260729_1012_alt.mov",
      );
      await fingerprintVersion(h, hero.versionId, {
        audioHash: "0f0f0f0f0f0f0f01",
        contentHash: "ffffffffffffffff",
      });
      await fingerprintVersion(h, other.versionId, {
        audioHash: "f0f0f0f0f0f0f0f0",
        contentHash: "ffffffffffffff00",
      });
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "HERO_CC_v3.mov",
      });
      /* The grade rewrote the picture and left the audio alone. */
      await fingerprintUpload(h, upload.id, {
        audioHash: "0f0f0f0f0f0f0f03",
        contentHash: "0000000000000000",
      });
      const body = await json<{
        items: Array<{
          rule: string;
          asset_id: string | null;
          distance?: number;
        }>;
        matched: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [{ filename: "HERO_CC_v3.mov", upload_id: upload.id }],
          },
        }),
      );
      expect(body.matched).toBe(1);
      expect(body.items[0]?.rule).toBe("audio");
      expect(body.items[0]?.asset_id).toBe(hero.assetId);
      expect(body.items[0]?.distance).toBe(1);

      /* Now give the other spot the same soundtrack, which is what a music
         video is. Two cuts of one track must not be told apart by sound. */
      await fingerprintVersion(h, other.versionId, {
        audioHash: "0f0f0f0f0f0f0f02",
      });
      const tie = await json<{
        items: Array<{
          rule: string;
          asset_id: string | null;
          candidates: unknown[];
        }>;
        ambiguous: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [{ filename: "HERO_CC_v3.mov", upload_id: upload.id }],
          },
        }),
      );
      expect(tie.ambiguous).toBe(1);
      expect(tie.items[0]?.asset_id).toBeNull();
      expect(tie.items[0]?.candidates).toHaveLength(2);
    });

    it("matches a re-edit by the footage two cuts share", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Cuts" });
      /* Eight sampled frames, each far from the others: a shot vocabulary. */
      const shots = [
        "ffffffffffffffff",
        "0000000000000000",
        "ffffffff00000000",
        "00000000ffffffff",
        "ff00ff00ff00ff00",
        "00ff00ff00ff00ff",
        "f0f0f0f0f0f0f0f0",
        "0f0f0f0f0f0f0f0f",
      ] as const;
      const spare = ["ffff0000ffff0000", "0000ffff0000ffff"] as const;
      const cut = (order: number[]): string =>
        order.map((index) => shots[index] as string).join(":");
      const v1 = await landAsset(
        h,
        seed,
        project.id,
        "20260729_1010_music.mov",
      );
      const unrelated = await landAsset(
        h,
        seed,
        project.id,
        "20260729_1400_bts.mov",
      );
      /* The first cut: the same material, in a different order. */
      await fingerprintVersion(h, v1.versionId, {
        contentHash: cut([2, 0, 4, 1, 6, 3, 5, 7]),
      });
      /* Another clip from the same shoot day that shares no footage. */
      await fingerprintVersion(h, unrelated.versionId, {
        contentHash: new Array(8).fill(spare[0]).join(":"),
      });
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "MusicVid_ReCut.mov",
      });
      await fingerprintUpload(h, upload.id, {
        contentHash: cut([0, 1, 2, 3, 4, 5, 6, 7]),
      });
      const body = await json<{
        items: Array<{ rule: string; asset_id: string | null; share?: number }>;
        matched: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [{ filename: "MusicVid_ReCut.mov", upload_id: upload.id }],
          },
        }),
      );
      expect(body.matched).toBe(1);
      expect(body.items[0]?.rule).toBe("shared-footage");
      expect(body.items[0]?.asset_id).toBe(v1.assetId);
      expect(body.items[0]?.share).toBe(100);

      /* Two earlier cuts of the same material is the real hazard: which one
         is this a version of? Nobody knows, so it must not choose. */
      await fingerprintVersion(h, unrelated.versionId, {
        contentHash: cut([7, 6, 5, 4, 3, 2, 1, 0]),
      });
      const tie = await json<{
        items: Array<{
          rule: string;
          asset_id: string | null;
          candidates: unknown[];
        }>;
        ambiguous: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [{ filename: "MusicVid_ReCut.mov", upload_id: upload.id }],
          },
        }),
      );
      expect(tie.ambiguous).toBe(1);
      expect(tie.items[0]?.asset_id).toBeNull();
      expect(tie.items[0]?.candidates).toHaveLength(2);

      /* And a stack of stills must never reach this tier: single frames have
         no shot list to share, only a position, which tier three already
         judged and rejected. */
      const still = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "a-frame.jpg",
      });
      await fingerprintUpload(h, still.id, { contentHash: spare[1] });
      const stills = await json<{
        items: Array<{ rule: string; asset_id: string | null }>;
        unmatched: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: { files: [{ filename: "a-frame.jpg", upload_id: still.id }] },
        }),
      );
      expect(stills.items[0]?.rule).toBe("none");
      expect(stills.items[0]?.asset_id).toBeNull();
    });

    it("says it is still working rather than saying there is no match", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin, { name: "Pending" });
      await landAsset(h, seed, project.id, "known.jpg");
      const upload = await seedCompletedUpload(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
        filename: "unknown-name.tif",
      });
      const body = await json<{
        items: Array<{ rule: string }>;
        pending: number;
        unmatched: number;
      }>(
        await req(h, `/api/v1/projects/${project.id}/versions/match`, {
          cookie: seed.admin.cookie,
          json: {
            files: [{ filename: "unknown-name.tif", upload_id: upload.id }],
          },
        }),
      );
      expect(body.items[0]?.rule).toBe("pending");
      expect(body.pending).toBe(1);
      expect(body.unmatched).toBe(0);
      /* And the work was queued, once, for the batch. */
      const queued = await h.db.select().from(jobs).all();
      const fingerprints = queued.filter((row) => row.kind === "fingerprint");
      expect(fingerprints).toHaveLength(1);
      expect(
        (
          JSON.parse(fingerprints[0]?.payloadJson ?? "{}") as {
            upload_ids: string[];
          }
        ).upload_ids,
      ).toEqual([upload.id]);
    });

    it("refuses matching and batching from a viewer", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const match = await req(
        h,
        `/api/v1/projects/${seed.project.id}/versions/match`,
        {
          cookie: seed.viewer.cookie,
          json: { files: [{ filename: "x.jpg" }] },
        },
      );
      expect(match.status).toBe(403);
      expect(await errorCode(match)).toBe("forbidden");
    });
  });
};
