import { beforeAll, describe, expect, it } from "vitest";
import { projectEvents, shares, shareAssets } from "@onelight/db/schema";
import { json, req } from "../harness.js";
import { createProject, grantRole, seedAssetVersion } from "../seed.js";
import type { SuiteContext } from "../context.js";

interface ContextWire {
  shares: {
    items: Array<{
      id: string;
      title: string;
      revoked_at: number | null;
      expires_at: number | null;
    }>;
    has_more: boolean;
  } | null;
  activity: {
    items: Array<{ id: string; type: string; at: number }>;
    has_more: boolean;
  };
}

export const registerAssetInspectorDomain = (ctx: SuiteContext): void => {
  describe("asset inspector context", () => {
    let projectId: string;
    let assetId: string;
    let otherAssetId: string;
    let hiddenShareId: string;
    let versionEventId: string;
    let shareIds: string[];

    beforeAll(async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      projectId = (await createProject(h, seed.admin, { restricted: true })).id;
      await grantRole(h, seed.admin, projectId, seed.viewer.id, "viewer");
      await grantRole(h, seed.admin, projectId, seed.manager.id, "manager");
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId,
        userId: seed.admin.id,
      });
      assetId = media.assetId;
      otherAssetId = (
        await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId,
          userId: seed.admin.id,
        })
      ).assetId;
      const memberships = Array.from({ length: 52 }, (_, index) => ({
        id: h.ids.ulid(),
        projectId,
        slug: `inspector-${h.ids.ulid()}`,
        kind: "review" as const,
        title: `Inspector share ${index}`,
        layout: "grid" as const,
        allowDownload: "none" as const,
        passphraseHash: "private-share-hash",
        watermarkSpecHash: "private-watermark-hash",
        createdBy: seed.admin.id,
        createdAt: h.clock.now(),
        revokedAt: index === 51 ? h.clock.now() : null,
      }));
      shareIds = memberships
        .map((share) => share.id)
        .sort()
        .reverse();
      await h.db.insert(shares).values(memberships).run();
      await h.db
        .insert(shareAssets)
        .values(
          memberships.map((share) => ({
            shareId: share.id,
            assetId,
            sortOrder: 0,
          })),
        )
        .run();
      const hiddenProject = await createProject(h, seed.admin, {
        restricted: true,
      });
      hiddenShareId = h.ids.ulid();
      await h.db
        .insert(shares)
        .values({
          ...memberships[0]!,
          id: hiddenShareId,
          slug: `hidden-${hiddenShareId}`,
          projectId: hiddenProject.id,
        })
        .run();
      const events = Array.from({ length: 51 }, () => ({
        id: h.ids.ulid(),
        projectId,
        type: "asset.approval",
        createdAt: h.clock.now(),
        payloadJson: JSON.stringify({
          asset_id: assetId,
          private_identity: "must not leak",
        }),
      }));
      versionEventId = h.ids.ulid();
      events.push({
        id: versionEventId,
        projectId,
        type: "version.transcode",
        createdAt: h.clock.now(),
        payloadJson: JSON.stringify({
          version_id: media.versionId,
          secret: "must not leak",
        }),
      });
      events.push({
        id: h.ids.ulid(),
        projectId,
        type: "wrong.asset",
        createdAt: h.clock.now(),
        payloadJson: JSON.stringify({ asset_id: otherAssetId }),
      });
      events.push({
        id: h.ids.ulid(),
        projectId: seed.project.id,
        type: "wrong.project",
        createdAt: h.clock.now(),
        payloadJson: JSON.stringify({ asset_id: assetId }),
      });
      await h.db.insert(projectEvents).values(events).run();
    });

    it("returns bounded manager membership and recorded activity without secrets or unrelated events", async () => {
      const response = await req(ctx.h(), `/api/v1/assets/${assetId}/context`, {
        cookie: ctx.seed().manager.cookie,
      });
      expect(response.status).toBe(200);
      const body = await json<ContextWire>(response);
      expect(body.shares?.items.map((share) => share.id)).toEqual(
        shareIds.slice(0, 50),
      );
      expect(body.shares?.has_more).toBe(true);
      expect(Object.keys(body.shares?.items[0] ?? {}).sort()).toEqual([
        "expires_at",
        "id",
        "revoked_at",
        "title",
      ]);
      expect(body.activity.items).toHaveLength(50);
      expect(body.activity.has_more).toBe(true);
      expect(body.activity.items[0]?.id).toBe(versionEventId);
      expect(
        body.activity.items.every(
          (event) => Object.keys(event).sort().join(",") === "at,id,type",
        ),
      ).toBe(true);
      expect(
        body.activity.items.some((event) => event.type.startsWith("wrong")),
      ).toBe(false);
      expect(JSON.stringify(body)).not.toContain("must not leak");
      expect(JSON.stringify(body)).not.toContain("private-share-hash");
      expect(JSON.stringify(body)).not.toContain("private-watermark-hash");
    });

    it("separates unavailable membership from an empty result and honors asset authorization", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const viewer = await json<ContextWire>(
        await req(h, `/api/v1/assets/${assetId}/context`, {
          cookie: seed.viewer.cookie,
        }),
      );
      expect(viewer.shares).toBeNull();
      expect(viewer.activity.items).toHaveLength(50);
      const empty = await json<ContextWire>(
        await req(h, `/api/v1/assets/${otherAssetId}/context`, {
          cookie: seed.manager.cookie,
        }),
      );
      expect(empty.shares).toEqual({ items: [], has_more: false });
      expect(empty.activity.has_more).toBe(false);
      for (const actor of [seed.nograntee, seed.guest, seed.other.admin])
        expect(
          (
            await req(h, `/api/v1/assets/${assetId}/context`, {
              cookie: actor.cookie,
            })
          ).status,
        ).toBe(404);
      expect((await req(h, `/api/v1/assets/${assetId}/context`)).status).toBe(
        401,
      );
      expect(
        (
          await req(h, `/api/v1/assets/${h.ids.ulid()}/context`, {
            cookie: seed.admin.cookie,
          })
        ).status,
      ).toBe(404);
    });

    it("hides trashed assets and restores their context only after restore", async () => {
      const h = ctx.h();
      const cookie = ctx.seed().admin.cookie;
      expect(
        (
          await req(h, `/api/v1/assets/${otherAssetId}/trash`, {
            method: "POST",
            cookie,
          })
        ).status,
      ).toBe(204);
      expect(
        (await req(h, `/api/v1/assets/${otherAssetId}/context`, { cookie }))
          .status,
      ).toBe(404);
      expect(
        (
          await req(h, `/api/v1/assets/${otherAssetId}/restore`, {
            method: "POST",
            cookie,
          })
        ).status,
      ).toBe(200);
      expect(
        (await req(h, `/api/v1/assets/${otherAssetId}/context`, { cookie }))
          .status,
      ).toBe(200);
    });

    it("does not leak restricted project shares through the unfiltered workspace list", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const list = async (cookie: string): Promise<string[]> => {
        const response = await req(h, "/api/v1/shares", { cookie });
        expect(response.status).toBe(200);
        return (
          await json<{ items: Array<{ id: string }> }>(response)
        ).items.map((share) => share.id);
      };
      expect(await list(seed.viewer.cookie)).toEqual(
        expect.arrayContaining(shareIds),
      );
      expect(await list(seed.viewer.cookie)).not.toContain(hiddenShareId);
      expect(await list(seed.nograntee.cookie)).not.toEqual(
        expect.arrayContaining([shareIds[0]]),
      );
      expect(await list(seed.guest.cookie)).toEqual([]);
      expect(await list(seed.other.admin.cookie)).not.toContain(hiddenShareId);
      expect(await list(seed.admin.cookie)).toContain(hiddenShareId);
    });
  });
};
