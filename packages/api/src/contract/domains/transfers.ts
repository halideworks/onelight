import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { crc32cBase64 } from "@onelight/core";
import {
  assets,
  folders,
  notifications,
  transferReceipts,
  uploadSessions,
} from "@onelight/db/schema";
import { cookieFrom, forbiddenKeysIn, json, req, travel } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import type { SeedState } from "../seed.js";
import { createProject, seedAssetVersion, unique, uniqueIp } from "../seed.js";
import type { SuiteContext } from "../context.js";

const encoder = new TextEncoder();

interface TransferFixture {
  projectId: string;
  transferId: string;
  slug: string;
  assetId?: string;
  versionId?: string;
  blobKey?: string;
}

const makePackage = async (
  h: ContractHarness,
  seed: SeedState,
  options: Record<string, unknown> = {},
): Promise<TransferFixture> => {
  const project = await createProject(h, seed.admin);
  const media = await seedAssetVersion(h, {
    workspaceId: seed.workspaceId,
    projectId: project.id,
    userId: seed.admin.id,
  });
  const response = await req(h, "/api/v1/transfers", {
    cookie: seed.admin.cookie,
    json: {
      project_id: project.id,
      kind: "package",
      title: unique("Deliverables"),
      asset_ids: [media.assetId],
      ...options,
    },
  });
  if (response.status !== 201)
    throw new Error(`Package fixture failed: ${response.status}`);
  const body = await json<{ transfer: { id: string; slug: string } }>(response);
  return {
    projectId: project.id,
    transferId: body.transfer.id,
    slug: body.transfer.slug,
    assetId: media.assetId,
    versionId: media.versionId,
    blobKey: media.blobKey,
  };
};

const makeRequestLink = async (
  h: ContractHarness,
  seed: SeedState,
  options: Record<string, unknown> = {},
): Promise<TransferFixture> => {
  const project = await createProject(h, seed.admin);
  const response = await req(h, "/api/v1/transfers", {
    cookie: seed.admin.cookie,
    json: {
      project_id: project.id,
      kind: "request",
      title: unique("Send footage"),
      ...options,
    },
  });
  if (response.status !== 201)
    throw new Error(`Request fixture failed: ${response.status}`);
  const body = await json<{ transfer: { id: string; slug: string } }>(response);
  return {
    projectId: project.id,
    transferId: body.transfer.id,
    slug: body.transfer.slug,
  };
};

const accessTransfer = async (
  h: ContractHarness,
  slug: string,
  body: Record<string, unknown> = { name: "Client" },
): Promise<{ cookie: string; response: Response }> => {
  const response = await req(h, `/api/v1/t/${slug}/access`, {
    json: body,
    headers: { "x-forwarded-for": uniqueIp() },
  });
  return { cookie: cookieFrom(response), response };
};

