import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  assets,
  assetVersions,
  captionTracks,
  comments,
  downloadManifests,
  projectEvents,
  projects,
  renditions,
  transferDownloads,
  transferItems,
  transferReceipts,
  transfers,
} from "@onelight/db/schema";
import { cookieFrom, json, req, travel } from "../harness.js";
import {
  createProject,
  grantRole,
  seedAssetVersion,
  seedCompletedUpload,
  seedExtraVersion,
  seedRendition,
  uniqueIp,
} from "../seed.js";
import type { SuiteContext } from "../context.js";
import type { StackState } from "../../operation/version-stack.js";

interface Created {
  asset: {
    id: string;
    current_version_id: string;
    name: string;
    updated_at: number;
  };
  version: { id: string; version_no: number; asset_id: string };
  stack_state: StackState;
  previous_current_version_id: string | null;
  undo_token: string;
}
interface Detached extends Omit<
  Created,
  "stack_state" | "previous_current_version_id"
> {
  source_stack: StackState;
  before_stack: StackState;
}

export const registerVersionStacksDomain = (ctx: SuiteContext): void => {
  describe("reversible version stacks", () => {
    const fixture = async () => {
      const h = ctx.h(),
        seed = ctx.seed();
      const project = await createProject(h, seed.admin, { restricted: true });
      await grantRole(h, seed.admin, project.id, seed.editor.id, "editor");
      await grantRole(h, seed.admin, project.id, seed.viewer.id, "viewer");
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      const attach = async () => {
        const upload = await seedCompletedUpload(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.editor.id,
          filename: "new-pass.mp4",
        });
        const response = await req(
          h,
          `/api/v1/assets/${media.assetId}/versions`,
          { cookie: seed.editor.cookie, json: { upload_id: upload.id } },
        );
        expect(response.status).toBe(201);
        return json<Created>(response);
      };
      const state = async () =>
        (
          await json<{ stack_state: StackState }>(
            await req(h, `/api/v1/assets/${media.assetId}/versions`, {
              cookie: seed.editor.cookie,
            }),
          )
        ).stack_state;
      const unstack = (
        versionId: string,
        expected: StackState,
        token?: string,
        cookie = seed.editor.cookie,
      ) =>
        req(h, `/api/v1/versions/${versionId}/unstack`, {
          cookie,
          json: { expected, ...(token ? { undo_token: token } : {}) },
        });
      const restack = (
        moved: Detached,
        expected = moved.source_stack,
        cookie = seed.editor.cookie,
      ) =>
        req(h, `/api/v1/versions/${moved.version.id}/restack`, {
          cookie,
          json: { expected, undo_token: moved.undo_token },
        });
      return { h, seed, project, media, attach, state, unstack, restack };
    };

    it("moves identity and media without duplication, then restores exact ordering/current and comments", async () => {
      const f = await fixture();
      const second = await f.attach();
      const third = await f.attach();
      const noteResponse = await req(
        f.h,
        `/api/v1/versions/${second.version.id}/comments`,
        {
          cookie: f.seed.editor.cookie,
          json: { frame_in: 3, body_text: "Keep this note" },
        },
      );
      expect(noteResponse.status).toBe(201);
      const note = await json<{ id: string }>(noteResponse);
      const reply = await req(f.h, `/api/v1/comments/${note.id}/replies`, {
        cookie: f.seed.editor.cookie,
        json: { body_text: "And the reply" },
      });
      expect(reply.status).toBe(201);
      const rendition = await seedRendition(f.h, {
        versionId: second.version.id,
      });
      await f.h.db
        .insert(captionTracks)
        .values({
          id: f.h.ids.ulid(),
          versionId: second.version.id,
          language: "en",
          label: "English",
          blobKey: "captions/preserved.vtt",
          createdBy: f.seed.editor.id,
          createdAt: f.h.clock.now(),
        })
        .run();
      const beforeVersion = (
        await f.h.db
          .select()
          .from(assetVersions)
          .where(eq(assetVersions.id, second.version.id))
          .all()
      )[0]!;
      const bytesBefore = (
        await f.h.db
          .select()
          .from(projects)
          .where(eq(projects.id, f.project.id))
          .all()
      )[0]!.storageBytes;
      await f.h.db
        .update(assets)
        .set({ displayTransfer: "srgb" })
        .where(eq(assets.id, f.media.assetId))
        .run();
      const response = await f.unstack(second.version.id, third.stack_state);
      expect(response.status).toBe(200);
      const moved = await json<Detached>(response);
      expect(moved.version).toMatchObject({
        id: second.version.id,
        asset_id: moved.asset.id,
        version_no: 1,
      });
      expect(moved.source_stack).toEqual({
        ...third.stack_state,
        versions: third.stack_state.versions.filter(
          (v) => v.id !== second.version.id,
        ),
      });
      expect(moved.asset).toMatchObject({
        name: "new-pass.mp4",
        status: "none",
        selected: false,
        tags: [],
        display_transfer: "srgb",
      });
      const movedVersion = (
        await f.h.db
          .select()
          .from(assetVersions)
          .where(eq(assetVersions.id, second.version.id))
          .all()
      )[0]!;
      expect(movedVersion).toEqual({
        ...beforeVersion,
        assetId: moved.asset.id,
        versionNo: 1,
      });
      expect(
        await f.h.db
          .select()
          .from(comments)
          .where(eq(comments.versionId, second.version.id))
          .all(),
      ).toHaveLength(2);
      expect(
        await f.h.db
          .select()
          .from(captionTracks)
          .where(eq(captionTracks.versionId, second.version.id))
          .all(),
      ).toHaveLength(1);
      expect(
        await f.h.db
          .select()
          .from(renditions)
          .where(eq(renditions.id, rendition.id))
          .all(),
      ).toHaveLength(1);
      expect(
        (
          await f.h.db
            .select()
            .from(projects)
            .where(eq(projects.id, f.project.id))
            .all()
        )[0]!.storageBytes,
      ).toBe(bytesBefore);
      const restored = await f.restack(moved);
      expect(restored.status).toBe(200);
      expect((await json<Created>(restored)).stack_state).toEqual(
        third.stack_state,
      );
      expect(
        await f.h.db
          .select()
          .from(assets)
          .where(eq(assets.id, moved.asset.id))
          .all(),
      ).toHaveLength(0);
      expect(
        (
          await f.h.db
            .select()
            .from(assetVersions)
            .where(eq(assetVersions.id, second.version.id))
            .all()
        )[0],
      ).toEqual(beforeVersion);
      expect((await f.restack(moved)).status).toBe(409);
    });

    it("upload undo restores a non-latest previous current and batch tokens reverse in order", async () => {
      const f = await fixture();
      await f.attach();
      expect(
        (
          await req(f.h, `/api/v1/versions/${f.media.versionId}/stack`, {
            method: "PATCH",
            cookie: f.seed.admin.cookie,
            json: { version_no: 1 },
          })
        ).status,
      ).toBe(200);
      const before = await f.state();
      const uploads = await Promise.all(
        [1, 2].map(() =>
          seedCompletedUpload(f.h, {
            workspaceId: f.seed.workspaceId,
            projectId: f.project.id,
            userId: f.seed.editor.id,
          }),
        ),
      );
      const batch = await req(
        f.h,
        `/api/v1/projects/${f.project.id}/versions/batch`,
        {
          cookie: f.seed.editor.cookie,
          json: {
            items: uploads.map((upload) => ({
              asset_id: f.media.assetId,
              upload_id: upload.id,
            })),
            carry_forward: false,
          },
        },
      );
      expect(batch.status).toBe(201);
      const { items } = await json<{
        items: Array<{
          version_id: string;
          stack_state: StackState;
          undo_token: string;
          previous_current_version_id: string;
        }>;
      }>(batch);
      expect(items).toHaveLength(2);
      expect(items[0]!.previous_current_version_id).toBe(f.media.versionId);
      for (const item of [...items].reverse())
        expect(
          (await f.unstack(item.version_id, item.stack_state, item.undo_token))
            .status,
        ).toBe(200);
      expect(await f.state()).toEqual(before);
    });

    it("uses highest remaining live version when current is explicitly unstacked, preserving gaps", async () => {
      const f = await fixture();
      const second = await f.attach();
      const third = await f.attach();
      const response = await f.unstack(third.version.id, third.stack_state);
      expect(response.status).toBe(200);
      const moved = await json<Detached>(response);
      expect(moved.source_stack.current_version_id).toBe(second.version.id);
      expect((await f.restack(moved)).status).toBe(200);
      const first = await f.unstack(f.media.versionId, third.stack_state);
      expect(first.status).toBe(200);
      expect(
        (await json<Detached>(first)).source_stack.versions.map(
          (v) => v.version_no,
        ),
      ).toEqual([2, 3]);
    });

    it("rejects sole, deleted, foreign, viewer and stale operations without partial rows or events", async () => {
      const f = await fixture();
      expect((await f.unstack(f.media.versionId, await f.state())).status).toBe(
        409,
      );
      const second = await f.attach();
      expect(
        (
          await f.unstack(
            second.version.id,
            second.stack_state,
            undefined,
            f.seed.viewer.cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.unstack(second.version.id, {
            ...second.stack_state,
            asset_id: f.seed.other.media.assetId,
          })
        ).status,
      ).toBe(409);
      const third = await f.attach();
      expect(
        (await f.unstack(second.version.id, second.stack_state)).status,
      ).toBe(409);
      await f.h.db
        .update(assetVersions)
        .set({ deletedAt: f.h.clock.now() })
        .where(eq(assetVersions.id, second.version.id))
        .run();
      expect(
        (await f.unstack(second.version.id, third.stack_state)).status,
      ).toBe(404);
      expect(
        await f.h.db
          .select()
          .from(assets)
          .where(eq(assets.projectId, f.project.id))
          .all(),
      ).toHaveLength(1);
      expect(
        (
          await f.h.db
            .select()
            .from(projectEvents)
            .where(eq(projectEvents.projectId, f.project.id))
            .all()
        ).filter((event) => event.type === "asset.versions_changed"),
      ).toHaveLength(0);
    });

    it("binds tokens to actor, version, action, expiry and original expected state", async () => {
      const f = await fixture();
      const second = await f.attach();
      const third = await f.attach();
      expect(
        (
          await f.unstack(
            second.version.id,
            third.stack_state,
            second.undo_token,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await f.unstack(
            third.version.id,
            third.stack_state,
            second.undo_token,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await f.unstack(
            third.version.id,
            third.stack_state,
            third.undo_token,
            f.seed.admin.cookie,
          )
        ).status,
      ).toBe(409);
      await travel(f.h.clock, 8 * 86400000, async () =>
        expect(
          (
            await f.unstack(
              third.version.id,
              third.stack_state,
              third.undo_token,
            )
          ).status,
        ).toBe(409),
      );
      const moved = await json<Detached>(
        await f.unstack(third.version.id, third.stack_state),
      );
      expect(
        (
          await f.unstack(
            second.version.id,
            moved.source_stack,
            moved.undo_token,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await req(f.h, `/api/v1/versions/${f.media.versionId}/stack`, {
            method: "PATCH",
            cookie: f.seed.admin.cookie,
            json: { version_no: 1 },
          })
        ).status,
      ).toBe(200);
      expect((await f.restack(moved, await f.state())).status).toBe(409);
      expect(
        (
          await f.h.db
            .select()
            .from(assetVersions)
            .where(eq(assetVersions.id, third.version.id))
            .all()
        )[0]!.assetId,
      ).toBe(moved.asset.id);
      expect(
        (
          await req(f.h, `/api/v1/versions/${second.version.id}/unstack`, {
            cookie: f.seed.editor.cookie,
            json: {
              expected: await f.state(),
              current_version_id: second.version.id,
            },
          })
        ).status,
      ).toBe(400);
    });

    it("refuses restack after detached edits, new versions or source slot reuse", async () => {
      for (const change of ["edit", "append", "slot"] as const) {
        const f = await fixture(),
          second = await f.attach();
        const moved = await json<Detached>(
          await f.unstack(second.version.id, second.stack_state),
        );
        if (change === "edit")
          await req(f.h, `/api/v1/assets/${moved.asset.id}`, {
            method: "PATCH",
            cookie: f.seed.editor.cookie,
            json: { name: "A colleague renamed this" },
          });
        else
          await seedExtraVersion(f.h, {
            workspaceId: f.seed.workspaceId,
            projectId: f.project.id,
            userId: f.seed.editor.id,
            assetId: change === "append" ? moved.asset.id : f.media.assetId,
            versionNo: 2,
          });
        expect((await f.restack(moved)).status).toBe(409);
        expect(
          (
            await f.h.db
              .select()
              .from(assetVersions)
              .where(eq(assetVersions.id, second.version.id))
              .all()
          )[0]!.assetId,
        ).toBe(moved.asset.id);
      }
    });

    it("guards every detached asset reference before deleting its empty identity", async () => {
      for (const reference of [
        "share",
        "transfer",
        "receipt",
        "download",
        "cover",
        "manifest",
      ] as const) {
        const f = await fixture(),
          second = await f.attach();
        const moved = await json<Detached>(
          await f.unstack(second.version.id, second.stack_state),
        );
        const now = f.h.clock.now();
        if (reference === "share") {
          expect(
            (
              await req(f.h, "/api/v1/shares", {
                cookie: f.seed.admin.cookie,
                json: {
                  project_id: f.project.id,
                  title: "Referenced",
                  asset_ids: [moved.asset.id],
                },
              })
            ).status,
          ).toBe(201);
        } else if (reference === "cover") {
          await f.h.db
            .update(projects)
            .set({ coverAssetId: moved.asset.id })
            .where(eq(projects.id, f.project.id))
            .run();
        } else if (reference === "manifest") {
          await f.h.db
            .insert(downloadManifests)
            .values({
              id: f.h.ids.ulid(),
              projectId: f.project.id,
              createdBy: f.seed.admin.id,
              assetIdsJson: JSON.stringify([moved.asset.id]),
              createdAt: now,
              expiresAt: now + 1000,
            })
            .run();
        } else {
          const transferId = f.h.ids.ulid();
          await f.h.db
            .insert(transfers)
            .values({
              id: transferId,
              projectId: f.project.id,
              kind: "package",
              slug: f.h.ids.ulid(),
              title: "Referenced",
              createdBy: f.seed.admin.id,
              createdAt: now,
            })
            .run();
          if (reference === "transfer")
            await f.h.db
              .insert(transferItems)
              .values({ transferId, assetId: moved.asset.id, sortOrder: 0 })
              .run();
          if (reference === "download")
            await f.h.db
              .insert(transferDownloads)
              .values({
                id: f.h.ids.ulid(),
                transferId,
                assetId: moved.asset.id,
                kind: "file",
                name: "Client",
                createdAt: now,
              })
              .run();
          if (reference === "receipt") {
            const version = (
              await f.h.db
                .select()
                .from(assetVersions)
                .where(eq(assetVersions.id, second.version.id))
                .all()
            )[0]!;
            await f.h.db
              .insert(transferReceipts)
              .values({
                id: f.h.ids.ulid(),
                transferId,
                assetId: moved.asset.id,
                uploadSessionId: version.uploadSessionId,
                senderName: "Client",
                createdAt: now,
              })
              .run();
          }
        }
        expect((await f.restack(moved)).status).toBe(409);
        expect(
          await f.h.db
            .select()
            .from(assets)
            .where(eq(assets.id, moved.asset.id))
            .all(),
        ).toHaveLength(1);
        expect(await f.state()).toEqual(moved.source_stack);
      }
    });

    it("rechecks membership atomically when creation races a current-pointer change", async () => {
      const f = await fixture();
      const second = await f.attach();
      const atomic = f.h.db.atomic.bind(f.h.db);
      f.h.db.atomic = async (statements) => {
        f.h.db.atomic = atomic;
        await f.h.db
          .update(assets)
          .set({ currentVersionId: f.media.versionId })
          .where(eq(assets.id, f.media.assetId))
          .run();
        return atomic(statements);
      };
      const upload = await seedCompletedUpload(f.h, {
        workspaceId: f.seed.workspaceId,
        projectId: f.project.id,
        userId: f.seed.editor.id,
      });
      try {
        expect(
          (
            await req(f.h, `/api/v1/assets/${f.media.assetId}/versions`, {
              cookie: f.seed.editor.cookie,
              json: { upload_id: upload.id },
            })
          ).status,
        ).toBe(409);
      } finally {
        f.h.db.atomic = atomic;
      }
      expect((await f.state()).versions).toEqual(second.stack_state.versions);
      expect((await f.state()).current_version_id).toBe(f.media.versionId);
      expect(
        await f.h.db
          .select()
          .from(assetVersions)
          .where(eq(assetVersions.uploadSessionId, upload.id))
          .all(),
      ).toHaveLength(0);
    });

    it("rolls back all unstack writes on a late SQL failure", async () => {
      const f = await fixture(),
        second = await f.attach();
      const atomic = f.h.db.atomic.bind(f.h.db);
      f.h.db.atomic = (statements) =>
        atomic([
          ...statements,
          sql`INSERT INTO table_that_does_not_exist VALUES (1)`,
        ]);
      try {
        expect(
          (await f.unstack(second.version.id, second.stack_state)).status,
        ).toBe(500);
      } finally {
        f.h.db.atomic = atomic;
      }
      expect(await f.state()).toEqual(second.stack_state);
      expect(
        await f.h.db
          .select()
          .from(assets)
          .where(eq(assets.projectId, f.project.id))
          .all(),
      ).toHaveLength(1);
    });

    it("rolls back restack pointer, version move and detached deletion together", async () => {
      const f = await fixture(),
        second = await f.attach();
      const moved = await json<Detached>(
        await f.unstack(second.version.id, second.stack_state),
      );
      const atomic = f.h.db.atomic.bind(f.h.db);
      f.h.db.atomic = (statements) =>
        atomic([
          ...statements,
          sql`INSERT INTO table_that_does_not_exist VALUES (1)`,
        ]);
      try {
        expect((await f.restack(moved)).status).toBe(500);
      } finally {
        f.h.db.atomic = atomic;
      }
      expect(await f.state()).toEqual(moved.source_stack);
      expect(
        (
          await f.h.db
            .select()
            .from(assetVersions)
            .where(eq(assetVersions.id, second.version.id))
            .all()
        )[0]!.assetId,
      ).toBe(moved.asset.id);
      expect(
        await f.h.db
          .select()
          .from(assets)
          .where(eq(assets.id, moved.asset.id))
          .all(),
      ).toHaveLength(1);
      expect((await f.restack(moved)).status).toBe(200);
    });

    it("does not select a current version that moved after the manager's membership read", async () => {
      const f = await fixture(),
        second = await f.attach();
      const other = await seedAssetVersion(f.h, {
        workspaceId: f.seed.workspaceId,
        projectId: f.project.id,
        userId: f.seed.admin.id,
      });
      const update = f.h.db.update.bind(f.h.db);
      f.h.db.update = (table) => {
        f.h.db.update = update;
        update(assetVersions)
          .set({ assetId: other.assetId })
          .where(eq(assetVersions.id, second.version.id))
          .run();
        update(assets)
          .set({ currentVersionId: f.media.versionId })
          .where(eq(assets.id, f.media.assetId))
          .run();
        return update(table);
      };
      try {
        expect(
          (
            await req(f.h, `/api/v1/versions/${f.media.versionId}/stack`, {
              method: "PATCH",
              cookie: f.seed.admin.cookie,
              json: { version_no: 2 },
            })
          ).status,
        ).toBe(409);
      } finally {
        f.h.db.update = update;
      }
      expect((await f.state()).current_version_id).toBe(f.media.versionId);
    });

    it("revokes former public-share media and comment writes when a version leaves", async () => {
      const f = await fixture(),
        second = await f.attach();
      await seedRendition(f.h, { versionId: second.version.id });
      const shared = await json<{ share: { slug: string } }>(
        await req(f.h, "/api/v1/shares", {
          cookie: f.seed.admin.cookie,
          json: {
            project_id: f.project.id,
            title: "Review",
            asset_ids: [f.media.assetId],
            allow_comments: true,
          },
        }),
      );
      const slug = shared.share.slug;
      const access = await req(f.h, `/api/v1/s/${slug}/access`, {
        json: { name: "Client" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(access.status).toBe(200);
      const cookie = cookieFrom(access);
      const note = await json<{ id: string }>(
        await req(f.h, `/api/v1/s/${slug}/assets/${f.media.assetId}/comments`, {
          cookie,
          origin: true,
          json: { frame_in: 0, body_text: "Public note" },
          headers: { "x-forwarded-for": uniqueIp() },
        }),
      );
      const detail = await json<{
        versions: Array<{ sources: Array<{ url: string }> }>;
      }>(
        await req(f.h, `/api/v1/s/${slug}/assets/${f.media.assetId}`, {
          cookie,
        }),
      );
      const sources = detail.versions.flatMap((version) => version.sources);
      expect(sources.length).toBeGreaterThan(0);
      const mediaPath = (url: string) => {
        const parsed = new URL(url, "http://onelight.test");
        return parsed.pathname.replace(/^\/s\//, "/api/v1/s/") + parsed.search;
      };
      for (const source of sources)
        expect((await req(f.h, mediaPath(source.url), { cookie })).status).toBe(
          200,
        );
      const moved = await json<Detached>(
        await f.unstack(second.version.id, second.stack_state),
      );
      for (const method of ["PATCH", "DELETE"])
        expect(
          (
            await req(f.h, `/api/v1/s/${slug}/comments/${note.id}`, {
              method,
              cookie,
              origin: true,
              ...(method === "PATCH"
                ? { json: { body_text: "Not allowed" } }
                : {}),
            })
          ).status,
        ).toBe(404);
      expect(
        (
          await req(f.h, `/api/v1/s/${slug}/comments/${note.id}/attachments`, {
            cookie,
            origin: true,
            method: "POST",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await req(f.h, `/api/v1/s/${slug}/comments/${note.id}/replies`, {
            cookie,
            origin: true,
            json: { body_text: "Not allowed" },
          })
        ).status,
      ).toBe(404);
      for (const rendition of sources) {
        expect(
          (await req(f.h, mediaPath(rendition.url), { cookie })).status,
        ).toBe(404);
      }
      expect(
        (
          await f.h.db
            .select()
            .from(comments)
            .where(eq(comments.id, note.id))
            .all()
        )[0],
      ).toMatchObject({ bodyText: "Public note", deletedAt: null });
      expect((await f.restack(moved)).status).toBe(200);
    });
  });
};
