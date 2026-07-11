import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { exportJobs } from "@onelight/db/schema";
import {
  assertSnakeCaseKeys,
  cookieFrom,
  errorCode,
  forbiddenKeysIn,
  json,
  req,
  travel,
} from "../harness.js";
import type { ContractHarness } from "../harness.js";
import type { SeedState } from "../seed.js";
import {
  createProject,
  seedAssetVersion,
  seedExtraVersion,
  seedRendition,
  unique,
  uniqueIp,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

interface ShareFixture {
  projectId: string;
  assetId: string;
  versionId: string;
  shareId: string;
  slug: string;
}

const makeShare = async (
  h: ContractHarness,
  seed: SeedState,
  options: Record<string, unknown> = {},
): Promise<ShareFixture> => {
  const project = await createProject(h, seed.admin);
  const media = await seedAssetVersion(h, {
    workspaceId: seed.workspaceId,
    projectId: project.id,
    userId: seed.admin.id,
  });
  const response = await req(h, "/api/v1/shares", {
    cookie: seed.admin.cookie,
    json: {
      project_id: project.id,
      title: unique("Client Review"),
      asset_ids: [media.assetId],
      ...options,
    },
  });
  if (response.status !== 201)
    throw new Error(`Share fixture failed: ${response.status}`);
  const body = await json<{ share: { id: string; slug: string } }>(response);
  return {
    projectId: project.id,
    assetId: media.assetId,
    versionId: media.versionId,
    shareId: body.share.id,
    slug: body.share.slug,
  };
};

const accessShare = async (
  h: ContractHarness,
  slug: string,
  body: Record<string, unknown> = { name: "Client" },
): Promise<{ cookie: string; viewerKey: string; response: Response }> => {
  const response = await req(h, `/api/v1/s/${slug}/access`, {
    json: body,
    headers: { "x-forwarded-for": uniqueIp() },
  });
  const parsed =
    response.status === 200
      ? await json<{ viewer_key: string }>(response)
      : { viewer_key: "" };
  return {
    cookie: cookieFrom(response),
    viewerKey: parsed.viewer_key,
    response,
  };
};

export const registerSharesDomain = (ctx: SuiteContext): void => {
  describe("shares", () => {
    it("creates shares manager-only with project-scoped assets", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      const denied = await req(h, "/api/v1/shares", {
        cookie: seed.editor.cookie,
        json: {
          project_id: seed.project.id,
          title: "Editor Share",
          asset_ids: [seed.media.assetId],
        },
      });
      expect(denied.status).toBe(403);
      const crossProject = await req(h, "/api/v1/shares", {
        cookie: seed.admin.cookie,
        json: {
          project_id: project.id,
          title: "Cross Project",
          asset_ids: [seed.media.assetId],
        },
      });
      expect(crossProject.status).toBe(400);
      const created = await req(h, "/api/v1/shares", {
        cookie: seed.admin.cookie,
        json: {
          project_id: project.id,
          title: "Cut 04 Review",
          asset_ids: [media.assetId],
          allow_download: "proxy",
          passphrase: "open-sesame-1",
        },
      });
      expect(created.status).toBe(201);
      const body = await json<{
        share: Record<string, unknown> & { id: string };
        url: string;
      }>(created);
      expect(body.share.allow_download).toBe("proxy");
      expect(body.url).toContain("/s/");
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(forbiddenKeysIn(body)).toEqual([]);
      const detail = await req(h, `/api/v1/shares/${body.share.id}`, {
        cookie: seed.admin.cookie,
      });
      expect(detail.status).toBe(200);
      const detailBody = await json<{ assets: unknown[] }>(detail);
      expect(detailBody.assets).toHaveLength(1);
      const listed = await json<{ items: Array<{ id: string }> }>(
        await req(h, `/api/v1/shares?project_id=${project.id}`, {
          cookie: seed.admin.cookie,
        }),
      );
      expect(listed.items.some((item) => item.id === body.share.id)).toBe(true);
      const foreign = await req(h, `/api/v1/shares/${body.share.id}`, {
        cookie: seed.other.admin.cookie,
      });
      expect(foreign.status).toBe(404);
      const patched = await req(h, `/api/v1/shares/${body.share.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { title: "Retitled", allow_download: "original", layout: "list" },
      });
      expect(patched.status).toBe(200);
      const patchedBody = await json(patched);
      expect(patchedBody.title).toBe("Retitled");
      expect(patchedBody.allow_download).toBe("original");
    });

    it("gates passphrase shares before issuing viewer state", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed, {
        passphrase: "swordfish-99",
      });
      const noViewer = await req(h, `/api/v1/s/${fixture.slug}`);
      expect(noViewer.status).toBe(401);
      const wrong = await accessShare(h, fixture.slug, {
        passphrase: "wrong-guess",
        name: "Intruder",
      });
      expect(wrong.response.status).toBe(401);
      expect(await errorCode(wrong.response)).toBe("invalid_credentials");
      const right = await accessShare(h, fixture.slug, {
        passphrase: "swordfish-99",
        name: "Client",
      });
      expect(right.response.status).toBe(200);
      expect(right.cookie).toContain(`ol_share_${fixture.shareId}=`);
      const shell = await req(h, `/api/v1/s/${fixture.slug}`, {
        cookie: right.cookie,
      });
      expect(shell.status).toBe(200);
      const assets = await req(h, `/api/v1/s/${fixture.slug}/assets`, {
        cookie: right.cookie,
      });
      expect(assets.status).toBe(200);
      const assetsBody = await json<{
        items: Array<Record<string, unknown>>;
      }>(assets);
      expect(assetsBody.items).toHaveLength(1);
      expect(assertSnakeCaseKeys(assetsBody)).toEqual([]);
    });

    it("expires shares by wall clock", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed, {
        expires_at: h.clock.now() + 60_000,
      });
      const before = await accessShare(h, fixture.slug);
      expect(before.response.status).toBe(200);
      await travel(h.clock, 2 * 60_000, async () => {
        const shell = await req(h, `/api/v1/s/${fixture.slug}`, {
          cookie: before.cookie,
        });
        expect(shell.status).toBe(404);
        const access = await accessShare(h, fixture.slug);
        expect(access.response.status).toBe(404);
      });
    });

    it("stops serving a share after revocation", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const revoked = await req(h, `/api/v1/shares/${fixture.shareId}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
      expect(revoked.status).toBe(204);
      const shell = await req(h, `/api/v1/s/${fixture.slug}`, {
        cookie: viewer.cookie,
      });
      expect(shell.status).toBe(404);
      const media = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/media`,
        { cookie: viewer.cookie },
      );
      expect(media.status).toBe(404);
    });

    it("projects only public comments on the current version to viewers", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const internal = await req(
        h,
        `/api/v1/versions/${fixture.versionId}/comments`,
        {
          cookie: seed.admin.cookie,
          json: { body_text: "internal note", internal: true },
        },
      );
      expect(internal.status).toBe(201);
      const publicComment = await req(
        h,
        `/api/v1/versions/${fixture.versionId}/comments`,
        {
          cookie: seed.admin.cookie,
          json: { body_text: "public note", frame_in: 3 },
        },
      );
      expect(publicComment.status).toBe(201);
      const viewer = await accessShare(h, fixture.slug);
      const listed = await json<{
        items: Array<Record<string, unknown> & { id: string }>;
      }>(
        await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
          { cookie: viewer.cookie },
        ),
      );
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.body_text).toBe("public note");
      expect(listed.items[0]?.internal).toBe(false);
      expect(forbiddenKeysIn(listed, ["viewer_key"])).toEqual([]);
      // Replying to the internal comment through the share is refused.
      const internalBody = await json<{ id: string }>(internal);
      const replyToInternal = await req(
        h,
        `/s/${fixture.slug}/comments/${internalBody.id}/replies`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: true,
          json: { body_text: "should not see this thread" },
        },
      );
      expect(replyToInternal.status).toBe(404);
      // Replying to a comment outside this share is refused too.
      const foreignComment = await req(
        h,
        `/api/v1/versions/${seed.media.versionId}/comments`,
        { cookie: seed.admin.cookie, json: { body_text: "other project" } },
      );
      const foreignBody = await json<{ id: string }>(foreignComment);
      const replyToForeign = await req(
        h,
        `/s/${fixture.slug}/comments/${foreignBody.id}/replies`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: true,
          json: { body_text: "cross share probe" },
        },
      );
      expect(replyToForeign.status).toBe(404);
      const replyToPublic = await req(
        h,
        `/s/${fixture.slug}/comments/${listed.items[0]?.id ?? ""}/replies`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: true,
          json: { body_text: "a viewer reply" },
        },
      );
      expect(replyToPublic.status).toBe(201);
    });

    it("enforces viewer ownership on share comment mutations", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewerA = await accessShare(h, fixture.slug, { name: "Alice" });
      const viewerB = await accessShare(h, fixture.slug, { name: "Bob" });
      const created = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
        {
          method: "POST",
          cookie: viewerA.cookie,
          origin: true,
          json: { frame_in: 10, body_text: "alice note" },
          headers: { "x-forwarded-for": uniqueIp() },
        },
      );
      expect(created.status).toBe(201);
      const comment = await json<{
        id: string;
        author_name: string | null;
        internal: boolean;
      }>(created);
      expect(comment.author_name).toBe("Alice");
      expect(comment.internal).toBe(false);
      const bobEdit = await req(
        h,
        `/api/v1/s/${fixture.slug}/comments/${comment.id}`,
        {
          method: "PATCH",
          cookie: viewerB.cookie,
          origin: true,
          json: { body_text: "bob hijack" },
        },
      );
      expect(bobEdit.status).toBe(403);
      const bobDelete = await req(
        h,
        `/api/v1/s/${fixture.slug}/comments/${comment.id}`,
        { method: "DELETE", cookie: viewerB.cookie, origin: true },
      );
      expect(bobDelete.status).toBe(403);
      const aliceEdit = await req(
        h,
        `/api/v1/s/${fixture.slug}/comments/${comment.id}`,
        {
          method: "PATCH",
          cookie: viewerA.cookie,
          origin: true,
          json: { body_text: "alice edited" },
        },
      );
      expect(aliceEdit.status).toBe(200);
      expect((await json(aliceEdit)).body_text).toBe("alice edited");
      const aliceDelete = await req(
        h,
        `/api/v1/s/${fixture.slug}/comments/${comment.id}`,
        { method: "DELETE", cookie: viewerA.cookie, origin: true },
      );
      expect(aliceDelete.status).toBe(204);
    });

    it("blocks share-cookie mutations from a foreign origin", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const blocked = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: "http://evil.example",
          json: { body_text: "csrf attempt" },
        },
      );
      expect(blocked.status).toBe(403);
      const noOrigin = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: false,
          json: { body_text: "csrf attempt" },
        },
      );
      expect(noOrigin.status).toBe(403);
    });

    it("honors allow_comments=false for comments and replies", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed, { allow_comments: false });
      const viewer = await accessShare(h, fixture.slug);
      const comment = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: true,
          json: { body_text: "nope" },
          headers: { "x-forwarded-for": uniqueIp() },
        },
      );
      expect(comment.status).toBe(403);
    });

    it("limits version visibility by show_all_versions", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      await seedExtraVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: fixture.projectId,
        userId: seed.admin.id,
        assetId: fixture.assetId,
        versionNo: 2,
        makeCurrent: true,
      });
      const viewer = await accessShare(h, fixture.slug);
      const single = await json<{ versions: unknown[] }>(
        await req(h, `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}`, {
          cookie: viewer.cookie,
        }),
      );
      expect(single.versions).toHaveLength(1);
      const patched = await req(h, `/api/v1/shares/${fixture.shareId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { show_all_versions: true },
      });
      expect(patched.status).toBe(200);
      const all = await json<{ versions: unknown[] }>(
        await req(h, `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}`, {
          cookie: viewer.cookie,
        }),
      );
      expect(all.versions).toHaveLength(2);
      const missingAsset = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${seed.media.assetId}`,
        { cookie: viewer.cookie },
      );
      expect(missingAsset.status).toBe(404);
    });

    it("records share approval decisions for shared assets only", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const approved = await req(h, `/api/v1/s/${fixture.slug}/approval`, {
        method: "PATCH",
        cookie: viewer.cookie,
        origin: true,
        json: { asset_id: fixture.assetId, status: "approved" },
      });
      expect(approved.status).toBe(200);
      expect(await json(approved)).toEqual({
        asset_id: fixture.assetId,
        status: "approved",
      });
      const assetState = await req(h, `/api/v1/assets/${fixture.assetId}`, {
        cookie: seed.admin.cookie,
      });
      expect((await json(assetState)).status).toBe("approved");
      const foreignAsset = await req(h, `/api/v1/s/${fixture.slug}/approval`, {
        method: "PATCH",
        cookie: viewer.cookie,
        origin: true,
        json: { asset_id: seed.media.assetId, status: "approved" },
      });
      expect(foreignAsset.status).toBe(404);
      const anonymous = await req(h, `/api/v1/s/${fixture.slug}/approval`, {
        method: "PATCH",
        origin: true,
        json: { asset_id: fixture.assetId, status: "none" },
      });
      expect(anonymous.status).toBe(401);
    });

    it("rate limits share access per share and IP with window reset", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const ip = uniqueIp();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await req(h, `/api/v1/s/${fixture.slug}/access`, {
          json: { name: "Repeat" },
          headers: { "x-forwarded-for": ip },
        });
        expect(response.status).toBe(200);
      }
      const limited = await req(h, `/api/v1/s/${fixture.slug}/access`, {
        json: { name: "Repeat" },
        headers: { "x-forwarded-for": ip },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      const otherIp = await req(h, `/api/v1/s/${fixture.slug}/access`, {
        json: { name: "Fresh" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(otherIp.status).toBe(200);
      await travel(h.clock, 5 * 60_000 + 1000, async () => {
        const reset = await req(h, `/api/v1/s/${fixture.slug}/access`, {
          json: { name: "Repeat" },
          headers: { "x-forwarded-for": ip },
        });
        expect(reset.status).toBe(200);
      });
    });

    it("rate limits anonymous share comments per share and IP", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const ip = uniqueIp();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
          {
            method: "POST",
            cookie: viewer.cookie,
            origin: true,
            json: { body_text: `note ${attempt}` },
            headers: { "x-forwarded-for": ip },
          },
        );
        expect(response.status).toBe(201);
      }
      const limited = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
        {
          method: "POST",
          cookie: viewer.cookie,
          origin: true,
          json: { body_text: "over the line" },
          headers: { "x-forwarded-for": ip },
        },
      );
      expect(limited.status).toBe(429);
    });

    it("serves the root /s/ paths with the JSON error envelope", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const shell = await req(h, `/s/${fixture.slug}`, {
        cookie: viewer.cookie,
      });
      expect(shell.status).toBe(200);
      const assets = await req(h, `/s/${fixture.slug}/assets`, {
        cookie: viewer.cookie,
      });
      expect(assets.status).toBe(200);
      const unknown = await req(h, "/s/not-a-real-slug");
      expect(unknown.status).toBe(404);
      expect(await errorCode(unknown)).toBe("not_found");
    });

    ctx.itBlob(
      "issues share media tokens and serves ranged media with them",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        const rendition = await seedRendition(h, {
          versionId: fixture.versionId,
          content: "share-proxy-bytes",
        });
        const viewer = await accessShare(h, fixture.slug);
        const anonymous = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/media`,
        );
        expect(anonymous.status).toBe(401);
        const issued = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/media`,
          { cookie: viewer.cookie },
        );
        expect(issued.status).toBe(200);
        const { url } = await json<{ url: string }>(issued);
        const parsed = new URL(url);
        const withToken = await req(h, parsed.pathname + parsed.search);
        expect(withToken.status).toBe(200);
        expect(await withToken.text()).toBe("share-proxy-bytes");
        const withoutToken = await req(h, parsed.pathname);
        expect(withoutToken.status).toBe(401);
        const ranged = await req(h, parsed.pathname + parsed.search, {
          headers: { range: "bytes=0-4" },
        });
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("content-range")).toBe(
          `bytes 0-4/${rendition.bytes.byteLength}`,
        );
        expect(await ranged.text()).toBe("share");
        const unsatisfiable = await req(h, parsed.pathname + parsed.search, {
          headers: { range: "bytes=500-" },
        });
        expect(unsatisfiable.status).toBe(416);
      },
    );
  });

  describe("exports", () => {
    it("accepts every documented format and validates the request", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      for (const format of [
        "resolve_edl",
        "avid_txt",
        "avid_xml",
        "xmeml",
        "fcpxml",
        "csv",
        "json",
        "text",
        "pdf",
      ]) {
        const response = await req(
          h,
          `/api/v1/shares/${fixture.shareId}/export`,
          { cookie: seed.admin.cookie, json: { format } },
        );
        expect(response.status, format).toBe(202);
        const body = await json<{ id: string; status: string }>(response);
        expect(body.status).toBe("queued");
      }
      const badFormat = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/export`,
        { cookie: seed.admin.cookie, json: { format: "omf" } },
      );
      expect(badFormat.status).toBe(400);
      const badBase = await req(h, `/api/v1/shares/${fixture.shareId}/export`, {
        cookie: seed.admin.cookie,
        json: { format: "csv", timecode_base: "free_run" },
      });
      expect(badBase.status).toBe(400);
      const missingShare = await req(
        h,
        "/api/v1/shares/01ARZ3NDEKTSV4RRFFQ69G5FAV/export",
        { cookie: seed.admin.cookie, json: { format: "csv" } },
      );
      expect(missingShare.status).toBe(404);
    });

    it("polls export status scoped to the workspace", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const created = await req(h, `/api/v1/shares/${fixture.shareId}/export`, {
        cookie: seed.admin.cookie,
        json: { format: "csv", timecode_base: "record_run", filters: {} },
      });
      const exported = await json<{ id: string }>(created);
      const status = await req(h, `/api/v1/exports/${exported.id}`, {
        cookie: seed.admin.cookie,
      });
      expect(status.status).toBe(200);
      const body = await json(status);
      expect(body.format).toBe("csv");
      expect(body.timecode_base).toBe("record_run");
      expect(body.status).toBe("queued");
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(
        forbiddenKeysIn(body, ["result_blob_key", "resultBlobKey"]),
      ).toEqual([]);
      const foreign = await req(h, `/api/v1/exports/${exported.id}`, {
        cookie: seed.other.admin.cookie,
      });
      expect(foreign.status).toBe(404);
      const notReady = await req(h, `/api/v1/exports/${exported.id}/download`, {
        cookie: seed.admin.cookie,
      });
      expect(notReady.status).toBe(404);
    });

    ctx.itBlob("downloads completed exports via a signed URL", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const created = await req(h, `/api/v1/shares/${fixture.shareId}/export`, {
        cookie: seed.admin.cookie,
        json: { format: "csv" },
      });
      const exported = await json<{ id: string }>(created);
      const blobKey = `exports/${exported.id}/comments.csv`;
      const content = "frame,comment\n7,looks good\n";
      const stream = new Response(new TextEncoder().encode(content).buffer)
        .body;
      if (stream && h.blobStore)
        await h.blobStore.putStream(blobKey, stream, {});
      await h.db
        .update(exportJobs)
        .set({
          status: "complete",
          resultBlobKey: blobKey,
          finishedAt: h.clock.now(),
        })
        .where(eq(exportJobs.id, exported.id))
        .run();
      const download = await req(h, `/api/v1/exports/${exported.id}/download`, {
        cookie: seed.admin.cookie,
      });
      expect(download.status).toBe(200);
      const { url } = await json<{ url: string }>(download);
      const parsed = new URL(url);
      const fetched = await req(h, parsed.pathname + parsed.search, {
        cookie: seed.admin.cookie,
      });
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe(content);
      expect(fetched.headers.get("content-disposition")).toBe(
        'attachment; filename="comments.csv"',
      );
    });
  });
};
