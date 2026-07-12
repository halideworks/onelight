import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, projectEvents, projects } from "@onelight/db/schema";
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
};
