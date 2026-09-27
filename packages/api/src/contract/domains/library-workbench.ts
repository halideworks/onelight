import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { assets } from "@onelight/db/schema";
import { base64UrlDecode, base64UrlEncode } from "@onelight/core";
import { json, req } from "../harness.js";
import { createProject, grantRole, seedAssetVersion } from "../seed.js";
import type { SuiteContext } from "../context.js";

interface AssetWire {
  id: string;
  name: string;
  status: string;
  kind: string;
  folder_id: string | null;
  tags: string[];
  selected: boolean;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}
interface AssetPage {
  items: AssetWire[];
  next_cursor: string | null;
}

export const registerLibraryWorkbenchDomain = (ctx: SuiteContext): void => {
  describe("library workbench", () => {
    let projectId: string;
    let folderId: string;
    let shareId: string;
    let rows: Array<typeof assets.$inferInsert>;

    it("documents optional mutation bodies without weakening their JSON schemas", async () => {
      const document = await json<{
        paths: Record<
          string,
          Record<
            string,
            {
              requestBody?: {
                required: boolean;
                content: Record<string, { schema: Record<string, unknown> }>;
              };
            }
          >
        >;
      }>(await req(ctx.h(), "/api/v1/openapi.json"));
      for (const [method, path] of [
        ["delete", "/api/v1/assets/{id}"],
        ["post", "/api/v1/assets/{id}/trash"],
        ["post", "/api/v1/assets/{id}/restore"],
      ]) {
        const body = document.paths[path!]?.[method!]?.requestBody;
        expect(body?.required).toBe(false);
        expect(body?.content["application/json"]?.schema.type).toBe("object");
        expect(body?.content["application/json"]?.schema).not.toHaveProperty(
          "anyOf",
        );
      }
    });

    beforeAll(async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      projectId = (await createProject(h, seed.admin, { restricted: true })).id;
      await grantRole(h, seed.admin, projectId, seed.viewer.id, "viewer");
      folderId = (
        await json<{ id: string }>(
          await req(h, `/api/v1/projects/${projectId}/folders`, {
            cookie: seed.admin.cookie,
            json: { name: "Workbench bin" },
          }),
        )
      ).id;
      rows = ["Echo", "bravo", "ALPHA", "alpha", "Bravo", "Delta"].map(
        (name, index) => ({
          id: h.ids.ulid(),
          projectId,
          name,
          kind: index < 4 ? "video" : "audio",
          folderId: index < 4 ? folderId : null,
          status: index % 2 ? "approved" : "in_review",
          selectedAt: index < 4 ? h.clock.now() : null,
          createdAt: h.clock.now() + Math.floor(index / 2),
          updatedAt: h.clock.now() + (index % 3),
        }),
      );
      await h.db.insert(assets).values(rows).run();
      shareId = (
        await json<{ share: { id: string } }>(
          await req(h, "/api/v1/shares", {
            cookie: seed.admin.cookie,
            json: {
              project_id: projectId,
              title: "Workbench share",
              asset_ids: rows.map((row) => row.id),
            },
          }),
        )
      ).share.id;
    });

    const list = async (
      query: string,
      cookie = ctx.seed().viewer.cookie,
    ): Promise<AssetPage> => {
      const response = await req(
        ctx.h(),
        `/api/v1/projects/${projectId}/assets?${query}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      return json<AssetPage>(response);
    };

    it("pages every sort in both directions with deterministic tied-value boundaries", async () => {
      for (const sort of [
        "name",
        "status",
        "created_at",
        "updated_at",
      ] as const) {
        for (const direction of ["asc", "desc"] as const) {
          const collected: string[] = [];
          let cursor: string | null = null;
          let pages = 0;
          do {
            const page: AssetPage = await list(
              `limit=2&sort=${sort}&direction=${direction}${cursor ? `&cursor=${cursor}` : ""}`,
            );
            collected.push(...page.items.map((row) => row.id));
            cursor = page.next_cursor;
            pages += 1;
          } while (cursor && pages < 10);
          const key = (row: (typeof rows)[number]): string | number =>
            sort === "name"
              ? row.name.toLowerCase()
              : sort === "created_at"
                ? row.createdAt
                : sort === "updated_at"
                  ? row.updatedAt
                  : (row.status ?? "none");
          const expected = [...rows].sort((a, b) => {
            const left = key(a);
            const right = key(b);
            const compared =
              left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : 1;
            return direction === "asc" ? compared : -compared;
          });
          expect(pages).toBe(3);
          expect(cursor).toBeNull();
          expect(collected).toEqual(expected.map((row) => row.id));
        }
      }
    });

    it("combines filters before paging and preserves legacy cursors", async () => {
      const filters = `folder_id=${folderId}&share_id=${shareId}&selected=1&status=approved&kind=video`;
      const first = await list(`limit=1&sort=name&direction=asc&${filters}`);
      expect(first.items.map((row) => row.id)).toEqual([rows[3]?.id]);
      expect(first.next_cursor).not.toBeNull();
      const second = await list(
        `limit=1&sort=name&direction=asc&${filters}&cursor=${first.next_cursor}`,
      );
      expect(second.items.map((row) => row.id)).toEqual([rows[1]?.id]);
      expect(second.next_cursor).toBeNull();
      const filteredDefault = await list("limit=1&status=approved");
      const continued = await list(
        `limit=1&status=approved&cursor=${filteredDefault.next_cursor}`,
      );
      expect(continued.items[0]?.id).toBe(rows[3]?.id);
      const legacy = await list("limit=2");
      expect(legacy.items.map((row) => row.id)).toEqual(
        rows
          .slice(-2)
          .reverse()
          .map((row) => row.id),
      );
      expect(
        new TextDecoder().decode(base64UrlDecode(legacy.next_cursor ?? "")),
      ).toBe(rows[4]?.id);
    });

    it("rejects malformed, context-swapped and wrong-type cursors and invalid filters", async () => {
      const h = ctx.h();
      const base = `sort=name&direction=asc&folder_id=${folderId}&share_id=${shareId}&selected=1&status=approved&kind=video&limit=1`;
      const first = await list(base);
      const query = new URLSearchParams(base);
      query.set("cursor", first.next_cursor ?? "");
      for (const [key, value] of Object.entries({
        sort: "status",
        direction: "desc",
        folder_id: "",
        share_id: "",
        selected: "0",
        status: "none",
        kind: "audio",
      })) {
        const changed = new URLSearchParams(query);
        changed.set(key, value);
        expect(
          (
            await req(h, `/api/v1/projects/${projectId}/assets?${changed}`, {
              cookie: ctx.seed().admin.cookie,
            })
          ).status,
        ).toBe(400);
      }
      expect(
        (
          await req(
            h,
            `/api/v1/projects/${ctx.seed().project.id}/assets?sort=name&direction=asc&cursor=${first.next_cursor}`,
            { cookie: ctx.seed().admin.cookie },
          )
        ).status,
      ).toBe(400);
      for (const invalid of [
        "sort=nope",
        "sort=name&direction=sideways",
        "direction=asc",
        "status=nope",
        "kind=document",
        "sort=name&cursor=nope",
        `sort=name&cursor=${"A".repeat(8193)}`,
      ]) {
        expect(
          (
            await req(h, `/api/v1/projects/${projectId}/assets?${invalid}`, {
              cookie: ctx.seed().admin.cookie,
            })
          ).status,
        ).toBe(400);
      }
      const decoded = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(first.next_cursor ?? "")),
      ) as Record<string, unknown>;
      decoded.value = 123;
      query.set(
        "cursor",
        base64UrlEncode(new TextEncoder().encode(JSON.stringify(decoded))),
      );
      expect(
        (
          await req(h, `/api/v1/projects/${projectId}/assets?${query}`, {
            cookie: ctx.seed().admin.cookie,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await req(h, `/api/v1/projects/${projectId}/assets?sort=name`, {
            cookie: ctx.seed().guest.cookie,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await req(h, `/api/v1/projects/${projectId}/assets?sort=name`, {
            cookie: ctx.seed().other.admin.cookie,
          })
        ).status,
      ).toBe(404);
    });

    const newAsset = async (): Promise<AssetWire> => {
      const h = ctx.h();
      const seed = ctx.seed();
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: seed.project.id,
        userId: seed.admin.id,
        name: "Original",
      });
      return json<AssetWire>(
        await req(h, `/api/v1/assets/${media.assetId}`, {
          cookie: seed.editor.cookie,
        }),
      );
    };

    it("guards relevant fields atomically without blocking or overwriting unrelated edits", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const asset = await newAsset();
      const patch = (body: unknown) =>
        req(h, `/api/v1/assets/${asset.id}`, {
          method: "PATCH",
          cookie: seed.editor.cookie,
          json: body,
        });
      const renamed = await patch({
        name: "Renamed",
        expected: { name: asset.name },
      });
      expect(renamed.status).toBe(200);
      const renamedBody = await json<AssetWire>(renamed);
      expect(renamedBody.updated_at).toBeGreaterThan(asset.updated_at);
      expect((await patch({ tags: ["retouch"] })).status).toBe(200);
      const undone = await patch({
        name: asset.name,
        expected: { name: "Renamed" },
      });
      expect(undone.status).toBe(200);
      expect(await json<AssetWire>(undone)).toMatchObject({
        name: "Original",
        tags: ["retouch"],
      });
      expect(
        (await patch({ name: "Clobber", expected: { name: "Renamed" } }))
          .status,
      ).toBe(409);
      expect(
        (await patch({ tags: ["old"], expected: { tags: [] } })).status,
      ).toBe(409);
      expect(
        (await patch({ tags: [], expected: { tags: ["retouch"] } })).status,
      ).toBe(200);
      expect(
        (await patch({ selected: true, expected: { selected: false } })).status,
      ).toBe(200);
      expect(
        (await patch({ selected: false, expected: { selected: false } }))
          .status,
      ).toBe(409);
      expect(
        (
          await patch({
            name: "No",
            expected: { updated_at: asset.updated_at },
          })
        ).status,
      ).toBe(409);
      expect(
        (await patch({ name: "No", expected: { typo: true } })).status,
      ).toBe(400);
      expect(
        (await patch({ name: "No", expected: { deleted_at: -1 } })).status,
      ).toBe(400);
      expect(
        (
          await req(h, `/api/v1/assets/${asset.id}`, {
            method: "PATCH",
            cookie: seed.viewer.cookie,
            json: { name: "No", expected: { name: "Original" } },
          })
        ).status,
      ).toBe(403);
    });

    it("guards null folder moves and validates undo destinations", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const asset = await newAsset();
      const folder = await json<{ id: string }>(
        await req(h, `/api/v1/projects/${seed.project.id}/folders`, {
          cookie: seed.editor.cookie,
          json: { name: `Undo ${asset.id}` },
        }),
      );
      const move = (target: string | null, expected: string | null) =>
        req(h, `/api/v1/assets/${asset.id}`, {
          method: "PATCH",
          cookie: seed.editor.cookie,
          json: { folder_id: target, expected: { folder_id: expected } },
        });
      expect((await move(folder.id, null)).status).toBe(200);
      expect((await move(null, null)).status).toBe(409);
      expect((await move(null, folder.id)).status).toBe(200);
      expect((await move(folderId, null)).status).toBe(400);
      expect(
        (
          await req(h, `/api/v1/folders/${folder.id}`, {
            method: "DELETE",
            cookie: seed.editor.cookie,
          })
        ).status,
      ).toBe(204);
      expect((await move(folder.id, null)).status).toBe(400);
    });

    it("requires manager approval through generic patches and notifies the uploader", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const asset = await newAsset();
      const patch = (cookie: string, body: unknown) =>
        req(h, `/api/v1/assets/${asset.id}`, {
          method: "PATCH",
          cookie,
          json: body,
        });
      expect(
        (
          await patch(seed.editor.cookie, {
            status: "approved",
            name: "Denied",
          })
        ).status,
      ).toBe(403);
      expect(
        await json<AssetWire>(
          await req(h, `/api/v1/assets/${asset.id}`, {
            cookie: seed.viewer.cookie,
          }),
        ),
      ).toMatchObject({ name: asset.name, status: asset.status });
      expect(
        (
          await patch(seed.manager.cookie, {
            name: "Approved deliverable",
            status: "approved",
            expected: { status: asset.status },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await patch(seed.manager.cookie, {
            status: "none",
            expected: { status: asset.status },
          })
        ).status,
      ).toBe(409);
      const notices = await json<{
        items: Array<{
          kind: string;
          payload: { asset_id?: string; status?: string };
        }>;
      }>(
        await req(h, "/api/v1/notifications?limit=200", {
          cookie: seed.admin.cookie,
        }),
      );
      expect(
        notices.items.filter(
          (notice) =>
            notice.kind === "approval.updated" &&
            notice.payload.asset_id === asset.id,
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ status: "approved" }),
        }),
      ]);
    });

    it("makes approval reversals manager-only and rejects stale decisions", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const asset = await newAsset();
      const approval = (
        status: string,
        expected: string,
        cookie = seed.manager.cookie,
      ) =>
        req(h, `/api/v1/assets/${asset.id}/approval`, {
          method: "PATCH",
          cookie,
          json: { status, expected: { status: expected } },
        });
      expect(
        (await approval("approved", "in_review", seed.editor.cookie)).status,
      ).toBe(403);
      expect((await approval("approved", "in_review")).status).toBe(200);
      expect((await approval("none", "in_review")).status).toBe(409);
      expect((await approval("in_review", "approved")).status).toBe(200);
      const unchanged = await json<AssetWire>(
        await req(h, `/api/v1/assets/${asset.id}`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(unchanged.status).toBe("in_review");
    });

    it("returns actual trash tokens and rejects stale undo after a same-clock re-trash", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const asset = await newAsset();
      const trash = (body?: unknown, method = "POST") =>
        req(
          h,
          `/api/v1/assets/${asset.id}${method === "POST" ? "/trash" : ""}`,
          {
            method,
            cookie: seed.editor.cookie,
            ...(body === undefined ? {} : { json: body }),
          },
        );
      const restore = (stamp: number | null) =>
        req(h, `/api/v1/assets/${asset.id}/restore`, {
          method: "POST",
          cookie: seed.editor.cookie,
          json: { expected: { deleted_at: stamp } },
        });
      const first = await trash({
        return_asset: true,
        expected: { deleted_at: null },
      });
      expect(first.status).toBe(200);
      const firstBody = await json<AssetWire>(first);
      expect(firstBody.deleted_at).toBeGreaterThan(asset.updated_at);
      expect(firstBody.deleted_at).toBe(firstBody.updated_at);
      expect(
        (await trash({ return_asset: true, expected: { deleted_at: null } }))
          .status,
      ).toBe(409);
      expect((await restore(firstBody.deleted_at)).status).toBe(200);
      expect((await restore(firstBody.deleted_at)).status).toBe(409);
      /* Thumbnail mutation used to rewind updated_at to the fixed clock. */
      expect(
        (
          await req(h, `/api/v1/assets/${asset.id}/thumbnail`, {
            method: "DELETE",
            cookie: seed.editor.cookie,
          })
        ).status,
      ).toBe(204);
      const second = await trash(
        { return_asset: true, expected: { deleted_at: null } },
        "DELETE",
      );
      expect(second.status).toBe(200);
      const secondBody = await json<AssetWire>(second);
      expect(secondBody.deleted_at).toBeGreaterThan(firstBody.deleted_at ?? 0);
      expect((await restore(firstBody.deleted_at)).status).toBe(409);
      expect((await restore(secondBody.deleted_at)).status).toBe(200);
      expect((await trash()).status).toBe(204);
      expect(
        (
          await req(h, `/api/v1/assets/${asset.id}/restore`, {
            method: "POST",
            cookie: seed.editor.cookie,
          })
        ).status,
      ).toBe(200);
      expect((await trash(undefined, "DELETE")).status).toBe(204);
      const [stored] = await h.db
        .select()
        .from(assets)
        .where(eq(assets.id, asset.id))
        .all();
      expect(stored?.deletedAt).not.toBeNull();
      expect(
        (
          await req(h, `/api/v1/assets/${asset.id}/restore`, {
            method: "POST",
            cookie: seed.editor.cookie,
            body: "",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await req(h, `/api/v1/assets/${asset.id}/trash`, {
            method: "POST",
            cookie: seed.editor.cookie,
            body: "",
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await req(h, `/api/v1/assets/${asset.id}/restore`, {
            method: "POST",
            cookie: seed.editor.cookie,
            body: "{",
          })
        ).status,
      ).toBe(400);
    });

    it("reorders a whole share atomically and rejects stale undo or membership edits", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const original = rows.map((row) => row.id);
      const reversed = [...original].reverse();
      const order = (
        assetIds: string[],
        expectedIds?: string[],
        cookie = seed.admin.cookie,
      ) =>
        req(h, `/api/v1/shares/${shareId}/assets`, {
          method: "PATCH",
          cookie,
          json: {
            asset_ids: assetIds,
            ...(expectedIds ? { expected_asset_ids: expectedIds } : {}),
          },
        });
      expect((await order(reversed, original, seed.viewer.cookie)).status).toBe(
        403,
      );
      const changed = await order(reversed, original);
      expect(changed.status).toBe(200);
      expect(await json(changed)).toEqual({
        items: reversed.map((id, index) => ({
          asset_id: id,
          sort_order: index,
        })),
      });
      expect((await order(original, original)).status).toBe(409);
      const persisted = await json<{ assets: Array<{ asset_id: string }> }>(
        await req(h, `/api/v1/shares/${shareId}`, {
          cookie: seed.admin.cookie,
        }),
      );
      expect(persisted.assets.map((row) => row.asset_id)).toEqual(reversed);
      expect((await order(original, reversed)).status).toBe(200);
      const competing = await Promise.all([
        order(reversed, original),
        order([...original.slice(1), original[0]!], original),
      ]);
      expect(competing.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      expect((await order(original)).status).toBe(200);
      expect((await order([original[0]!, original[0]!])).status).toBe(400);
      expect((await order(original.slice(1), original)).status).toBe(409);
      const after = await json<{ assets: Array<{ asset_id: string }> }>(
        await req(h, `/api/v1/shares/${shareId}`, {
          cookie: seed.admin.cookie,
        }),
      );
      expect(after.assets.map((row) => row.asset_id)).toEqual(original);
    });

    it("reads one authorized folder without exposing foreign, revoked or deleted folders", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const path = `/api/v1/folders/${folderId}`;
      const read = await req(h, path, { cookie: seed.viewer.cookie });
      expect(read.status).toBe(200);
      expect(await json(read)).toEqual({
        id: folderId,
        project_id: projectId,
        parent_id: null,
        kind: "assets",
        name: "Workbench bin",
        created_at: expect.any(Number),
      });
      expect((await req(h, path, { cookie: seed.guest.cookie })).status).toBe(
        404,
      );
      expect(
        (await req(h, path, { cookie: seed.other.admin.cookie })).status,
      ).toBe(404);
      expect(
        (
          await req(
            h,
            `/api/v1/projects/${projectId}/members/${seed.viewer.id}`,
            { method: "DELETE", cookie: seed.admin.cookie },
          )
        ).status,
      ).toBe(204);
      expect((await req(h, path, { cookie: seed.viewer.cookie })).status).toBe(
        404,
      );
      await grantRole(h, seed.admin, projectId, seed.viewer.id, "viewer");
      const temp = await json<{ id: string }>(
        await req(h, `/api/v1/projects/${projectId}/folders`, {
          cookie: seed.admin.cookie,
          json: { name: "Deleted pin" },
        }),
      );
      expect(
        (
          await req(h, `/api/v1/folders/${temp.id}`, {
            method: "DELETE",
            cookie: seed.admin.cookie,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await req(h, `/api/v1/folders/${temp.id}`, {
            cookie: seed.viewer.cookie,
          })
        ).status,
      ).toBe(404);
    });
  });
};
