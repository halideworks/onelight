import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hmacSha256Hex } from "@onelight/core";
import {
  commentAttachments,
  webhookDeliveries,
  webhooks,
} from "@onelight/db/schema";
import {
  deliverDueWebhookDeliveries,
  scheduleWebhookDeliveries,
} from "../../webhooks.js";
import { assertSnakeCaseKeys, errorCode, json, req } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  createProject,
  createUser,
  seedAssetVersion,
  seedRendition,
  uniqueIp,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Patch global fetch to capture webhook deliveries without any network. */
const withFetchStub = async (
  status: number,
  fn: (calls: CapturedRequest[]) => Promise<void>,
): Promise<void> => {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  const stub = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return Promise.resolve(
      new Response(status < 400 ? "ok" : "boom", { status }),
    );
  };
  globalThis.fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const deleteWebhook = async (
  h: ContractHarness,
  cookie: string,
  id: string,
): Promise<void> => {
  await req(h, `/api/v1/webhooks/${id}`, { method: "DELETE", cookie });
};

export const registerSystemDomain = (ctx: SuiteContext): void => {
  describe("webhooks", () => {
    it("creates webhooks admin-only, hides secrets on list, and deletes", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const memberDenied = await req(h, "/api/v1/webhooks", {
        cookie: seed.manager.cookie,
        json: { url: "https://hooks.example.com/a", events: ["*"] },
      });
      expect(memberDenied.status).toBe(403);
      const shortSecret = await req(h, "/api/v1/webhooks", {
        cookie: seed.admin.cookie,
        json: {
          url: "https://hooks.example.com/a",
          secret: "short",
          events: ["*"],
        },
      });
      expect(shortSecret.status).toBe(400);
      const created = await req(h, "/api/v1/webhooks", {
        cookie: seed.admin.cookie,
        json: { url: "https://hooks.example.com/a", events: ["*"] },
      });
      expect(created.status).toBe(201);
      const body = await json<{ id: string; secret: string }>(created);
      expect(body.secret.length).toBeGreaterThanOrEqual(16);
      const listed = await json<{ items: Array<Record<string, unknown>> }>(
        await req(h, "/api/v1/webhooks", { cookie: seed.admin.cookie }),
      );
      const entry = listed.items.find((item) => item.id === body.id);
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty("secret");
      const memberList = await req(h, "/api/v1/webhooks", {
        cookie: seed.viewer.cookie,
      });
      expect(memberList.status).toBe(403);
      const removed = await req(h, `/api/v1/webhooks/${body.id}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
      expect(removed.status).toBe(204);
      const after = await json<{ items: Array<Record<string, unknown>> }>(
        await req(h, "/api/v1/webhooks", { cookie: seed.admin.cookie }),
      );
      expect(after.items.some((item) => item.id === body.id)).toBe(false);
    });

    it("rejects SSRF-prone webhook URLs at creation", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const blockedUrls = [
        "http://127.0.0.1/hook",
        "http://10.0.0.8/hook",
        "http://172.20.1.1/hook",
        "http://192.168.1.4/hook",
        "http://169.254.169.254/latest",
        "http://0.0.0.0/hook",
        "http://localhost/hook",
        "http://sub.localhost/hook",
        "http://[::1]/hook",
        "http://build.internal/hook",
        "http://printer.local/hook",
        "ftp://example.com/hook",
      ];
      for (const url of blockedUrls) {
        const response = await req(h, "/api/v1/webhooks", {
          cookie: seed.admin.cookie,
          json: { url, events: ["*"] },
        });
        expect(response.status, url).toBe(400);
        expect(await errorCode(response), url).toBe("validation_failed");
      }
    });

    it("delivers events with an HMAC signature and idempotent scheduling", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/webhooks", {
        cookie: seed.admin.cookie,
        json: { url: "https://hooks.example.com/deliver", events: ["*"] },
      });
      const hook = await json<{ id: string; secret: string }>(created);
      try {
        const project = await createProject(h, seed.admin);
        const deliveries = await h.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, hook.id))
          .all();
        expect(deliveries).toHaveLength(1);
        const delivery = deliveries[0];
        expect(delivery?.eventType).toBe("project.created");
        // Scheduling the same event id again must not duplicate the row
        // (UNIQUE webhook_id + event_id).
        await scheduleWebhookDeliveries(
          h.db,
          seed.workspaceId,
          delivery?.eventId ?? "",
          "project.created",
          { project_id: project.id },
          h.clock.now(),
        );
        const afterReschedule = await h.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, hook.id))
          .all();
        expect(afterReschedule).toHaveLength(1);
        await withFetchStub(200, async (calls) => {
          const delivered = await deliverDueWebhookDeliveries(
            h.db,
            h.clock.now(),
          );
          expect(delivered).toBe(1);
          expect(calls).toHaveLength(1);
          const call = calls[0];
          expect(call?.url).toBe("https://hooks.example.com/deliver");
          expect(call?.headers["x-onelight-event-id"]).toBe(delivery?.eventId);
          const expectedSignature = await hmacSha256Hex(
            hook.secret,
            call?.body ?? "",
          );
          expect(call?.headers["x-onelight-signature"]).toBe(expectedSignature);
          const parsed = JSON.parse(call?.body ?? "{}") as {
            id: string;
            type: string;
            data: { project_id?: string };
          };
          expect(parsed.type).toBe("project.created");
          expect(parsed.id).toBe(delivery?.eventId);
        });
        const finished = (
          await h.db
            .select()
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.webhookId, hook.id))
            .all()
        )[0];
        expect(finished?.status).toBe("delivered");
        expect(finished?.responseStatus).toBe(200);
      } finally {
        await deleteWebhook(h, seed.admin.cookie, hook.id);
      }
    });

    it("filters deliveries by the webhook's event subscriptions", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/webhooks", {
        cookie: seed.admin.cookie,
        json: {
          url: "https://hooks.example.com/filtered",
          events: ["comment.created"],
        },
      });
      const hook = await json<{ id: string }>(created);
      try {
        await scheduleWebhookDeliveries(
          h.db,
          seed.workspaceId,
          h.ids.ulid(),
          "project.created",
          {},
          h.clock.now(),
        );
        const rows = await h.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, hook.id))
          .all();
        expect(rows).toHaveLength(0);
      } finally {
        await deleteWebhook(h, seed.admin.cookie, hook.id);
      }
    });

    it("retries with exponential backoff and dead-letters after 8 attempts", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/webhooks", {
        cookie: seed.admin.cookie,
        json: { url: "https://hooks.example.com/failing", events: ["*"] },
      });
      const hook = await json<{ id: string }>(created);
      const startedAt = h.clock.now();
      try {
        await scheduleWebhookDeliveries(
          h.db,
          seed.workspaceId,
          h.ids.ulid(),
          "contract.retry",
          { attempt: "test" },
          h.clock.now(),
        );
        const deliveryId =
          (
            await h.db
              .select()
              .from(webhookDeliveries)
              .where(eq(webhookDeliveries.webhookId, hook.id))
              .all()
          )[0]?.id ?? "";
        expect(deliveryId).toBeTruthy();
        await withFetchStub(500, async (calls) => {
          for (let attempt = 1; attempt <= 8; attempt += 1) {
            await deliverDueWebhookDeliveries(h.db, h.clock.now());
            const row = (
              await h.db
                .select()
                .from(webhookDeliveries)
                .where(eq(webhookDeliveries.id, deliveryId))
                .all()
            )[0];
            expect(row?.attempt).toBe(attempt);
            if (attempt < 8) {
              expect(row?.status).toBe("failed");
              const expectedBackoff = Math.min(
                3_600_000,
                2 ** Math.min(attempt, 10) * 1000,
              );
              expect(row?.nextAttemptAt).toBe(h.clock.now() + expectedBackoff);
              // Not due yet: an immediate drain does nothing.
              await deliverDueWebhookDeliveries(h.db, h.clock.now());
              const unchanged = (
                await h.db
                  .select()
                  .from(webhookDeliveries)
                  .where(eq(webhookDeliveries.id, deliveryId))
                  .all()
              )[0];
              expect(unchanged?.attempt).toBe(attempt);
              h.clock.advance(expectedBackoff + 1000);
            } else {
              expect(row?.status).toBe("dead");
            }
          }
          const callsBeforeDrain = calls.length;
          h.clock.advance(3_600_000 + 1000);
          await deliverDueWebhookDeliveries(h.db, h.clock.now());
          expect(calls.length).toBe(callsBeforeDrain);
        });
      } finally {
        h.clock.set(startedAt);
        await deleteWebhook(h, seed.admin.cookie, hook.id);
      }
    });

    it("re-checks the SSRF guard at delivery time", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const hookId = h.ids.ulid();
      await h.db
        .insert(webhooks)
        .values({
          id: hookId,
          workspaceId: seed.workspaceId,
          url: "http://169.254.169.254/latest",
          secret: "a-secret-of-sixteen-chars",
          eventsJson: JSON.stringify(["*"]),
          active: true,
          createdAt: h.clock.now(),
        })
        .run();
      try {
        await scheduleWebhookDeliveries(
          h.db,
          seed.workspaceId,
          h.ids.ulid(),
          "contract.ssrf",
          {},
          h.clock.now(),
        );
        await withFetchStub(200, async (calls) => {
          await deliverDueWebhookDeliveries(h.db, h.clock.now());
          expect(calls).toHaveLength(0);
        });
        const row = (
          await h.db
            .select()
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.webhookId, hookId))
            .all()
        )[0];
        expect(row?.status).toBe("failed");
      } finally {
        await deleteWebhook(h, seed.admin.cookie, hookId);
      }
    });
  });

  describe("workspace usage", () => {
    it("sums originals and renditions per project, admin only", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      const rendition = await seedRendition(h, {
        versionId: media.versionId,
        content: "usage-proxy-bytes",
      });
      const member = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const forbidden = await req(h, "/api/v1/workspace/usage", {
        cookie: member.cookie,
      });
      expect(forbidden.status).toBe(403);
      const response = await req(h, "/api/v1/workspace/usage", {
        cookie: seed.admin.cookie,
      });
      expect(response.status).toBe(200);
      const body = await json<{
        totals: Record<string, number>;
        disk: unknown;
        projects: Array<Record<string, unknown>>;
      }>(response);
      // The contract harness has no filesystem behind its blob store, so
      // capacity is the same null an object-storage deployment reports.
      expect(body.disk).toBeNull();
      const row = body.projects.find((entry) => entry.id === project.id);
      expect(row).toBeDefined();
      // seedAssetVersion writes size 10; the rendition weighs its content.
      expect(row?.originals_bytes).toBe(10);
      expect(row?.renditions_bytes).toBe(rendition.bytes.byteLength);
      expect(row?.asset_count).toBe(1);
      expect(row?.version_count).toBe(1);
      expect(body.totals.originals_bytes).toBeGreaterThanOrEqual(10);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
    });
  });

  describe("system status", () => {
    it("reports version and queue depths, admin only", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const member = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const forbidden = await req(h, "/api/v1/admin/system", {
        cookie: member.cookie,
      });
      expect(forbidden.status).toBe(403);
      // An export job so at least one queue has a countable row.
      const queued = await req(
        h,
        `/api/v1/projects/${seed.project.id}/export`,
        { cookie: seed.admin.cookie, json: { format: "csv" } },
      );
      expect(queued.status).toBe(202);
      const response = await req(h, "/api/v1/admin/system", {
        cookie: seed.admin.cookie,
      });
      expect(response.status).toBe(200);
      const body = await json<{
        version: string;
        db_size_bytes: number | null;
        backups: unknown;
        disk: unknown;
        mail: { state: string; detail: string | null };
        media_jobs: Record<string, number>;
        export_jobs: Record<string, number>;
        webhook_deliveries: Record<string, number>;
      }>(response);
      expect(body.version.length).toBeGreaterThan(0);
      // The contract harness runs without a host behind it: no database
      // file, no BACKUP_DIR, no filesystem capacity.
      expect(body.db_size_bytes).toBeNull();
      expect(body.backups).toBeNull();
      expect(body.disk).toBeNull();
      // Mail posture mirrors the leg: the Node harness carries a stub
      // mailer, the Workers harness carries none.
      expect(body.mail.state).toBe(h.mailer ? "ready" : "disabled");
      expect(body.export_jobs.queued).toBeGreaterThanOrEqual(1);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      // Queues are workspace-scoped: the other workspace's admin does not
      // see this workspace's export job.
      const foreign = await json<{ export_jobs: Record<string, number> }>(
        await req(h, "/api/v1/admin/system", {
          cookie: seed.other.admin.cookie,
        }),
      );
      expect(foreign.export_jobs.queued ?? 0).toBe(0);
    });

    it("sends a test email to the calling admin, or refuses plainly", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const member = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const forbidden = await req(h, "/api/v1/admin/system/test-email", {
        method: "POST",
        cookie: member.cookie,
      });
      expect(forbidden.status).toBe(403);
      const response = await req(h, "/api/v1/admin/system/test-email", {
        method: "POST",
        cookie: seed.admin.cookie,
      });
      if (h.mailer) {
        expect(response.status).toBe(200);
        const body = await json<{ sent: boolean; to: string }>(response);
        expect(body.sent).toBe(true);
        const delivered = h.mailer.messages[h.mailer.messages.length - 1];
        expect(delivered?.to).toBe(body.to);
        expect(delivered?.subject).toContain("test email");
      } else {
        // The Workers leg has no mail transport: the refusal is a plain
        // conflict, not a silent 200.
        expect(response.status).toBe(409);
      }
    });
  });

  describe("trash", () => {
    it("lists trashed assets for admins and feeds restore", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await createProject(h, seed.admin);
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });
      await req(h, `/api/v1/assets/${media.assetId}/trash`, {
        method: "POST",
        cookie: seed.admin.cookie,
      });
      const member = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      expect(
        (await req(h, "/api/v1/trash", { cookie: member.cookie })).status,
      ).toBe(403);
      const listed = await json<{
        items: Array<{ id: string; project_name: string }>;
      }>(await req(h, "/api/v1/trash", { cookie: seed.admin.cookie }));
      const row = listed.items.find((item) => item.id === media.assetId);
      expect(row).toBeDefined();
      expect(row?.project_name).toBeTruthy();
      await req(h, `/api/v1/assets/${media.assetId}/restore`, {
        method: "POST",
        cookie: seed.admin.cookie,
      });
      const after = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/trash", { cookie: seed.admin.cookie }),
      );
      expect(after.items.some((item) => item.id === media.assetId)).toBe(false);
    });
  });

  describe("audit", () => {
    it("records actions, filters by action, and paginates", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
        session: false,
      });
      const login = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: "contract-password-1" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(login.status).toBe(200);
      const filtered = await json<{
        items: Array<{
          action: string;
          actor_user_id: string | null;
          target: string | null;
        }>;
      }>(
        await req(h, "/api/v1/audit?action=user.login&limit=200", {
          cookie: seed.admin.cookie,
        }),
      );
      expect(filtered.items.length).toBeGreaterThan(0);
      for (const entry of filtered.items)
        expect(entry.action).toBe("user.login");
      expect(
        filtered.items.some((entry) => entry.actor_user_id === user.id),
      ).toBe(true);
      const paged = await json<{
        items: unknown[];
        next_cursor: string | null;
      }>(await req(h, "/api/v1/audit?limit=1", { cookie: seed.admin.cookie }));
      expect(paged.items).toHaveLength(1);
      expect(paged.next_cursor).toBeTruthy();
      const secondPage = await req(
        h,
        `/api/v1/audit?limit=1&cursor=${encodeURIComponent(paged.next_cursor ?? "")}`,
        { cookie: seed.admin.cookie },
      );
      expect(secondPage.status).toBe(200);
      const malformed = await req(h, "/api/v1/audit?cursor=%%", {
        cookie: seed.admin.cookie,
      });
      expect(malformed.status).toBe(400);
    });

    it("scopes the audit log to the caller's workspace", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const primary = await json<{ items: unknown[] }>(
        await req(h, "/api/v1/audit?action=setup.complete", {
          cookie: seed.admin.cookie,
        }),
      );
      expect(primary.items).toHaveLength(1);
      const foreign = await json<{ items: unknown[] }>(
        await req(h, "/api/v1/audit?action=setup.complete", {
          cookie: seed.other.admin.cookie,
        }),
      );
      expect(foreign.items).toHaveLength(0);
    });
  });

  describe("cross-workspace isolation", () => {
    it("hides every primary-workspace resource from the other workspace", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const foreign = seed.other.admin.cookie;
      const cases: Array<[string, string, number]> = [
        ["GET", `/api/v1/projects/${seed.project.id}`, 404],
        ["GET", `/api/v1/projects/${seed.project.id}/members`, 404],
        ["GET", `/api/v1/projects/${seed.project.id}/folders`, 404],
        ["GET", `/api/v1/projects/${seed.project.id}/assets`, 404],
        ["GET", `/api/v1/projects/${seed.project.id}/events`, 404],
        ["GET", `/api/v1/assets/${seed.media.assetId}`, 404],
        ["GET", `/api/v1/assets/${seed.media.assetId}/versions`, 404],
        ["GET", `/api/v1/versions/${seed.media.versionId}`, 404],
        ["GET", `/api/v1/versions/${seed.media.versionId}/comments`, 404],
        ["GET", `/api/v1/versions/${seed.media.versionId}/renditions`, 404],
        ["GET", `/api/v1/uploads/${seed.media.uploadSessionId}/parts`, 404],
        ["DELETE", `/api/v1/uploads/${seed.media.uploadSessionId}`, 404],
      ];
      for (const [method, path, expected] of cases) {
        const response = await req(h, path, { method, cookie: foreign });
        expect(response.status, `${method} ${path}`).toBe(expected);
      }
      const patchUser = await req(h, `/api/v1/users/${seed.editor.id}`, {
        method: "PATCH",
        cookie: foreign,
        json: { disabled: true },
      });
      expect(patchUser.status).toBe(404);
      const patchAsset = await req(h, `/api/v1/assets/${seed.media.assetId}`, {
        method: "PATCH",
        cookie: foreign,
        json: { name: "hijack" },
      });
      expect(patchAsset.status).toBe(404);
      const postComment = await req(
        h,
        `/api/v1/versions/${seed.media.versionId}/comments`,
        { cookie: foreign, json: { body_text: "hijack" } },
      );
      expect(postComment.status).toBe(404);
      const memberPut = await req(
        h,
        `/api/v1/projects/${seed.project.id}/members/${seed.other.admin.id}`,
        { method: "PUT", cookie: foreign, json: { role: "manager" } },
      );
      expect(memberPut.status).toBe(404);
    });

    it("keeps webhook deletion from crossing workspaces", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/webhooks", {
        cookie: seed.admin.cookie,
        json: { url: "https://hooks.example.com/scoped", events: ["*"] },
      });
      const hook = await json<{ id: string }>(created);
      try {
        const foreignDelete = await req(h, `/api/v1/webhooks/${hook.id}`, {
          method: "DELETE",
          cookie: seed.other.admin.cookie,
        });
        expect(foreignDelete.status).toBe(204);
        const survives = await json<{ items: Array<{ id: string }> }>(
          await req(h, "/api/v1/webhooks", { cookie: seed.admin.cookie }),
        );
        expect(survives.items.some((item) => item.id === hook.id)).toBe(true);
      } finally {
        await deleteWebhook(h, seed.admin.cookie, hook.id);
      }
    });

    it("hides the other workspace from primary users symmetrically", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const project = await req(h, `/api/v1/projects/${seed.other.projectId}`, {
        cookie: seed.admin.cookie,
      });
      expect(project.status).toBe(404);
      const asset = await req(h, `/api/v1/assets/${seed.other.media.assetId}`, {
        cookie: seed.admin.cookie,
      });
      expect(asset.status).toBe(404);
      const listing = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/projects?limit=200", {
          cookie: seed.admin.cookie,
        }),
      );
      expect(
        listing.items.some((item) => item.id === seed.other.projectId),
      ).toBe(false);
    });
  });

  describe("database invariants", () => {
    it("enforces foreign keys on this backend", async () => {
      const h = ctx.h();
      let failed = false;
      try {
        await h.db
          .insert(commentAttachments)
          .values({
            id: h.ids.ulid(),
            commentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            blobKey: "nowhere",
            filename: "x",
            size: 1,
            contentType: "text/plain",
            checksumSha256: "",
          })
          .run();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });
  });

  describe("healthz and docs", () => {
    it("serves /healthz at the root and under /api/v1", async () => {
      const h = ctx.h();
      for (const path of ["/healthz", "/api/v1/healthz"]) {
        const response = await req(h, path);
        expect(response.status, path).toBe(200);
        const body = await json(response);
        expect(body.status).toBe("ok");
        expect(typeof body.version).toBe("string");
      }
    });

    it("serves the docs page", async () => {
      const h = ctx.h();
      for (const path of ["/api/docs", "/api/v1/docs"]) {
        const response = await req(h, path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
      }
    });
  });

  describe("openapi", () => {
    interface OpenApiOperation {
      requestBody?: { content?: Record<string, unknown> };
      responses: Record<
        string,
        { content?: Record<string, { schema?: unknown }> }
      >;
    }

    /* Mutating routes that take no JSON body by design; everything else
       must document a request schema. */
    const BODYLESS_MUTATIONS = new Set([
      "post /api/v1/auth/logout",
      "post /api/v1/comments/{id}/complete",
      "post /api/v1/uploads/{id}/multipart",
      "post /api/v1/uploads/{id}/abort",
      "post /api/v1/assets/{id}/trash",
      "post /api/v1/assets/{id}/restore",
      "post /api/v1/users/me/totp",
      "post /api/v1/admin/system/test-email",
    ]);

    it("documents every registered /api/v1 route with schemas", async () => {
      const h = ctx.h();
      const response = await req(h, "/api/v1/openapi.json");
      expect(response.status).toBe(200);
      const body = await json<{
        openapi: string;
        paths: Record<string, Record<string, OpenApiOperation>>;
      }>(response);
      expect(body.openapi).toBe("3.1.0");
      const methods = new Set(["get", "post", "put", "patch", "delete"]);
      for (const route of h.app.routes) {
        const method = route.method.toLowerCase();
        if (!methods.has(method)) continue;
        if (!route.path.startsWith("/api/v1/")) continue;
        if (
          route.path === "/api/v1/openapi.json" ||
          route.path === "/api/v1/docs"
        )
          continue;
        const path = route.path
          .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
          .replace(/\*/g, "{path}");
        const operation = body.paths[path]?.[method];
        expect(operation, `${method} ${path}`).toBeDefined();
        if (!operation) continue;
        // Every route documents at least one success response, and every
        // success response that carries a body has a schema (204 and 302
        // legitimately have none).
        const successes = Object.entries(operation.responses).filter(
          ([status]) => status.startsWith("2") || status.startsWith("3"),
        );
        expect(successes.length, `${method} ${path}`).toBeGreaterThan(0);
        for (const [status, success] of successes) {
          if (status === "204" || status === "302") continue;
          const content = success.content ?? {};
          const schemas = Object.values(content).map((entry) => entry.schema);
          expect(
            schemas.some((schema) => schema !== undefined),
            `${method} ${path} ${status} has a response schema`,
          ).toBe(true);
        }
        // Mutating routes document their request schema unless they are
        // body-less by design.
        if (
          ["post", "put", "patch"].includes(method) &&
          !BODYLESS_MUTATIONS.has(`${method} ${path}`)
        )
          expect(
            operation.requestBody?.content,
            `${method} ${path} has a request schema`,
          ).toBeDefined();
      }
    });
  });

  describe("bootstrap", () => {
    it("serves the post-setup shape publicly with only three fields", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const response = await req(h, "/api/v1/bootstrap");
      expect(response.status).toBe(200);
      const body = await json<Record<string, unknown>>(response);
      expect(body).toEqual({
        oidc_enabled: false,
        setup_required: false,
        workspace_name: seed.workspaceName,
      });
      // No auth, no cookie, no information beyond those fields.
      expect(Object.keys(body).sort()).toEqual([
        "oidc_enabled",
        "setup_required",
        "workspace_name",
      ]);
    });
  });
};
