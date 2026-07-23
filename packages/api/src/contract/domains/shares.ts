import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  assetVersions,
  exportJobs,
  notifications,
  projects,
  shares,
} from "@onelight/db/schema";
import {
  assertSnakeCaseKeys,
  cookieFrom,
  errorCode,
  forbiddenKeysIn,
  json,
  req,
  travel,
  wireUrl,
} from "../harness.js";
import type { ContractHarness } from "../harness.js";
import type { SeedState } from "../seed.js";
import {
  createProject,
  grantRole,
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

    it("reorders and removes share assets, manager only", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const second = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: fixture.projectId,
        userId: seed.admin.id,
      });
      await req(h, `/api/v1/shares/${fixture.shareId}/assets`, {
        cookie: seed.admin.cookie,
        json: { asset_ids: [second.assetId] },
      });
      // Reorder must name the exact set.
      const partial = await req(h, `/api/v1/shares/${fixture.shareId}/assets`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { asset_ids: [second.assetId] },
      });
      expect(partial.status).toBe(400);
      const reordered = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/assets`,
        {
          method: "PATCH",
          cookie: seed.admin.cookie,
          json: { asset_ids: [second.assetId, fixture.assetId] },
        },
      );
      expect(reordered.status).toBe(200);
      // The public listing follows the new order.
      const viewer = await accessShare(h, fixture.slug);
      const listed = await json<{ items: Array<{ id: string }> }>(
        await req(h, `/api/v1/s/${fixture.slug}/assets`, {
          cookie: viewer.cookie,
        }),
      );
      expect(listed.items.map((item) => item.id)).toEqual([
        second.assetId,
        fixture.assetId,
      ]);
      // Removal takes one out; a repeat is a 404.
      const removed = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/assets/${second.assetId}`,
        { method: "DELETE", cookie: seed.admin.cookie },
      );
      expect(removed.status).toBe(204);
      const again = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/assets/${second.assetId}`,
        { method: "DELETE", cookie: seed.admin.cookie },
      );
      expect(again.status).toBe(404);
      const after = await json<{ items: Array<{ id: string }> }>(
        await req(h, `/api/v1/s/${fixture.slug}/assets`, {
          cookie: viewer.cookie,
        }),
      );
      expect(after.items.map((item) => item.id)).toEqual([fixture.assetId]);
    });

    ctx.itBlob(
      "carries a logo end to end and survives brand edits",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        const stored = await req(h, `/api/v1/shares/${fixture.shareId}/logo`, {
          method: "PUT",
          cookie: seed.admin.cookie,
          body: "png-logo-bytes",
          headers: { "content-type": "image/png" },
        });
        expect(stored.status).toBe(200);
        // The public bootstrap carries a URL, never the blob key.
        const viewer = await accessShare(h, fixture.slug);
        const shell = await json<{
          share: { logo_url: string | null; brand: unknown };
        }>(
          await req(h, `/api/v1/s/${fixture.slug}`, { cookie: viewer.cookie }),
        );
        expect(shell.share.logo_url).toContain(`/s/${fixture.slug}/logo`);
        expect(JSON.stringify(shell.share.brand ?? {})).not.toContain(
          "logo_key",
        );
        // The logo itself is public: the access prompt draws it pre-viewer.
        const fetched = await req(h, `/api/v1/s/${fixture.slug}/logo`);
        expect(fetched.status).toBe(200);
        expect(await fetched.text()).toBe("png-logo-bytes");
        // Changing the colours must not drop the mark.
        await req(h, `/api/v1/shares/${fixture.shareId}`, {
          method: "PATCH",
          cookie: seed.admin.cookie,
          json: { brand: { palette: "yoai" } },
        });
        const kept = await json<{ share: { logo_url: string | null } }>(
          await req(h, `/api/v1/s/${fixture.slug}`, { cookie: viewer.cookie }),
        );
        expect(kept.share.logo_url).toContain(`/s/${fixture.slug}/logo`);
        // And deletion clears it.
        const cleared = await req(h, `/api/v1/shares/${fixture.shareId}/logo`, {
          method: "DELETE",
          cookie: seed.admin.cookie,
        });
        expect(cleared.status).toBe(204);
        const gone = await req(h, `/api/v1/s/${fixture.slug}/logo`);
        expect(gone.status).toBe(404);
      },
    );

    ctx.itBlob(
      "serves the unfurl poster publicly, except behind a passphrase",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        // No poster yet: nothing to unfurl.
        expect(
          (await req(h, `/api/v1/s/${fixture.slug}/unfurl.png`)).status,
        ).toBe(404);
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "poster",
          content: "unfurl-poster-bytes",
        });
        const served = await req(h, `/api/v1/s/${fixture.slug}/unfurl.png`);
        expect(served.status).toBe(200);
        expect(await served.text()).toBe("unfurl-poster-bytes");
        // A protected share unfurls without a picture.
        const locked = await makeShare(h, seed, { passphrase: "sesame-99" });
        await seedRendition(h, { versionId: locked.versionId, kind: "poster" });
        expect(
          (await req(h, `/api/v1/s/${locked.slug}/unfurl.png`)).status,
        ).toBe(404);
      },
    );

    it("marks a viewer's own comments as mine, and only theirs", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const author = await accessShare(h, fixture.slug, { name: "Author" });
      const posted = await json<{ id: string }>(
        await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
          {
            cookie: author.cookie,
            json: { body_text: "mine to edit" },
            headers: { "x-forwarded-for": uniqueIp() },
          },
        ),
      );
      const listedFor = async (
        cookie: string,
      ): Promise<boolean | undefined> => {
        const body = await json<{
          items: Array<{ id: string; mine?: boolean }>;
        }>(
          await req(
            h,
            `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
            { cookie },
          ),
        );
        return body.items.find((item) => item.id === posted.id)?.mine;
      };
      expect(await listedFor(author.cookie)).toBe(true);
      const other = await accessShare(h, fixture.slug, { name: "Reader" });
      expect(await listedFor(other.cookie)).toBe(false);
    });

    it("carries the running time once the current version is probed", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const listed = async (): Promise<Record<string, unknown>> => {
        const response = await req(h, `/api/v1/s/${fixture.slug}/assets`, {
          cookie: viewer.cookie,
        });
        expect(response.status).toBe(200);
        const body = await json<{ items: Array<Record<string, unknown>> }>(
          response,
        );
        return body.items[0] as Record<string, unknown>;
      };
      // Unprobed media has no length to report: null, never a guess.
      expect((await listed()).duration_seconds).toBeNull();
      await h.db
        .update(assetVersions)
        .set({
          mediaInfoJson: JSON.stringify({
            durationFrames: 240,
            frameRateNum: 24000,
            frameRateDen: 1001,
          }),
        })
        .where(eq(assetVersions.id, fixture.versionId))
        .run();
      const probed = (await listed()).duration_seconds;
      expect(typeof probed).toBe("number");
      expect(probed).toBeCloseTo((240 * 1001) / 24000, 5);
    });

    ctx.itBlob(
      "lets a viewer attach files to their own note and every viewer read them",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        const author = await accessShare(h, fixture.slug, { name: "Author" });
        const posted = await json<{ id: string }>(
          await req(
            h,
            `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
            {
              cookie: author.cookie,
              json: { body_text: "note with a file" },
              headers: { "x-forwarded-for": uniqueIp() },
            },
          ),
        );
        const boundary = "----onelightsharefile";
        const body = [
          `--${boundary}`,
          'content-disposition: form-data; name="file"; filename="grade notes.pdf"',
          "content-type: application/pdf",
          "",
          "fake-pdf-bytes",
          `--${boundary}--`,
          "",
        ].join("\r\n");
        const storageBefore = (
          await h.db
            .select({ bytes: projects.storageBytes })
            .from(projects)
            .where(eq(projects.id, fixture.projectId))
            .all()
        )[0]?.bytes;
        const uploaded = await req(
          h,
          `/api/v1/s/${fixture.slug}/comments/${posted.id}/attachments`,
          {
            method: "POST",
            cookie: author.cookie,
            body,
            headers: {
              "content-type": `multipart/form-data; boundary=${boundary}`,
              "content-length": String(new TextEncoder().encode(body).length),
            },
          },
        );
        expect(uploaded.status).toBe(201);
        const attachment = await json<{ id: string; filename: string }>(
          uploaded,
        );
        expect(attachment.filename).toBe("grade notes.pdf");
        const storageAfterUpload = (
          await h.db
            .select({ bytes: projects.storageBytes })
            .from(projects)
            .where(eq(projects.id, fixture.projectId))
            .all()
        )[0]?.bytes;
        expect(storageAfterUpload).toBe(
          (storageBefore ?? 0) +
            new TextEncoder().encode("fake-pdf-bytes").byteLength,
        );
        // The list carries it, for every viewer.
        const other = await accessShare(h, fixture.slug, { name: "Reader" });
        const listed = await json<{
          items: Array<{ id: string; attachments: Array<{ id: string }> }>;
        }>(
          await req(
            h,
            `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
            { cookie: other.cookie },
          ),
        );
        const row = listed.items.find((entry) => entry.id === posted.id);
        expect(row?.attachments.map((entry) => entry.id)).toEqual([
          attachment.id,
        ]);
        // And the file itself serves through the share-scoped URL.
        const issued = await json<{ url: string }>(
          await req(
            h,
            `/api/v1/s/${fixture.slug}/comments/${posted.id}/attachments/${attachment.id}`,
            { cookie: other.cookie },
          ),
        );
        const parsed = wireUrl(issued.url);
        const fetched = await req(h, parsed.pathname + parsed.search);
        expect(fetched.status).toBe(200);
        expect(await fetched.text()).toBe("fake-pdf-bytes");
        // A different viewer cannot attach to someone else's note.
        const denied = await req(
          h,
          `/api/v1/s/${fixture.slug}/comments/${posted.id}/attachments`,
          {
            method: "POST",
            cookie: other.cookie,
            body,
            headers: {
              "content-type": `multipart/form-data; boundary=${boundary}`,
              "content-length": String(new TextEncoder().encode(body).length),
            },
          },
        );
        expect(denied.status).toBe(403);
        // The internal list sees the same attachment.
        const internal = await json<{
          items: Array<{ id: string; attachments?: Array<{ id: string }> }>;
        }>(
          await req(h, `/api/v1/versions/${fixture.versionId}/comments`, {
            cookie: seed.admin.cookie,
          }),
        );
        const internalRow = internal.items.find(
          (entry) => entry.id === posted.id,
        );
        expect(internalRow?.attachments?.map((entry) => entry.id)).toEqual([
          attachment.id,
        ]);
        const deniedDelete = await req(
          h,
          `/api/v1/s/${fixture.slug}/comments/${posted.id}/attachments/${attachment.id}`,
          { method: "DELETE", cookie: other.cookie },
        );
        expect(deniedDelete.status).toBe(403);
        const removed = await req(
          h,
          `/api/v1/s/${fixture.slug}/comments/${posted.id}/attachments/${attachment.id}`,
          { method: "DELETE", cookie: author.cookie },
        );
        expect(removed.status).toBe(204);
        const storageAfterDelete = (
          await h.db
            .select({ bytes: projects.storageBytes })
            .from(projects)
            .where(eq(projects.id, fixture.projectId))
            .all()
        )[0]?.bytes;
        expect(storageAfterDelete).toBe(storageBefore);
      },
    );

    it("round-trips the brand to the public wire and rejects junk", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const brand = {
        palette: "yoai",
        colors: ["#16283a", "#e7dfc8"],
        player: "simple",
      };
      const patched = await req(h, `/api/v1/shares/${fixture.shareId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { brand },
      });
      expect(patched.status).toBe(200);
      expect((await json<{ brand: unknown }>(patched)).brand).toEqual(brand);
      // The viewer's page reads it from the public bootstrap.
      const viewer = await accessShare(h, fixture.slug);
      const shell = await json<{ share: { brand: unknown } }>(
        await req(h, `/api/v1/s/${fixture.slug}`, { cookie: viewer.cookie }),
      );
      expect(shell.share.brand).toEqual(brand);
      // Junk shapes never reach the row: a wash is two hex colours or a
      // library palette, not arbitrary JSON.
      const rejected = await req(h, `/api/v1/shares/${fixture.shareId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { brand: { colors: ["red", "blue"] } },
      });
      expect(rejected.status).toBe(400);
      // Explicit null clears it.
      const cleared = await req(h, `/api/v1/shares/${fixture.shareId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { brand: null },
      });
      expect((await json<{ brand: unknown }>(cleared)).brand).toBeNull();
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

    it("keeps server-only share and viewer fields off the public wire", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed, {
        passphrase: "open-sesame-1",
        watermark_spec: { text: "CONFIDENTIAL", position: "center" },
      });
      const access = await req(h, `/api/v1/s/${fixture.slug}/access`, {
        json: { name: "Client Ten", passphrase: "open-sesame-1" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(access.status).toBe(200);
      const accessBody = await json<{
        share: Record<string, unknown>;
        viewer_key: string;
      }>(access);
      // The access response carries the viewer's own key by design, but the
      // share projection is the public shape: watermarking as a boolean.
      expect(accessBody.viewer_key).toBeTruthy();
      expect(accessBody.share.watermark).toBe(true);
      expect(accessBody.share).not.toHaveProperty("watermark_spec");
      expect(accessBody.share).not.toHaveProperty("watermark_spec_hash");
      expect(accessBody.share).not.toHaveProperty("passphrase_hash");
      expect(accessBody.share).not.toHaveProperty("created_by");
      expect(assertSnakeCaseKeys(accessBody.share)).toEqual([]);
      const cookie = cookieFrom(access);
      const shown = await req(h, `/api/v1/s/${fixture.slug}`, { cookie });
      expect(shown.status).toBe(200);
      const body = await json<{
        share: Record<string, unknown>;
        viewer: Record<string, unknown> | null;
        assets: unknown[];
      }>(shown);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(
        forbiddenKeysIn(body, [
          "passphrase_hash",
          "watermark_spec_hash",
          "watermark_spec",
          "viewer_key",
          "created_by",
        ]),
      ).toEqual([]);
      expect(body.share).not.toHaveProperty("passphrase_hash");
      expect(body.share).not.toHaveProperty("watermark_spec_hash");
      expect(body.share.watermark).toBe(true);
      // The viewer projection carries display identity only.
      expect(body.viewer).not.toBeNull();
      expect(Object.keys(body.viewer ?? {}).sort()).toEqual([
        "email",
        "id",
        "name",
      ]);
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
      // Public share comments never expose the registered author identity:
      // author_email and author_user_id are dropped, author_name is kept.
      expect(listed.items[0]).not.toHaveProperty("author_email");
      expect(listed.items[0]).not.toHaveProperty("author_user_id");
      expect(listed.items[0]).toHaveProperty("author_name");
      expect(
        forbiddenKeysIn(listed, [
          "viewer_key",
          "author_email",
          "author_user_id",
        ]),
      ).toEqual([]);
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

    ctx.itBlob(
      "serves registered comment avatars through the share without exposing user ids",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        const avatar = await req(h, "/api/v1/users/me/avatar", {
          method: "PUT",
          cookie: seed.admin.cookie,
          body: "registered-avatar-bytes",
          headers: { "content-type": "image/png" },
        });
        expect(avatar.status).toBe(200);
        const created = await req(
          h,
          `/api/v1/versions/${fixture.versionId}/comments`,
          {
            cookie: seed.admin.cookie,
            json: { body_text: "registered reviewer", internal: false },
          },
        );
        expect(created.status).toBe(201);
        const comment = await json<{ id: string }>(created);
        const viewer = await accessShare(h, fixture.slug);
        const listed = await json<{
          items: Array<{
            id: string;
            author_avatar_url: string | null;
            author_user_id?: string;
            author_email?: string;
          }>;
        }>(
          await req(
            h,
            `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/comments`,
            { cookie: viewer.cookie },
          ),
        );
        const publicComment = listed.items.find(
          (candidate) => candidate.id === comment.id,
        );
        expect(publicComment?.author_avatar_url).toBe(
          `/api/v1/s/${fixture.slug}/comments/${comment.id}/avatar`,
        );
        expect(publicComment?.author_user_id).toBeUndefined();
        expect(publicComment?.author_email).toBeUndefined();
        const anonymous = await req(h, publicComment?.author_avatar_url ?? "");
        expect(anonymous.status).toBe(401);
        const fetched = await req(h, publicComment?.author_avatar_url ?? "", {
          cookie: viewer.cookie,
        });
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get("content-type")).toBe("image/png");
        expect(await fetched.text()).toBe("registered-avatar-bytes");
      },
    );

    it("records share playback diagnostics without asking the viewer for logs", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/playback-diagnostics`,
          {
            method: "POST",
            cookie: viewer.cookie,
            origin: true,
            headers: { "user-agent": "Remote Reviewer Browser" },
            json: {
              reason: "play_rejected",
              rate: 4,
              main_ready_state: 4,
              main_network_state: 1,
              main_playback_rate: 4,
              main_current_time: 20,
              main_paused: false,
              main_muted: false,
              main_volume: 1,
              sidecar_ready_state: 0,
              sidecar_network_state: 3,
              sidecar_current_time: 0,
              sidecar_duration: null,
              sidecar_paused: true,
              sidecar_muted: false,
              sidecar_volume: 1,
              sidecar_source_present: true,
              sidecar_media_error: 4,
              document_visibility: "visible",
              online: true,
              failure: "MEDIA_ERR_SRC_NOT_SUPPORTED",
            },
          },
        );
        expect(response.status).toBe(204);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("Remote Reviewer Browser"),
        );
        const record = JSON.parse(
          String(warning.mock.calls[0]?.[0]).slice(
            "[onelight-playback-diagnostic] ".length,
          ),
        ) as Record<string, unknown>;
        expect(record).toMatchObject({
          scope: "share",
          share_id: fixture.shareId,
          asset_id: fixture.assetId,
          reason: "play_rejected",
          sidecar_source_present: true,
          failure: "MEDIA_ERR_SRC_NOT_SUPPORTED",
        });
        expect(record.request_id).toEqual(expect.any(String));
        expect(JSON.stringify(record)).not.toContain(fixture.slug);
        const anonymous = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/playback-diagnostics`,
          {
            method: "POST",
            origin: true,
            json: {
              reason: "source_missing",
              rate: 2,
              main_ready_state: null,
              main_network_state: null,
              main_playback_rate: null,
              main_current_time: null,
              main_paused: null,
              main_muted: null,
              sidecar_ready_state: null,
              sidecar_network_state: null,
              sidecar_current_time: null,
              sidecar_paused: null,
              sidecar_media_error: null,
              failure: null,
            },
          },
        );
        expect(anonymous.status).toBe(401);
      } finally {
        warning.mockRestore();
      }
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
      const approvalNotifications = await h.db
        .select()
        .from(notifications)
        .where(eq(notifications.kind, "approval.updated"))
        .all();
      const repeated = await req(h, `/api/v1/s/${fixture.slug}/approval`, {
        method: "PATCH",
        cookie: viewer.cookie,
        origin: true,
        json: { asset_id: fixture.assetId, status: "approved" },
      });
      expect(repeated.status).toBe(200);
      expect(
        await h.db
          .select()
          .from(notifications)
          .where(eq(notifications.kind, "approval.updated"))
          .all(),
      ).toHaveLength(approvalNotifications.length);
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
        const parsed = wireUrl(url);
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

    ctx.itBlob(
      "carries a working poster url on both share asset listings",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        const viewer = await accessShare(h, fixture.slug);
        const listed = async (
          path: string,
        ): Promise<Record<string, unknown>> => {
          const response = await req(h, path, { cookie: viewer.cookie });
          expect(response.status).toBe(200);
          const body = await json<{
            items?: Array<Record<string, unknown>>;
            assets?: Array<Record<string, unknown>>;
          }>(response);
          const items = body.items ?? body.assets ?? [];
          expect(items).toHaveLength(1);
          return items[0] as Record<string, unknown>;
        };
        // A share whose poster has not been produced yet is a normal state,
        // and the client falls back to a text tile: null, never a broken URL.
        expect(await listed(`/api/v1/s/${fixture.slug}/assets`)).toMatchObject({
          poster_url: null,
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "poster",
          content: "poster-png-bytes",
        });
        // The bootstrap and the list are one projection: both carry it, and
        // the URL it carries is the thumbnail, not merely a string.
        for (const path of [
          `/api/v1/s/${fixture.slug}/assets`,
          `/api/v1/s/${fixture.slug}`,
        ]) {
          const item = await listed(path);
          const posterUrl = item.poster_url;
          expect(typeof posterUrl).toBe("string");
          const parsed = wireUrl(posterUrl as string);
          const fetched = await req(h, parsed.pathname + parsed.search);
          expect(fetched.status).toBe(200);
          expect(await fetched.text()).toBe("poster-png-bytes");
          const unsigned = await req(h, parsed.pathname);
          expect(unsigned.status).toBe(401);
        }
      },
    );
  });

  describe("share watermarking", () => {
    const specHashOf = async (
      h: ContractHarness,
      shareId: string,
    ): Promise<string> => {
      const row = (
        await h.db
          .select({ hash: shares.watermarkSpecHash })
          .from(shares)
          .where(eq(shares.id, shareId))
          .limit(1)
          .all()
      )[0];
      const hash = row?.hash;
      if (!hash) throw new Error("Share has no watermark spec hash.");
      return hash;
    };

    const fetchUrl = async (h: ContractHarness, url: string) => {
      const parsed = wireUrl(url);
      return req(h, parsed.pathname + parsed.search);
    };

    ctx.itBlob(
      "serves only the matching watermarked rendition and 202s while pending",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed, {
          watermark_spec: { text: "CONFIDENTIAL", position: "center" },
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          content: "clean-proxy-bytes",
        });
        const viewer = await accessShare(h, fixture.slug);
        // The clean proxy exists, but the watermarked share must not serve
        // it: pending means 202, never a fallback.
        const pending = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/media`,
          { cookie: viewer.cookie },
        );
        expect(pending.status).toBe(202);
        expect(await json(pending)).toEqual({ status: "processing" });
        const hash = await specHashOf(h, fixture.shareId);
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "watermarked",
          shareId: fixture.shareId,
          meta: { spec_hash: hash },
          content: "burned-bytes",
        });
        const ready = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/media`,
          { cookie: viewer.cookie },
        );
        expect(ready.status).toBe(200);
        const { url } = await json<{ url: string }>(ready);
        const fetched = await fetchUrl(h, url);
        expect(fetched.status).toBe(200);
        expect(await fetched.text()).toBe("burned-bytes");
        // A spec change invalidates the old hash: the stale rendition is no
        // longer served even before the worker cleans it up.
        const patched = await req(h, `/api/v1/shares/${fixture.shareId}`, {
          method: "PATCH",
          cookie: seed.admin.cookie,
          json: { watermark_spec: { text: "NEW SPEC", position: "center" } },
        });
        expect(patched.status).toBe(200);
        const stale = await req(
          h,
          `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/media`,
          { cookie: viewer.cookie },
        );
        expect(stale.status).toBe(202);
        // An unwatermarked share is unaffected and still serves the proxy.
        const plain = await makeShare(h, seed);
        await seedRendition(h, {
          versionId: plain.versionId,
          content: "plain-proxy-bytes",
        });
        const plainViewer = await accessShare(h, plain.slug);
        const plainMedia = await req(
          h,
          `/api/v1/s/${plain.slug}/assets/${plain.assetId}/media`,
          { cookie: plainViewer.cookie },
        );
        expect(plainMedia.status).toBe(200);
        const plainFetched = await fetchUrl(
          h,
          (await json<{ url: string }>(plainMedia)).url,
        );
        expect(await plainFetched.text()).toBe("plain-proxy-bytes");
      },
    );

    ctx.itBlob(
      "exposes the source ladder and sidecars on the share asset detail",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed);
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "proxy_540",
          meta: { height: 540 },
          content: "p540",
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "proxy_1080",
          meta: { height: 1080 },
          content: "p1080",
        });
        const vttKey = `renditions/${fixture.versionId}/sprite.vtt`;
        const vttBody = new Response(
          new TextEncoder().encode("WEBVTT\n").buffer,
        ).body;
        if (vttBody && h.blobStore)
          await h.blobStore.putStream(vttKey, vttBody, {});
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "sprite",
          meta: { vtt_blob_key: vttKey },
          content: "sprite-bytes",
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "audio_peaks",
          content: "peaks-bytes",
        });
        const viewer = await accessShare(h, fixture.slug);
        const detail = await json<{
          versions: Array<{
            sources: Array<{
              kind: string;
              url: string;
              size: number;
              height: number | null;
            }>;
            sidecars: {
              sprite: { url: string; vtt_url: string | null } | null;
              peaks: { url: string } | null;
            };
            watermark: string | null;
          }>;
        }>(
          await req(h, `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}`, {
            cookie: viewer.cookie,
          }),
        );
        const version = detail.versions[0];
        expect(version).toBeDefined();
        if (!version) return;
        expect(version.watermark).toBeNull();
        const kinds = version.sources.map((source) => source.kind).sort();
        expect(kinds).toEqual(["proxy_1080", "proxy_540"]);
        const p540 = version.sources.find(
          (source) => source.kind === "proxy_540",
        );
        expect(p540?.height).toBe(540);
        const played = await fetchUrl(h, p540?.url ?? "");
        expect(played.status).toBe(200);
        expect(await played.text()).toBe("p540");
        expect(version.sidecars.sprite).not.toBeNull();
        expect(version.sidecars.sprite?.vtt_url).toBeTruthy();
        const vtt = await fetchUrl(h, version.sidecars.sprite?.vtt_url ?? "");
        expect(await vtt.text()).toBe("WEBVTT\n");
        expect(version.sidecars.peaks).not.toBeNull();
        const peaks = await fetchUrl(h, version.sidecars.peaks?.url ?? "");
        expect(await peaks.text()).toBe("peaks-bytes");
      },
    );

    ctx.itBlob(
      "filters the detail ladder to the burned rendition on watermarked shares",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed, {
          watermark_spec: { text: "WM LADDER" },
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "proxy_540",
          content: "clean540",
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "proxy_1080",
          content: "clean1080",
        });
        const viewer = await accessShare(h, fixture.slug);
        const detailPath = `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}`;
        const pending = await json<{
          versions: Array<{ sources: unknown[]; watermark: string | null }>;
        }>(await req(h, detailPath, { cookie: viewer.cookie }));
        expect(pending.versions[0]?.watermark).toBe("processing");
        expect(pending.versions[0]?.sources).toEqual([]);
        const hash = await specHashOf(h, fixture.shareId);
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "watermarked",
          shareId: fixture.shareId,
          meta: { spec_hash: hash },
          content: "burned-ladder",
        });
        const ready = await json<{
          versions: Array<{
            sources: Array<{ kind: string; url: string }>;
            watermark: string | null;
          }>;
        }>(await req(h, detailPath, { cookie: viewer.cookie }));
        expect(ready.versions[0]?.watermark).toBe("ready");
        const sources = ready.versions[0]?.sources ?? [];
        expect(sources.map((source) => source.kind)).toEqual(["watermarked"]);
        const fetched = await fetchUrl(h, sources[0]?.url ?? "");
        expect(await fetched.text()).toBe("burned-ladder");
      },
    );
  });

  describe("share downloads", () => {
    it("refuses downloads when allow_download is none", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const viewer = await accessShare(h, fixture.slug);
      const denied = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/download`,
        { cookie: viewer.cookie },
      );
      expect(denied.status).toBe(403);
      const anonymous = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/download`,
      );
      expect(anonymous.status).toBe(401);
    });

    ctx.itBlob("signs the 1080p proxy for allow_download proxy", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed, { allow_download: "proxy" });
      await seedRendition(h, {
        versionId: fixture.versionId,
        content: "downloadable-proxy",
      });
      const viewer = await accessShare(h, fixture.slug);
      const issued = await req(
        h,
        `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/download`,
        { cookie: viewer.cookie },
      );
      expect(issued.status).toBe(200);
      const { url } = await json<{ url: string }>(issued);
      const parsed = wireUrl(url);
      const fetched = await req(h, parsed.pathname + parsed.search);
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe("downloadable-proxy");
      const disposition = fetched.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).toContain("-proxy.mp4");
    });

    ctx.itBlob(
      "serves the original blob with its filename for allow_download original",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const project = await createProject(h, seed.admin);
        const media = await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          name: "conform-master",
        });
        const originalBody = new Response(
          new TextEncoder().encode("original-camera-bytes").buffer,
        ).body;
        if (originalBody && h.blobStore)
          await h.blobStore.putStream(media.blobKey, originalBody, {});
        const created = await req(h, "/api/v1/shares", {
          cookie: seed.admin.cookie,
          json: {
            project_id: project.id,
            title: unique("Original Download"),
            asset_ids: [media.assetId],
            allow_download: "original",
          },
        });
        expect(created.status).toBe(201);
        const share = (await json<{ share: { slug: string } }>(created)).share;
        const viewer = await accessShare(h, share.slug);
        const issued = await req(
          h,
          `/api/v1/s/${share.slug}/assets/${media.assetId}/download`,
          { cookie: viewer.cookie },
        );
        expect(issued.status).toBe(200);
        const { url } = await json<{ url: string }>(issued);
        const parsed = wireUrl(url);
        const fetched = await req(h, parsed.pathname + parsed.search);
        expect(fetched.status).toBe(200);
        expect(await fetched.text()).toBe("original-camera-bytes");
        expect(fetched.headers.get("content-disposition")).toBe(
          'attachment; filename="conform-master.mp4"',
        );
      },
    );

    ctx.itBlob(
      "never hands the clean file to a watermarked share, even for original",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makeShare(h, seed, {
          allow_download: "original",
          watermark_spec: { text: "NO CLEAN FILES" },
        });
        await seedRendition(h, {
          versionId: fixture.versionId,
          content: "clean-proxy",
        });
        const viewer = await accessShare(h, fixture.slug);
        const downloadPath = `/api/v1/s/${fixture.slug}/assets/${fixture.assetId}/download`;
        const pending = await req(h, downloadPath, { cookie: viewer.cookie });
        expect(pending.status).toBe(202);
        expect(await json(pending)).toEqual({ status: "processing" });
        const hash = (
          await h.db
            .select({ hash: shares.watermarkSpecHash })
            .from(shares)
            .where(eq(shares.id, fixture.shareId))
            .limit(1)
            .all()
        )[0]?.hash;
        await seedRendition(h, {
          versionId: fixture.versionId,
          kind: "watermarked",
          shareId: fixture.shareId,
          meta: { spec_hash: hash },
          content: "burned-download",
        });
        const issued = await req(h, downloadPath, { cookie: viewer.cookie });
        expect(issued.status).toBe(200);
        const { url } = await json<{ url: string }>(issued);
        const parsed = wireUrl(url);
        const fetched = await req(h, parsed.pathname + parsed.search);
        expect(await fetched.text()).toBe("burned-download");
        expect(fetched.headers.get("content-disposition")).toContain(
          "-watermarked.mp4",
        );
      },
    );

    /* Signed media URLs come back absolute; the harness speaks paths. */
    const followUrl = async (h: ContractHarness, url: string) => {
      const parsed = wireUrl(url);
      return req(h, parsed.pathname + parsed.search);
    };

    /* Audio and stills are first-class media in a share room, not links to
       files. Each has its own review rendition, and every place that used to
       ask for "the 1080 proxy" has to ask for the right one instead. */
    ctx.itBlob(
      "serves an audio asset its own proxy and both audio sidecars",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const project = await createProject(h, seed.admin);
        const media = await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          kind: "audio",
        });
        const created = await req(h, "/api/v1/shares", {
          cookie: seed.admin.cookie,
          json: {
            project_id: project.id,
            title: unique("Mix review"),
            asset_ids: [media.assetId],
          },
        });
        const { share } = await json<{ share: { slug: string } }>(created);
        await seedRendition(h, {
          versionId: media.versionId,
          kind: "proxy_audio",
          content: "aac-proxy",
        });
        await seedRendition(h, {
          versionId: media.versionId,
          kind: "waveform_data",
          meta: { channels: 2, points: 1200 },
          content: "peak-data",
        });
        await seedRendition(h, {
          versionId: media.versionId,
          kind: "spectrogram",
          content: "spectrogram-png",
        });
        await seedRendition(h, {
          versionId: media.versionId,
          kind: "shuttle_audio_2x",
          content: "twice-speed-audio",
        });
        await seedRendition(h, {
          versionId: media.versionId,
          kind: "shuttle_audio_4x",
          content: "four-times-audio",
        });
        const viewer = await accessShare(h, share.slug);
        const detail = await json<{
          versions: Array<{
            sources: Array<{ kind: string; url: string }>;
            sidecars: {
              waveform: { url: string; meta: Record<string, unknown> } | null;
              spectrogram: { url: string } | null;
              shuttle_audio: { x2: string | null; x4: string | null };
            };
          }>;
        }>(
          await req(h, `/api/v1/s/${share.slug}/assets/${media.assetId}`, {
            cookie: viewer.cookie,
          }),
        );
        const version = detail.versions[0];
        expect(version?.sources.map((source) => source.kind)).toEqual([
          "proxy_audio",
        ]);
        expect(version?.sidecars.waveform?.meta).toMatchObject({
          channels: 2,
          points: 1200,
        });
        const peaks = await followUrl(h, version?.sidecars.waveform?.url ?? "");
        expect(await peaks.text()).toBe("peak-data");
        const spectrogram = await followUrl(
          h,
          version?.sidecars.spectrogram?.url ?? "",
        );
        expect(await spectrogram.text()).toBe("spectrogram-png");
        const twice = await followUrl(
          h,
          version?.sidecars.shuttle_audio.x2 ?? "",
        );
        expect(await twice.text()).toBe("twice-speed-audio");
        const fourTimes = await followUrl(
          h,
          version?.sidecars.shuttle_audio.x4 ?? "",
        );
        expect(await fourTimes.text()).toBe("four-times-audio");
        /* The media endpoint the room actually plays from: an audio asset
           must never be handed a still, and must not 404 for want of a
           video proxy. */
        const played = await json<{ url: string }>(
          await req(
            h,
            `/api/v1/s/${share.slug}/assets/${media.assetId}/media`,
            { cookie: viewer.cookie },
          ),
        );
        const playedBytes = await followUrl(h, played.url);
        expect(await playedBytes.text()).toBe("aac-proxy");
      },
    );

    ctx.itBlob(
      "downloads the audio proxy as m4a and a still as its original",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const project = await createProject(h, seed.admin);
        const song = await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          kind: "audio",
        });
        const still = await seedAssetVersion(h, {
          workspaceId: seed.workspaceId,
          projectId: project.id,
          userId: seed.admin.id,
          kind: "image",
        });
        const stillBody = new Response(
          new TextEncoder().encode("the-still-itself").buffer,
        ).body;
        if (stillBody && h.blobStore)
          await h.blobStore.putStream(still.blobKey, stillBody, {});
        const created = await req(h, "/api/v1/shares", {
          cookie: seed.admin.cookie,
          json: {
            project_id: project.id,
            title: unique("Proxy only"),
            asset_ids: [song.assetId, still.assetId],
            allow_download: "proxy",
          },
        });
        const { share } = await json<{ share: { slug: string } }>(created);
        await seedRendition(h, {
          versionId: song.versionId,
          kind: "proxy_audio",
          content: "aac-proxy",
        });
        const viewer = await accessShare(h, share.slug);
        const audio = await json<{ url: string }>(
          await req(
            h,
            `/api/v1/s/${share.slug}/assets/${song.assetId}/download`,
            { cookie: viewer.cookie },
          ),
        );
        const audioFile = await followUrl(h, audio.url);
        expect(await audioFile.text()).toBe("aac-proxy");
        /* An audio proxy saved as .mp4 opens in a video player and looks
           broken; the suffix has to match what is inside. */
        expect(audioFile.headers.get("content-disposition")).toContain(
          "-proxy.m4a",
        );
        /* A still has no lesser form, so a proxy-only share hands out the
           original rather than answering "not ready" forever. */
        const image = await req(
          h,
          `/api/v1/s/${share.slug}/assets/${still.assetId}/download`,
          { cookie: viewer.cookie },
        );
        expect(image.status).toBe(200);
        const imageFile = await followUrl(
          h,
          (await json<{ url: string }>(image)).url,
        );
        expect(imageFile.status).toBe(200);
        expect(await imageFile.text()).toBe("the-still-itself");
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
      const unknownFilter = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/export`,
        {
          cookie: seed.admin.cookie,
          json: {
            format: "csv",
            filters: { share_id: "caller-controlled" },
          },
        },
      );
      expect(unknownFilter.status).toBe(400);
      const missingShare = await req(
        h,
        "/api/v1/shares/01ARZ3NDEKTSV4RRFFQ69G5FAV/export",
        { cookie: seed.admin.cookie, json: { format: "csv" } },
      );
      expect(missingShare.status).toBe(404);
    });

    it("binds share exports to the share's own asset set", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      const created = await req(h, `/api/v1/shares/${fixture.shareId}/export`, {
        cookie: seed.admin.cookie,
        json: { format: "csv", filters: { completed: false } },
      });
      expect(created.status).toBe(202);
      const exported = await json<{ id: string }>(created);
      const row = (
        await h.db
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.id, exported.id))
          .limit(1)
          .all()
      )[0];
      expect(JSON.parse(row?.filtersJson ?? "{}")).toEqual({
        completed: false,
        share_id: fixture.shareId,
        internal: false,
      });
    });

    it("queues project-scoped exports without a share", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(
        h,
        `/api/v1/projects/${seed.project.id}/export`,
        {
          cookie: seed.admin.cookie,
          json: { format: "resolve_edl" },
        },
      );
      expect(created.status).toBe(202);
      const exported = await json<{ id: string; status: string }>(created);
      expect(exported.status).toBe("queued");
      const status = await req(h, `/api/v1/exports/${exported.id}`, {
        cookie: seed.admin.cookie,
      });
      expect(status.status).toBe(200);
      const foreign = await req(
        h,
        `/api/v1/projects/${seed.project.id}/export`,
        { cookie: seed.other.admin.cookie, json: { format: "csv" } },
      );
      expect(foreign.status).toBe(404);
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
      const parsed = wireUrl(url);
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

  describe("share viewers", () => {
    it("lists viewers to the owner and project managers only, never the viewer key", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeShare(h, seed);
      await grantRole(
        h,
        seed.admin,
        fixture.projectId,
        seed.manager.id,
        "manager",
      );
      const first = await accessShare(h, fixture.slug, {
        name: "Viewer One",
        email: "viewer.one@example.com",
      });
      expect(first.response.status).toBe(200);
      const second = await accessShare(h, fixture.slug, { name: "Viewer Two" });
      expect(second.response.status).toBe(200);
      // Owner (the admin created the share) sees the roster.
      const owned = await req(h, `/api/v1/shares/${fixture.shareId}/viewers`, {
        cookie: seed.admin.cookie,
      });
      expect(owned.status).toBe(200);
      const body = await json<{
        items: Array<{
          id: string;
          name: string | null;
          email: string | null;
          first_seen_at: number;
          last_seen_at: number;
          user_agent: string | null;
        }>;
      }>(owned);
      expect(body.items).toHaveLength(2);
      expect(body.items.map((item) => item.name).sort()).toEqual([
        "Viewer One",
        "Viewer Two",
      ]);
      expect(body.items.find((item) => item.name === "Viewer One")?.email).toBe(
        "viewer.one@example.com",
      );
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(forbiddenKeysIn(body, ["viewer_key"])).toEqual([]);
      // A project manager who is not the owner sees it too.
      const managed = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/viewers`,
        { cookie: seed.manager.cookie },
      );
      expect(managed.status).toBe(200);
      // A plain workspace member (default viewer role) is forbidden.
      const denied = await req(h, `/api/v1/shares/${fixture.shareId}/viewers`, {
        cookie: seed.editor.cookie,
      });
      expect(denied.status).toBe(403);
      // Cross-workspace callers get 404, and unknown ids 404.
      const foreign = await req(
        h,
        `/api/v1/shares/${fixture.shareId}/viewers`,
        { cookie: seed.other.admin.cookie },
      );
      expect(foreign.status).toBe(404);
      const missing = await req(
        h,
        "/api/v1/shares/01ARZ3NDEKTSV4RRFFQ69G5FAV/viewers",
        { cookie: seed.admin.cookie },
      );
      expect(missing.status).toBe(404);
    });
  });
};
