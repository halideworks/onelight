import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PALETTES } from "@onelight/core";
import {
  assets,
  captionTracks,
  commentAttachments,
  comments,
  exportJobs,
  projectCoverUploads,
  projects,
  renditions,
  shares,
} from "@onelight/db/schema";
import {
  assertSnakeCaseKeys,
  errorCode,
  forbiddenKeysIn,
  json,
  req,
} from "../harness.js";
import { MemoryBlobStore } from "../memory-blob-store.js";
import {
  createProject,
  createUser,
  grantRole,
  seedAssetVersion,
  unique,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

export const registerProjectsDomain = (ctx: SuiteContext): void => {
  describe("projects", () => {
    it("creates projects with palette rules and the creator as manager", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const explicit = await req(h, "/api/v1/projects", {
        cookie: seed.editor.cookie,
        json: { name: unique("Palette"), palette: "yoai" },
      });
      expect(explicit.status).toBe(201);
      const explicitBody = await json(explicit);
      expect(explicitBody.palette).toBe("yoai");
      expect(explicitBody.my_role).toBe("manager");
      expect(explicitBody.restricted).toBe(false);
      expect(assertSnakeCaseKeys(explicitBody)).toEqual([]);
      expect(forbiddenKeysIn(explicitBody)).toEqual([]);
      const members = await req(
        h,
        `/api/v1/projects/${String(explicitBody.id)}/members`,
        { cookie: seed.editor.cookie },
      );
      const membersBody = await json<{
        items: Array<{ user: { id: string }; role: string }>;
      }>(members);
      const creator = membersBody.items.find(
        (item) => item.user.id === seed.editor.id,
      );
      expect(creator?.role).toBe("manager");
      const defaulted = await req(h, "/api/v1/projects", {
        cookie: seed.editor.cookie,
        json: { name: unique("Default Palette") },
      });
      const defaultedBody = await json(defaulted);
      expect(PALETTES).toContain(defaultedBody.palette);
      const invalid = await req(h, "/api/v1/projects", {
        cookie: seed.editor.cookie,
        json: { name: unique("Bad Palette"), palette: "not-a-palette" },
      });
      expect(invalid.status).toBe(400);
      const noName = await req(h, "/api/v1/projects", {
        cookie: seed.editor.cookie,
        json: {},
      });
      expect(noName.status).toBe(400);
    });

    /* Deleting a project must free every blob it owns inline. This seeds one
       blob of each kind a project can hold and asserts none survive the delete
       -- the guard against the missing-column class that let the GC (and, once,
       this path) strand or delete the wrong blobs. If a new blob-key column is
       added and not wired into the delete collector, this fails. */
    it("frees every kind of project blob on delete", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const store = h.blobStore;
      if (!(store instanceof MemoryBlobStore)) return;
      const project = await createProject(h, seed.admin);
      const now = h.clock.now();
      const put = async (key: string): Promise<string> => {
        const body = new Response(new TextEncoder().encode("x").buffer).body;
        if (body) await store.putStream(key, body);
        return key;
      };
      const keys: string[] = [];

      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      keys.push(await put(media.blobKey)); // original

      const posterKey = `renditions/${h.ids.ulid()}.png`;
      const vttKey = `renditions/${h.ids.ulid()}.vtt`;
      await h.db
        .insert(renditions)
        .values({
          id: h.ids.ulid(),
          versionId: media.versionId,
          kind: "poster",
          blobKey: posterKey,
          metaJson: JSON.stringify({ vtt_blob_key: vttKey }),
          size: 1,
          checksumSha256: "",
          shareId: null,
          createdAt: now,
        })
        .run();
      keys.push(await put(posterKey), await put(vttKey));
      for (const rate of [2, 4] as const) {
        const sidecarKey = `renditions/${media.versionId}/shuttle_audio_${String(rate)}x.m4a`;
        await h.db
          .insert(renditions)
          .values({
            id: h.ids.ulid(),
            versionId: media.versionId,
            kind: rate === 2 ? "shuttle_audio_2x" : "shuttle_audio_4x",
            blobKey: sidecarKey,
            metaJson: JSON.stringify({ shuttle_rate: rate }),
            size: 1,
            checksumSha256: "",
            shareId: null,
            createdAt: now,
          })
          .run();
        keys.push(await put(sidecarKey));
      }

      const commentId = h.ids.ulid();
      await h.db
        .insert(comments)
        .values({
          id: commentId,
          versionId: media.versionId,
          authorUserId: seed.admin.id,
          bodyText: "note",
          createdAt: now,
        })
        .run();
      const attachKey = `attachments/${h.ids.ulid()}`;
      await h.db
        .insert(commentAttachments)
        .values({
          id: h.ids.ulid(),
          commentId,
          blobKey: attachKey,
          filename: "a.pdf",
          size: 1,
          contentType: "application/pdf",
        })
        .run();
      keys.push(await put(attachKey));

      const captionKey = `captions/${h.ids.ulid()}.vtt`;
      await h.db
        .insert(captionTracks)
        .values({
          id: h.ids.ulid(),
          versionId: media.versionId,
          language: "en",
          label: "English",
          blobKey: captionKey,
          createdBy: seed.admin.id,
          createdAt: now,
        })
        .run();
      keys.push(await put(captionKey));

      const thumbKey = `thumbnails/${h.ids.ulid()}`;
      await h.db
        .update(assets)
        .set({ thumbnailBlobKey: thumbKey })
        .where(eq(assets.id, media.assetId))
        .run();
      keys.push(await put(thumbKey));

      const coverKey = `covers/${h.ids.ulid()}`;
      await h.db
        .update(projects)
        .set({ coverBlobKey: coverKey })
        .where(eq(projects.id, project.id))
        .run();
      keys.push(await put(coverKey));

      const coverUploadKey = `cover-uploads/${h.ids.ulid()}`;
      await h.db
        .insert(projectCoverUploads)
        .values({
          id: h.ids.ulid(),
          projectId: project.id,
          blobKey: coverUploadKey,
          filename: "cover.png",
          createdBy: seed.admin.id,
          createdAt: now,
        })
        .run();
      keys.push(await put(coverUploadKey));

      const logoKey = `${seed.workspaceId}/sharelogos/${h.ids.ulid()}.png`;
      await h.db
        .insert(shares)
        .values({
          id: h.ids.ulid(),
          projectId: project.id,
          slug: unique("slug"),
          kind: "review",
          title: "Share",
          layout: "grid",
          allowDownload: "none",
          brandJson: JSON.stringify({ logo_key: logoKey }),
          createdBy: seed.admin.id,
          createdAt: now,
        })
        .run();
      keys.push(await put(logoKey));

      const exportKey = `exports/${h.ids.ulid()}.zip`;
      await h.db
        .insert(exportJobs)
        .values({
          id: h.ids.ulid(),
          workspaceId: seed.workspaceId,
          requestedBy: seed.admin.id,
          projectId: project.id,
          format: "pdf",
          timecodeBase: "source",
          status: "complete",
          resultBlobKey: exportKey,
          createdAt: now,
        })
        .run();
      keys.push(await put(exportKey));

      // Sanity: everything is present before the delete.
      expect(keys.filter((key) => !store.blobs.has(key))).toEqual([]);

      const deleted = await req(h, `/api/v1/projects/${project.id}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
      expect(deleted.status).toBe(204);

      // Nothing the project owned survives.
      expect(keys.filter((key) => store.blobs.has(key))).toEqual([]);
    });

    it("serializes my_role per the phase-0 rules", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const cases: Array<[string, string]> = [
        [seed.admin.cookie, "manager"],
        [seed.commenter.cookie, "commenter"],
        [seed.nograntee.cookie, "viewer"],
      ];
      for (const [cookie, expected] of cases) {
        const response = await req(h, `/api/v1/projects/${seed.project.id}`, {
          cookie,
        });
        expect(response.status).toBe(200);
        expect((await json(response)).my_role).toBe(expected);
      }
    });

    it("returns 404 for unknown and cross-workspace projects", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const unknown = await req(
        h,
        "/api/v1/projects/01ARZ3NDEKTSV4RRFFQ69G5FAV",
        { cookie: seed.admin.cookie },
      );
      expect(unknown.status).toBe(404);
      const foreign = await req(h, `/api/v1/projects/${seed.project.id}`, {
        cookie: seed.other.admin.cookie,
      });
      expect(foreign.status).toBe(404);
    });

    it("filters the list by status and hides restricted projects", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const archived = await req(h, `/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { status: "archived" },
      });
      expect(archived.status).toBe(200);
      const activeList = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/projects?limit=200", {
          cookie: seed.admin.cookie,
        }),
      );
      expect(activeList.items.some((item) => item.id === project.id)).toBe(
        false,
      );
      const archivedList = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/projects?status=archived&limit=200", {
          cookie: seed.admin.cookie,
        }),
      );
      expect(archivedList.items.some((item) => item.id === project.id)).toBe(
        true,
      );
      const restrictedHidden = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/projects?limit=200", {
          cookie: seed.nograntee.cookie,
        }),
      );
      expect(
        restrictedHidden.items.some((item) => item.id === seed.restricted.id),
      ).toBe(false);
      expect(
        restrictedHidden.items.some((item) => item.id === seed.project.id),
      ).toBe(true);
      const malformed = await req(h, "/api/v1/projects?cursor=@@@", {
        cookie: seed.admin.cookie,
      });
      expect(malformed.status).toBe(400);
    });

    it("does not lose visible projects behind pages of restricted ones", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const visible = await createProject(h, seed.admin, {
        name: unique("VisibleBehindWall"),
      });
      for (let index = 0; index < 4; index += 1)
        await createProject(h, seed.admin, {
          name: unique("Wall"),
          restricted: true,
        });
      const collected: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const query: string = cursor
          ? `&cursor=${encodeURIComponent(cursor)}`
          : "";
        const page = await json<{
          items: Array<{ id: string }>;
          next_cursor: string | null;
        }>(
          await req(h, `/api/v1/projects?limit=2${query}`, {
            cookie: seed.nograntee.cookie,
          }),
        );
        collected.push(...page.items.map((item) => item.id));
        cursor = page.next_cursor;
        guard += 1;
      } while (cursor && guard < 50);
      expect(collected).toContain(visible.id);
      expect(new Set(collected).size).toBe(collected.length);
    });

    it("renames, re-palettes, archives, and unarchives via PATCH", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const updated = await req(h, `/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { name: unique("Renamed"), palette: "mokutan" },
      });
      expect(updated.status).toBe(200);
      expect((await json(updated)).palette).toBe("mokutan");
      const archived = await req(h, `/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { status: "archived" },
      });
      expect(archived.status).toBe(200);
      expect((await json(archived)).status).toBe("archived");
      const unarchived = await req(h, `/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { status: "active" },
      });
      expect(unarchived.status).toBe(200);
      expect((await json(unarchived)).status).toBe("active");
    });

    it("hard deletes projects admin-only", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.manager);
      const notAdmin = await req(h, `/api/v1/projects/${project.id}`, {
        method: "DELETE",
        cookie: seed.manager.cookie,
      });
      expect(notAdmin.status).toBe(403);
      const deleted = await req(h, `/api/v1/projects/${project.id}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
      expect(deleted.status).toBe(204);
      const gone = await req(h, `/api/v1/projects/${project.id}`, {
        cookie: seed.admin.cookie,
      });
      expect(gone.status).toBe(404);
    });
  });

  describe("project members", () => {
    it("sets, updates, and removes members with the MemberEntry shape", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const target = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const put = await req(
        h,
        `/api/v1/projects/${project.id}/members/${target.id}`,
        { method: "PUT", cookie: seed.admin.cookie, json: { role: "editor" } },
      );
      expect(put.status).toBe(200);
      const entry = await json<{ user: Record<string, unknown>; role: string }>(
        put,
      );
      expect(entry.role).toBe("editor");
      expect(entry.user.id).toBe(target.id);
      expect(assertSnakeCaseKeys(entry)).toEqual([]);
      const badRole = await req(
        h,
        `/api/v1/projects/${project.id}/members/${target.id}`,
        { method: "PUT", cookie: seed.admin.cookie, json: { role: "owner" } },
      );
      expect(badRole.status).toBe(400);
      const foreignUser = await req(
        h,
        `/api/v1/projects/${project.id}/members/${seed.other.admin.id}`,
        { method: "PUT", cookie: seed.admin.cookie, json: { role: "viewer" } },
      );
      expect(foreignUser.status).toBe(404);
      const removed = await req(
        h,
        `/api/v1/projects/${project.id}/members/${target.id}`,
        { method: "DELETE", cookie: seed.admin.cookie },
      );
      expect(removed.status).toBe(204);
      const removedAgain = await req(
        h,
        `/api/v1/projects/${project.id}/members/${target.id}`,
        { method: "DELETE", cookie: seed.admin.cookie },
      );
      expect(removedAgain.status).toBe(404);
    });

    it("protects the last manager from demotion and removal", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const owner = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const project = await createProject(h, owner);
      const demote = await req(
        h,
        `/api/v1/projects/${project.id}/members/${owner.id}`,
        { method: "PUT", cookie: owner.cookie, json: { role: "editor" } },
      );
      expect(demote.status).toBe(409);
      const remove = await req(
        h,
        `/api/v1/projects/${project.id}/members/${owner.id}`,
        { method: "DELETE", cookie: owner.cookie },
      );
      expect(remove.status).toBe(409);
      // Admins hold implicit manager on every project, so the guard does not
      // apply to them (documented behavior).
      const adminDemote = await req(
        h,
        `/api/v1/projects/${project.id}/members/${owner.id}`,
        { method: "PUT", cookie: seed.admin.cookie, json: { role: "viewer" } },
      );
      expect(adminDemote.status).toBe(200);
    });
  });

  describe("folders", () => {
    it("runs folder CRUD with sibling uniqueness and listing", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      await grantRole(h, seed.admin, project.id, seed.editor.id, "editor");
      const root = await req(h, `/api/v1/projects/${project.id}/folders`, {
        cookie: seed.editor.cookie,
        json: { name: "Dailies" },
      });
      expect(root.status).toBe(201);
      const rootBody = await json<{ id: string }>(root);
      const duplicate = await req(h, `/api/v1/projects/${project.id}/folders`, {
        cookie: seed.editor.cookie,
        json: { name: "Dailies" },
      });
      expect(duplicate.status).toBe(409);
      const child = await req(h, `/api/v1/projects/${project.id}/folders`, {
        cookie: seed.editor.cookie,
        json: { name: "Reel A", parent_id: rootBody.id },
      });
      expect(child.status).toBe(201);
      const childBody = await json<{ id: string }>(child);
      const listRoot = await json<{
        items: Array<{ id: string; name: string }>;
      }>(
        await req(h, `/api/v1/projects/${project.id}/folders`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(listRoot.items.map((item) => item.id)).toContain(rootBody.id);
      expect(listRoot.items.map((item) => item.id)).not.toContain(childBody.id);
      const listChildren = await json<{ items: Array<{ id: string }> }>(
        await req(
          h,
          `/api/v1/projects/${project.id}/folders?parent_id=${rootBody.id}`,
          { cookie: seed.viewer.cookie },
        ),
      );
      expect(listChildren.items.map((item) => item.id)).toContain(childBody.id);
      const renamed = await req(h, `/api/v1/folders/${childBody.id}`, {
        method: "PATCH",
        cookie: seed.editor.cookie,
        json: { name: "Reel B" },
      });
      expect(renamed.status).toBe(200);
      expect((await json(renamed)).name).toBe("Reel B");
      const deleted = await req(h, `/api/v1/folders/${rootBody.id}`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
      expect(deleted.status).toBe(204);
      const childGone = await req(h, `/api/v1/folders/${childBody.id}`, {
        method: "PATCH",
        cookie: seed.editor.cookie,
        json: { name: "Ghost" },
      });
      expect(childGone.status).toBe(404);
    });

    it("rejects cycles, depth over 10, and cross-project parents", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const sibling = await createProject(h, seed.admin);
      let parentId: string | null = null;
      const chain: string[] = [];
      for (let depth = 0; depth < 10; depth += 1) {
        const response: Response = await req(
          h,
          `/api/v1/projects/${project.id}/folders`,
          {
            cookie: seed.admin.cookie,
            json: { name: `Depth ${depth}`, parent_id: parentId },
          },
        );
        expect(response.status).toBe(201);
        const body = await json<{ id: string }>(response);
        parentId = body.id;
        chain.push(body.id);
      }
      const tooDeep = await req(h, `/api/v1/projects/${project.id}/folders`, {
        cookie: seed.admin.cookie,
        json: { name: "Depth 10", parent_id: parentId },
      });
      expect(tooDeep.status).toBe(400);
      const selfParent = await req(h, `/api/v1/folders/${chain[0] ?? ""}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { parent_id: chain[0] },
      });
      expect(selfParent.status).toBe(400);
      const cycle = await req(h, `/api/v1/folders/${chain[0] ?? ""}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { parent_id: chain[2] },
      });
      expect(cycle.status).toBe(400);
      const foreignFolder = await req(
        h,
        `/api/v1/projects/${sibling.id}/folders`,
        { cookie: seed.admin.cookie, json: { name: "Elsewhere" } },
      );
      const foreignBody = await json<{ id: string }>(foreignFolder);
      const crossProject = await req(h, `/api/v1/folders/${chain[9] ?? ""}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { parent_id: foreignBody.id },
      });
      expect(crossProject.status).toBe(400);
      expect(await errorCode(crossProject)).toBe("validation_failed");
    });
  });
};