export const registerTransfersDomain = (ctx: SuiteContext): void => {
  describe("transfers", () => {
    it("creates packages manager-only, requests editor-up, kinds kept honest", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const packageDenied = await req(h, "/api/v1/transfers", {
        cookie: seed.editor.cookie,
        json: {
          project_id: seed.project.id,
          kind: "package",
          title: "Editor Package",
          asset_ids: [seed.media.assetId],
        },
      });
      expect(packageDenied.status).toBe(403);
      const requestAllowed = await req(h, "/api/v1/transfers", {
        cookie: seed.editor.cookie,
        json: {
          project_id: seed.project.id,
          kind: "request",
          title: "Editor Request",
        },
      });
      expect(requestAllowed.status).toBe(201);
      const emptyPackage = await req(h, "/api/v1/transfers", {
        cookie: seed.admin.cookie,
        json: {
          project_id: seed.project.id,
          kind: "package",
          title: "Empty",
          asset_ids: [],
        },
      });
      expect(emptyPackage.status).toBe(400);
      const requestWithFiles = await req(h, "/api/v1/transfers", {
        cookie: seed.admin.cookie,
        json: {
          project_id: seed.project.id,
          kind: "request",
          title: "Confused",
          asset_ids: [seed.media.assetId],
        },
      });
      expect(requestWithFiles.status).toBe(400);
      const foreignProject = await createProject(h, seed.admin);
      const crossProject = await req(h, "/api/v1/transfers", {
        cookie: seed.admin.cookie,
        json: {
          project_id: foreignProject.id,
          kind: "package",
          title: "Cross",
          asset_ids: [seed.media.assetId],
        },
      });
      expect(crossProject.status).toBe(400);
      const created = await req(h, "/api/v1/transfers", {
        cookie: seed.admin.cookie,
        json: {
          project_id: seed.project.id,
          kind: "package",
          title: "Final Deliverables",
          asset_ids: [seed.media.assetId],
          passphrase: "sesame-9",
        },
      });
      expect(created.status).toBe(201);
      const body = await json<{
        transfer: Record<string, unknown>;
        url: string;
      }>(created);
      expect(forbiddenKeysIn(body)).toEqual([]);
      expect(body.transfer.has_passphrase).toBe(true);
      expect(body.transfer.item_count).toBe(1);
      expect(body.transfer.received_bytes).toBe(0);
      expect(body.url).toContain(`/t/${body.transfer.slug as string}`);
      expect(String(body.transfer.slug)).toMatch(/^final-deliverables-/);
    });

    it("lists with counts and details items and receipts", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makePackage(h, seed);
      const listing = await req(
        h,
        `/api/v1/transfers?project_id=${fixture.projectId}`,
        {
          cookie: seed.admin.cookie,
        },
      );
      expect(listing.status).toBe(200);
      const listed = await json<{
        items: Array<Record<string, unknown> & { id: string }>;
      }>(listing);
      const row = listed.items.find((item) => item.id === fixture.transferId);
      expect(row?.item_count).toBe(1);
      const detail = await req(h, `/api/v1/transfers/${fixture.transferId}`, {
        cookie: seed.admin.cookie,
      });
      expect(detail.status).toBe(200);
      const detailBody = await json<{
        items: Array<{ asset_id: string; name: string; sort_order: number }>;
        receipts: unknown[];
      }>(detail);
      expect(detailBody.items).toHaveLength(1);
      expect(detailBody.items[0]?.asset_id).toBe(fixture.assetId);
      expect(detailBody.receipts).toEqual([]);
      const outsider = await req(h, `/api/v1/transfers/${fixture.transferId}`);
      expect(outsider.status).toBe(401);
    });

    it("revocation, expiry, and the passphrase gate the public page", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makePackage(h, seed, {
        expires_at: h.clock.now() + 60_000,
      });
      const open = await req(h, `/api/v1/t/${fixture.slug}`);
      expect(open.status).toBe(200);
      const revoked = await req(h, `/api/v1/transfers/${fixture.transferId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { revoked: true },
      });
      expect(revoked.status).toBe(200);
      expect((await req(h, `/api/v1/t/${fixture.slug}`)).status).toBe(404);
      await req(h, `/api/v1/transfers/${fixture.transferId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { revoked: false },
      });
      expect((await req(h, `/api/v1/t/${fixture.slug}`)).status).toBe(200);
      await travel(h.clock, 120_000, async () => {
        expect((await req(h, `/api/v1/t/${fixture.slug}`)).status).toBe(404);
      });
      const locked = await req(h, `/api/v1/transfers/${fixture.transferId}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { passphrase: "gate-7" },
      });
      expect(locked.status).toBe(200);
      const noPass = await accessTransfer(h, fixture.slug, { name: "Guess" });
      expect(noPass.response.status).toBe(401);
      const wrongPass = await accessTransfer(h, fixture.slug, {
        name: "Guess",
        passphrase: "wrong",
      });
      expect(wrongPass.response.status).toBe(401);
      const rightPass = await accessTransfer(h, fixture.slug, {
        name: "Client",
        passphrase: "gate-7",
      });
      expect(rightPass.response.status).toBe(200);
    });

    it("public shell shows files only after a name is given, and leaks nothing", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makePackage(h, seed);
      const anonymous = await req(h, `/api/v1/t/${fixture.slug}`);
      const anonymousBody = await json<{
        authorized: boolean;
        files: unknown[];
        transfer: Record<string, unknown>;
      }>(anonymous);
      expect(anonymousBody.authorized).toBe(false);
      expect(anonymousBody.files).toEqual([]);
      const nameless = await accessTransfer(h, fixture.slug, {});
      expect(nameless.response.status).toBe(400);
      const access = await accessTransfer(h, fixture.slug, { name: "Ana" });
      expect(access.response.status).toBe(200);
      const shell = await json<{
        authorized: boolean;
        files: Array<Record<string, unknown>>;
        transfer: Record<string, unknown>;
      }>(access.response);
      expect(shell.authorized).toBe(true);
      expect(shell.files).toHaveLength(1);
      expect(shell.files[0]?.asset_id).toBe(fixture.assetId);
      expect(shell.files[0]?.size).toBe(10);
      expect(forbiddenKeysIn(shell)).toEqual([]);
      for (const banned of ["project_id", "folder_id", "created_by", "id"])
        expect(Object.keys(shell.transfer)).not.toContain(banned);
      const downloadWithoutGrant = await req(
        h,
        `/api/v1/t/${fixture.slug}/files/${fixture.assetId}/download`,
        { method: "POST", json: {} },
      );
      expect(downloadWithoutGrant.status).toBe(401);
    });

    ctx.itBlob(
      "package downloads deliver original bytes, zip included, and notify",
      async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const fixture = await makePackage(h, seed);
        const content = encoder.encode("0123456789");
        if (!h.blobStore || !fixture.blobKey) throw new Error("no blob store");
        await h.blobStore.putStream(
          fixture.blobKey,
          new Response(content).body as ReadableStream,
          {},
        );
        const access = await accessTransfer(h, fixture.slug, {
          name: "Downloader Dana",
        });
        const signed = await req(
          h,
          `/api/v1/t/${fixture.slug}/files/${fixture.assetId}/download`,
          { method: "POST", cookie: access.cookie, json: {} },
        );
        expect(signed.status).toBe(200);
        const signedBody = await json<{ url: string }>(signed);
        const served = await req(h, signedBody.url, { cookie: access.cookie });
        expect(served.status).toBe(200);
        expect(served.headers.get("content-disposition")).toContain(
          "attachment",
        );
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(content);
        const zipped = await req(h, `/api/v1/t/${fixture.slug}/zip`, {
          cookie: access.cookie,
        });
        expect(zipped.status).toBe(200);
        expect(zipped.headers.get("content-type")).toBe("application/zip");
        const declared = Number(zipped.headers.get("content-length"));
        const bytes = new Uint8Array(await zipped.arrayBuffer());
        expect(bytes.length).toBe(declared);
        expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
        const rows = await h.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, seed.admin.id),
              eq(notifications.kind, "transfer.downloaded"),
            ),
          )
          .all();
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const payload = JSON.parse(rows[0]?.payloadJson ?? "{}") as {
          name?: string;
        };
        expect(payload.name).toBe("Downloader Dana");
      },
    );

    ctx.itBlob(
      "request links receive files that land as review-ready assets",
      async () => {
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
            name: unique("Inbound"),
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const createResponse = await req(h, "/api/v1/transfers", {
          cookie: seed.admin.cookie,
          json: {
            project_id: project.id,
            kind: "request",
            title: unique("Camera originals"),
            folder_id: folderId,
          },
        });
        expect(createResponse.status).toBe(201);
        const created = await json<{ transfer: { id: string; slug: string } }>(
          createResponse,
        );
        const slug = created.transfer.slug;
        const unauthorized = await req(h, `/api/v1/t/${slug}/uploads`, {
          json: { filename: "sneak.mp4", size: 4 },
        });
        expect(unauthorized.status).toBe(401);
        const access = await accessTransfer(h, slug, { name: "Vendor VFX" });
        expect(access.response.status).toBe(200);
        const traversal = await req(h, `/api/v1/t/${slug}/uploads`, {
          cookie: access.cookie,
          json: { filename: "clip.mp4", size: 4, relative_path: "../../up" },
        });
        expect(traversal.status).toBe(400);
        const content = "hello-transfer";
        const checksum = crc32cBase64(encoder.encode(content));
        const createUpload = await req(h, `/api/v1/t/${slug}/uploads`, {
          cookie: access.cookie,
          json: {
            filename: "A001_C007.mp4",
            size: content.length,
            checksum_crc32c: checksum,
          },
        });
        expect(createUpload.status).toBe(201);
        const uploadBody = await json<{
          upload: Record<string, unknown> & { id: string };
        }>(createUpload);
        expect(forbiddenKeysIn(uploadBody)).toEqual([]);
        expect(Object.keys(uploadBody.upload)).not.toContain("project_id");
        const uploadId = uploadBody.upload.id;
        const multipart = await req(
          h,
          `/api/v1/t/${slug}/uploads/${uploadId}/multipart`,
          { method: "POST", cookie: access.cookie, json: {} },
        );
        expect(multipart.status).toBe(200);
        const multipartBody = await json<{ part_size: number }>(multipart);
        expect(multipartBody.part_size).toBeGreaterThan(0);
        const part = await req(
          h,
          `/api/v1/t/${slug}/uploads/${uploadId}/parts/1`,
          {
            method: "PUT",
            cookie: access.cookie,
            body: content,
            headers: { "content-type": "application/octet-stream" },
          },
        );
        expect(part.status).toBe(204);
        const etag = part.headers.get("etag") ?? "";
        const listed = await req(
          h,
          `/api/v1/t/${slug}/uploads/${uploadId}/parts`,
          { cookie: access.cookie },
        );
        expect(listed.status).toBe(200);
        const completed = await req(
          h,
          `/api/v1/t/${slug}/uploads/${uploadId}/complete`,
          {
            method: "POST",
            cookie: access.cookie,
            json: {
              parts: [{ part_no: 1, etag }],
              checksum_crc32c: checksum,
            },
          },
        );
        expect(completed.status).toBe(202);
        const completedBody = await json<{
          upload: { status: string };
          asset_id: string | null;
        }>(completed);
        expect(completedBody.upload.status).toBe("completed");
        expect(completedBody.asset_id).toBeTruthy();
        const landed = (
          await h.db
            .select()
            .from(assets)
            .where(eq(assets.id, completedBody.asset_id ?? ""))
            .all()
        )[0];
        expect(landed?.folderId).toBe(folderId);
        expect(landed?.name).toBe("A001_C007.mp4");
        expect(landed?.kind).toBe("video");
        const receipt = (
          await h.db
            .select()
            .from(transferReceipts)
            .where(eq(transferReceipts.uploadSessionId, uploadId))
            .all()
        )[0];
        expect(receipt?.senderName).toBe("Vendor VFX");
        expect(receipt?.assetId).toBe(completedBody.asset_id);
        const notified = await h.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, seed.admin.id),
              eq(notifications.kind, "transfer.received"),
            ),
          )
          .all();
        expect(notified.length).toBeGreaterThanOrEqual(1);
        const recomplete = await req(
          h,
          `/api/v1/t/${slug}/uploads/${uploadId}/complete`,
          {
            method: "POST",
            cookie: access.cookie,
            json: { parts: [{ part_no: 1, etag }] },
          },
        );
        expect(recomplete.status).toBe(202);
        expect(
          (await json<{ asset_id: string | null }>(recomplete)).asset_id,
        ).toBe(completedBody.asset_id);
        const detail = await req(
          h,
          `/api/v1/transfers/${created.transfer.id}`,
          { cookie: seed.admin.cookie },
        );
        const detailBody = await json<{
          received_count: number;
          received_bytes: number;
          receipts: Array<{ sender_name: string; status: string }>;
        }>(detail);
        expect(detailBody.received_count).toBe(1);
        expect(detailBody.received_bytes).toBe(content.length);
        expect(detailBody.receipts[0]?.sender_name).toBe("Vendor VFX");
      },
    );

    it("byte caps refuse uploads past the limit, counting in-flight bytes", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeRequestLink(h, seed, { byte_cap: 30 });
      const access = await accessTransfer(h, fixture.slug, { name: "Cap" });
      const first = await req(h, `/api/v1/t/${fixture.slug}/uploads`, {
        cookie: access.cookie,
        json: { filename: "one.bin", size: 20 },
      });
      expect(first.status).toBe(201);
      const second = await req(h, `/api/v1/t/${fixture.slug}/uploads`, {
        cookie: access.cookie,
        json: { filename: "two.bin", size: 20 },
      });
      expect(second.status).toBe(413);
      const third = await req(h, `/api/v1/t/${fixture.slug}/uploads`, {
        cookie: access.cookie,
        json: { filename: "three.bin", size: 10 },
      });
      expect(third.status).toBe(201);
    });

    ctx.itBlob("checksum mismatch quarantines and lands nothing", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const fixture = await makeRequestLink(h, seed);
      const access = await accessTransfer(h, fixture.slug, { name: "Ivy" });
      const content = "corrupted-payload";
      const createUpload = await req(h, `/api/v1/t/${fixture.slug}/uploads`, {
        cookie: access.cookie,
        json: {
          filename: "bad.bin",
          size: content.length,
          checksum_crc32c: crc32cBase64(encoder.encode("something else")),
        },
      });
      expect(createUpload.status).toBe(201);
      const uploadId = (await json<{ upload: { id: string } }>(createUpload))
        .upload.id;
      await req(h, `/api/v1/t/${fixture.slug}/uploads/${uploadId}/multipart`, {
        method: "POST",
        cookie: access.cookie,
        json: {},
      });
      const part = await req(
        h,
        `/api/v1/t/${fixture.slug}/uploads/${uploadId}/parts/1`,
        {
          method: "PUT",
          cookie: access.cookie,
          body: content,
          headers: { "content-type": "application/octet-stream" },
        },
      );
      const completed = await req(
        h,
        `/api/v1/t/${fixture.slug}/uploads/${uploadId}/complete`,
        {
          method: "POST",
          cookie: access.cookie,
          json: {
            parts: [{ part_no: 1, etag: part.headers.get("etag") ?? "" }],
          },
        },
      );
      expect(completed.status).toBe(400);
      const session = (
        await h.db
          .select()
          .from(uploadSessions)
          .where(eq(uploadSessions.id, uploadId))
          .all()
      )[0];
      expect(session?.status).toBe("quarantined");
      const receipt = (
        await h.db
          .select()
          .from(transferReceipts)
          .where(eq(transferReceipts.uploadSessionId, uploadId))
          .all()
      )[0];
      expect(receipt?.assetId).toBeNull();
    });

    it("one link's grant opens nothing else", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const first = await makeRequestLink(h, seed);
      const second = await makeRequestLink(h, seed);
      const access = await accessTransfer(h, first.slug, { name: "Solo" });
      const crossUpload = await req(h, `/api/v1/t/${second.slug}/uploads`, {
        cookie: access.cookie,
        json: { filename: "cross.bin", size: 4 },
      });
      expect(crossUpload.status).toBe(401);
      const packageFixture = await makePackage(h, seed);
      const crossZip = await req(h, `/api/v1/t/${packageFixture.slug}/zip`, {
        cookie: access.cookie,
      });
      expect(crossZip.status).toBe(401);
    });
  });
};
