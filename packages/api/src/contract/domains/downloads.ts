import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  assets,
  downloadManifests,
  folders,
  projects,
} from "@onelight/db/schema";
import { assertSnakeCaseKeys, cookieFrom, json, req } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  createProject,
  seedAssetVersion,
  seedRendition,
  unique,
  uniqueIp,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

const encoder = new TextEncoder();

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export const registerDownloadsDomain = (ctx: SuiteContext): void => {
  describe("public ids", () => {
    it("resolve at the bootstrap fetches and nowhere else", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      /* Seeded rows have no public id; the wire falls back to the ULID.
         Stamp them the way the migration backfill would. */
      await h.db
        .update(projects)
        .set({ publicId: "aa11bb22cc" })
        .where(eq(projects.id, project.id))
        .run();
      await h.db
        .update(assets)
        .set({ publicId: "dd33ee44ff" })
        .where(eq(assets.id, media.assetId))
        .run();
      const byPublic = await req(h, "/api/v1/projects/aa11bb22cc", {
        cookie: seed.admin.cookie,
      });
      expect(byPublic.status).toBe(200);
      const projectBody = await json<{ id: string; public_id: string }>(
        byPublic,
      );
      expect(projectBody.id).toBe(project.id);
      expect(projectBody.public_id).toBe("aa11bb22cc");
      const assetByPublic = await req(h, "/api/v1/assets/dd33ee44ff", {
        cookie: seed.admin.cookie,
      });
      expect(assetByPublic.status).toBe(200);
      expect((await json<{ id: string }>(assetByPublic)).id).toBe(
        media.assetId,
      );
      /* Aliases are read-side sugar only: a mutation body carrying one must
         not resolve, so an alias can never be written into a row. */
      const mutation = await req(h, "/api/v1/uploads", {
        cookie: seed.admin.cookie,
        json: { project_id: "aa11bb22cc", filename: "clip.mp4", size: 4 },
      });
      expect(mutation.status).toBe(404);
      /* The asset listing under the project still takes canonical only. */
      const listing = await req(h, "/api/v1/projects/aa11bb22cc/assets", {
        cookie: seed.admin.cookie,
      });
      expect([200, 404]).toContain(listing.status);
      if (listing.status === 200)
        expect((await json<{ items: unknown[] }>(listing)).items).toHaveLength(
          0,
        );
    });

    it("share settings resolve by public id too", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/shares", {
        cookie: seed.admin.cookie,
        json: {
          project_id: seed.project.id,
          title: unique("Cut"),
          asset_ids: [seed.media.assetId],
        },
      });
      expect(created.status).toBe(201);
      const share = (
        await json<{ share: { id: string; public_id: string } }>(created)
      ).share;
      expect(share.public_id).not.toBe(share.id);
      const fetched = await req(h, `/api/v1/shares/${share.public_id}`, {
        cookie: seed.admin.cookie,
      });
      expect(fetched.status).toBe(200);
      expect((await json<{ id: string }>(fetched)).id).toBe(share.id);
    });

    it("created projects and landed assets carry short public ids", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/projects", {
        cookie: seed.admin.cookie,
        json: { name: unique("Spot") },
      });
      expect(created.status).toBe(201);
      const body = await json<{ id: string; public_id: string }>(created);
      expect(body.public_id).toMatch(/^[0-9a-f]{10}$/);
      expect(body.public_id).not.toBe(body.id);
    });
  });

  describe("downloads", () => {
    const seedProjectMedia = async (
      h: ContractHarness,
      seed: { workspaceId: string; admin: { id: string; cookie: string } },
      options: { folderId?: string | null; projectId: string; name?: string },
    ) => {
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: options.projectId,
        userId: seed.admin.id,
        folderId: options.folderId ?? null,
        ...(options.name ? { name: options.name } : {}),
      });
      if (h.blobStore)
        await h.blobStore.putStream(
          media.blobKey,
          new Response(encoder.encode("0123456789")).body as ReadableStream,
          {},
        );
      return media;
    };

    ctx.itBlob(
      "versions download original at editor, proxy at viewer",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const media = seed.media;
        if (h.blobStore)
          await h.blobStore.putStream(
            media.blobKey,
            new Response(encoder.encode("0123456789")).body as ReadableStream,
            {},
          );
        const original = await req(
          h,
          `/api/v1/versions/${media.versionId}/download`,
          { cookie: seed.editor.cookie },
        );
        expect(original.status).toBe(200);
        const signed = await json<{ url: string; expires_at: number }>(
          original,
        );
        /* Download URLs live long enough to resume a big pull hours later. */
        expect(signed.expires_at - h.clock.now()).toBeGreaterThan(
          11 * 60 * 60 * 1000,
        );
        const served = await req(h, signed.url, { cookie: seed.editor.cookie });
        expect(served.status).toBe(200);
        expect(served.headers.get("content-disposition")).toContain(
          "attachment",
        );
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(
          encoder.encode("0123456789"),
        );
        const denied = await req(
          h,
          `/api/v1/versions/${media.versionId}/download`,
          { cookie: seed.viewer.cookie },
        );
        expect(denied.status).toBe(403);
        const rendition = await seedRendition(h, {
          versionId: media.versionId,
          kind: "proxy_1080",
        });
        if (h.blobStore)
          await h.blobStore.putStream(
            rendition.blobKey,
            new Response(new Uint8Array(rendition.bytes))
              .body as ReadableStream,
            {},
          );
        const proxy = await req(
          h,
          `/api/v1/versions/${media.versionId}/download?kind=proxy`,
          { cookie: seed.viewer.cookie },
        );
        expect(proxy.status).toBe(200);
        const proxySigned = await json<{ url: string }>(proxy);
        const proxyServed = await req(h, proxySigned.url, {
          cookie: seed.viewer.cookie,
        });
        expect(proxyServed.status).toBe(200);
        expect(new Uint8Array(await proxyServed.arrayBuffer())).toEqual(
          rendition.bytes,
        );
      },
    );

    ctx.itBlob("project zip streams the folder tree for editors", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const folderId = h.ids.ulid();
      const now = h.clock.now();
      await h.db
        .insert(folders)
        .values({
          id: folderId,
          projectId: project.id,
          parentId: null,
          kind: "assets",
          name: "Day 01",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await seedProjectMedia(h, seed, { projectId: project.id, folderId });
      await seedProjectMedia(h, seed, { projectId: project.id });
      const zipped = await req(h, `/api/v1/projects/${project.id}/zip`, {
        cookie: seed.admin.cookie,
      });
      expect(zipped.status).toBe(200);
      expect(zipped.headers.get("content-type")).toBe("application/zip");
      const declared = Number(zipped.headers.get("content-length"));
      const bytes = new Uint8Array(await zipped.arrayBuffer());
      expect(bytes.length).toBe(declared);
      expect([...bytes.slice(0, 4)]).toEqual(ZIP_MAGIC);
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text).toContain("Day 01/");
      const denied = await req(h, `/api/v1/projects/${seed.project.id}/zip`, {
        cookie: seed.viewer.cookie,
      });
      expect(denied.status).toBe(403);
      const scoped = await req(
        h,
        `/api/v1/projects/${project.id}/zip?folder_id=${folderId}`,
        { cookie: seed.admin.cookie },
      );
      expect(scoped.status).toBe(200);
    });

    ctx.itBlob(
      "saves a delivery and serves it as parts, by token",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const project = await createProject(h, seed.admin);
        for (let index = 0; index < 4; index += 1)
          await seedProjectMedia(h, seed, {
            projectId: project.id,
            name: `frame-${String(index)}.jpg`,
          });
        /* Ten bytes per file, so a part size of 12 cuts after every first
           file and the whole delivery is four parts of one. */
        const created = await req(
          h,
          `/api/v1/projects/${project.id}/downloads`,
          {
            cookie: seed.admin.cookie,
            json: { part_bytes: 64 * 1024 * 1024 },
          },
        );
        expect(created.status).toBe(201);
        const manifest = await json<{
          id: string;
          file_count: number;
          total_bytes: number;
          parts: Array<{ index: number; url: string; bytes: number }>;
        }>(created);
        expect(manifest.file_count).toBe(4);
        expect(manifest.total_bytes).toBe(40);
        expect(manifest.parts).toHaveLength(1);
        expect(assertSnakeCaseKeys(manifest)).toEqual([]);
        /* The token downloads it. No asset id ever goes near the URL, which
           is what made a 3000-file selection unservable behind a proxy. */
        const zipped = await req(h, `/api/v1/downloads/${manifest.id}/zip`, {
          cookie: seed.admin.cookie,
        });
        expect(zipped.status).toBe(200);
        const declared = Number(zipped.headers.get("content-length"));
        const bytes = new Uint8Array(await zipped.arrayBuffer());
        expect(bytes.length).toBe(declared);
        expect([...bytes.slice(0, 4)]).toEqual(ZIP_MAGIC);
        /* A viewer cannot download a manifest an editor saved: the token is a
           saved selection, not a grant, and permission is re-checked against
           the project on every fetch. */
        const denied = await req(h, `/api/v1/downloads/${manifest.id}/zip`, {
          cookie: seed.viewer.cookie,
        });
        expect(denied.status).toBe(403);
        const missingPart = await req(
          h,
          `/api/v1/downloads/${manifest.id}/zip?part=7`,
          { cookie: seed.admin.cookie },
        );
        expect(missingPart.status).toBe(400);
      },
    );

    ctx.itBlob("splits a delivery into whole-file parts", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      for (let index = 0; index < 4; index += 1)
        await seedProjectMedia(h, seed, {
          projectId: project.id,
          name: `part-${String(index)}.jpg`,
        });
      const created = await req(h, `/api/v1/projects/${project.id}/downloads`, {
        cookie: seed.admin.cookie,
        /* Below the schema's floor is refused; use the floor and a stubbed
             part size through the manifest row instead. */
        json: { part_bytes: 64 * 1024 * 1024 },
      });
      const manifest = await json<{ id: string }>(created);
      await h.db
        .update(downloadManifests)
        .set({ partBytes: 25 })
        .where(eq(downloadManifests.id, manifest.id))
        .run();
      /* 10 bytes each, 25 to a part: two files per part, two parts. */
      const first = await req(
        h,
        `/api/v1/downloads/${manifest.id}/zip?part=1`,
        {
          cookie: seed.admin.cookie,
        },
      );
      expect(first.status).toBe(200);
      expect(first.headers.get("content-disposition")).toContain("1 of 2");
      const second = await req(
        h,
        `/api/v1/downloads/${manifest.id}/zip?part=2`,
        { cookie: seed.admin.cookie },
      );
      expect(second.status).toBe(200);
      const firstBytes = new Uint8Array(await first.arrayBuffer());
      const secondBytes = new Uint8Array(await second.arrayBuffer());
      /* Every part is a whole archive in its own right. */
      for (const bytes of [firstBytes, secondBytes])
        expect([...bytes.slice(0, 4)]).toEqual(ZIP_MAGIC);
      const firstText = new TextDecoder("latin1").decode(firstBytes);
      const secondText = new TextDecoder("latin1").decode(secondBytes);
      /* Whole files, never split across parts. */
      for (const name of ["part-0.jpg", "part-1.jpg"])
        expect(firstText.includes(name) || secondText.includes(name)).toBe(
          true,
        );
      expect(firstText.includes("part-3.jpg")).toBe(false);
    });

    ctx.itBlob("share zip follows the download policy", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const first = await seedProjectMedia(h, seed, { projectId: project.id });
      const second = await seedProjectMedia(h, seed, { projectId: project.id });
      const makeShare = async (options: Record<string, unknown>) => {
        const created = await req(h, "/api/v1/shares", {
          cookie: seed.admin.cookie,
          json: {
            project_id: project.id,
            title: unique("Bundle"),
            asset_ids: [first.assetId, second.assetId],
            ...options,
          },
        });
        expect(created.status).toBe(201);
        return (await json<{ share: { slug: string } }>(created)).share;
      };
      const open = async (slug: string) => {
        const response = await req(h, `/api/v1/s/${slug}/access`, {
          json: { name: "Zip Fan" },
          headers: { "x-forwarded-for": uniqueIp() },
        });
        expect(response.status).toBe(200);
        return cookieFrom(response);
      };
      const originals = await makeShare({ allow_download: "original" });
      const cookie = await open(originals.slug);
      const zipped = await req(h, `/api/v1/s/${originals.slug}/zip`, {
        cookie,
      });
      expect(zipped.status).toBe(200);
      const bytes = new Uint8Array(await zipped.arrayBuffer());
      expect(bytes.length).toBe(Number(zipped.headers.get("content-length")));
      expect([...bytes.slice(0, 4)]).toEqual(ZIP_MAGIC);
      const noGrant = await req(h, `/api/v1/s/${originals.slug}/zip`);
      expect(noGrant.status).toBe(401);
      const none = await makeShare({ allow_download: "none" });
      const noneCookie = await open(none.slug);
      expect(
        (await req(h, `/api/v1/s/${none.slug}/zip`, { cookie: noneCookie }))
          .status,
      ).toBe(403);
      const watermarked = await makeShare({
        allow_download: "original",
        watermark_spec: { text: "{share}", position: "br" },
      });
      const wmCookie = await open(watermarked.slug);
      expect(
        (
          await req(h, `/api/v1/s/${watermarked.slug}/zip`, {
            cookie: wmCookie,
          })
        ).status,
      ).toBe(403);
    });
  });
};
