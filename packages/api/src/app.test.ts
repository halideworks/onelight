import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import {
  Pbkdf2PasswordHasher,
  UlidGenerator,
  systemClock,
  loadConfig,
} from "@onelight/core";
import type { MultipartBlobStore } from "@onelight/core";
import {
  applyNodeMigrations,
  assets,
  assetVersions,
  createNodeDb,
  jobs,
  uploadSessions,
} from "@onelight/db";

// The in-memory blob store lives with the contract harness so both suites
// share one implementation.
import { MemoryBlobStore } from "./contract/memory-blob-store.js";

const makeTestApp = (blobStore?: MultipartBlobStore) => {
  const { db, sqlite } = createNodeDb(":memory:");
  applyNodeMigrations(sqlite);
  const config = loadConfig({
    PUBLIC_URL: "http://test.local",
    SECRET_KEY: "test-secret-that-is-longer-than-32-chars",
  });
  const app = createApp({
    db,
    hasher: new Pbkdf2PasswordHasher(),
    clock: systemClock,
    ids: new UlidGenerator(),
    config,
    version: "test",
    ...(blobStore ? { blobStore } : {}),
  });
  return { app, db, sqlite };
};

type TestContext = ReturnType<typeof makeTestApp>;

const cookieFrom = (response: Response): string =>
  response.headers.get("set-cookie")?.split(";")[0] ?? "";

const ORIGIN = "http://test.local";

const seedVersionFixture = async (ctx: TestContext) => {
  const setup = await ctx.app.request("/api/v1/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_name: "Test",
      name: "Admin",
      email: "admin@example.com",
      password: "long-password-value",
    }),
  });
  const cookie = cookieFrom(setup);
  const setupBody = (await setup.json()) as { user: { id: string } };
  const workspaceResponse = await ctx.app.request("/api/v1/workspace", {
    headers: { cookie },
  });
  const workspace = (await workspaceResponse.json()) as { id: string };
  const projectResponse = await ctx.app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    body: JSON.stringify({ name: "Spot" }),
  });
  const project = (await projectResponse.json()) as { id: string };
  const now = Date.now();
  const uploadSessionId = "01J00000000000000000000010";
  const assetId = "01J00000000000000000000011";
  const versionId = "01J00000000000000000000012";
  await ctx.db
    .insert(uploadSessions)
    .values({
      id: uploadSessionId,
      workspaceId: workspace.id,
      projectId: project.id,
      createdBy: setupBody.user.id,
      clientFilename: "spot.mp4",
      relativePath: "",
      size: 10,
      checksumCrc32c: "abc",
      blobKey: "spot.mp4",
      uploadId: null,
      partSize: null,
      status: "completed",
      createdAt: now,
      completedAt: now,
    })
    .run();
  await ctx.db
    .insert(assets)
    .values({
      id: assetId,
      projectId: project.id,
      folderId: null,
      name: "Spot",
      kind: "video",
      currentVersionId: versionId,
      status: "in_review",
      description: "",
      tagsJson: "[]",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await ctx.db
    .insert(assetVersions)
    .values({
      id: versionId,
      assetId,
      uploadSessionId,
      versionNo: 1,
      originalBlobKey: "spot.mp4",
      originalFilename: "spot.mp4",
      size: 10,
      checksumCrc32c: "abc",
      uploadedBy: setupBody.user.id,
      mediaInfoJson: "{}",
      sourceTimecodeStart: null,
      sourceStartFrame: null,
      frameRateNum: 24,
      frameRateDen: 1,
      dropFrame: false,
      durationFrames: 100,
      colorJson: "{}",
      transcodeStatus: "ready",
      deletedAt: null,
      createdAt: now,
    })
    .run();
  return {
    cookie,
    userId: setupBody.user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    uploadSessionId,
    assetId,
    versionId,
  };
};

describe("Phase 0 API contract", () => {
  it("returns the canonical error envelope for unauthenticated requests", async () => {
    const { app, sqlite } = makeTestApp();
    const response = await app.request("/api/v1/workspace");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication is required." },
    });
    sqlite.close();
  });

  it("serves the pre-setup bootstrap shape publicly", async () => {
    // The contract suite seeds a completed setup in beforeAll, so the
    // pre-setup shape is asserted here on a fresh app instead.
    const { app, sqlite } = makeTestApp();
    const response = await app.request("/api/v1/bootstrap");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      oidc_enabled: false,
      setup_required: true,
      workspace_name: null,
    });
    const afterSetup = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_name: "Bootstrap WS",
        name: "Admin",
        email: "bootstrap@example.com",
        password: "long-password-value",
      }),
    });
    expect(afterSetup.status).toBe(201);
    const post = await app.request("/api/v1/bootstrap");
    expect(await post.json()).toEqual({
      oidc_enabled: false,
      setup_required: false,
      workspace_name: "Bootstrap WS",
    });
    sqlite.close();
  });

  it("supports setup, login, project creation, and origin protection", async () => {
    const { app, sqlite } = makeTestApp();
    const setup = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_name: "Test",
        name: "Admin",
        email: "admin@example.com",
        password: "long-password-value",
      }),
    });
    expect(setup.status).toBe(201);
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.com",
        password: "long-password-value",
      }),
    });
    const cookie = cookieFrom(login);
    expect(login.status).toBe(200);
    const rejected = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Spot" }),
    });
    expect(rejected.status).toBe(403);
    const created = await app.request("/api/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://test.local",
      },
      body: JSON.stringify({ name: "Spot" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).name).toBe("Spot");
    sqlite.close();
  });

  it("stores internal comments and creates a passwordless public share projection", async () => {
    const { app, db, sqlite } = makeTestApp();
    const setup = await app.request("/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_name: "Test",
        name: "Admin",
        email: "admin@example.com",
        password: "long-password-value",
      }),
    });
    const cookie = cookieFrom(setup);
    const setupBody = (await setup.json()) as { user: { id: string } };
    const workspaceResponse = await app.request("/api/v1/workspace", {
      headers: { cookie },
    });
    const workspace = (await workspaceResponse.json()) as { id: string };
    const origin = "http://test.local";
    const projectResponse = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ name: "Spot" }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const now = Date.now();
    await db
      .insert(uploadSessions)
      .values({
        id: "01J00000000000000000000010",
        workspaceId: workspace.id,
        projectId: project.id,
        createdBy: setupBody.user.id,
        clientFilename: "spot.mp4",
        relativePath: "",
        size: 10,
        checksumCrc32c: "abc",
        blobKey: "spot.mp4",
        uploadId: null,
        partSize: null,
        status: "completed",
        createdAt: now,
        completedAt: now,
      })
      .run();
    await db
      .insert(assets)
      .values({
        id: "01J00000000000000000000011",
        projectId: project.id,
        folderId: null,
        name: "Spot",
        kind: "video",
        currentVersionId: "01J00000000000000000000012",
        status: "in_review",
        description: "",
        tagsJson: "[]",
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await db
      .insert(assetVersions)
      .values({
        id: "01J00000000000000000000012",
        assetId: "01J00000000000000000000011",
        uploadSessionId: "01J00000000000000000000010",
        versionNo: 1,
        originalBlobKey: "spot.mp4",
        originalFilename: "spot.mp4",
        size: 10,
        checksumCrc32c: "abc",
        uploadedBy: setupBody.user.id,
        mediaInfoJson: "{}",
        sourceTimecodeStart: null,
        sourceStartFrame: null,
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        durationFrames: 100,
        colorJson: "{}",
        transcodeStatus: "ready",
        deletedAt: null,
        createdAt: now,
      })
      .run();
    const commentResponse = await app.request(
      "/api/v1/versions/01J00000000000000000000012/comments",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({
          frame_in: 12,
          body_text: "Check this cut",
          internal: true,
        }),
      },
    );
    expect(commentResponse.status).toBe(201);
    const shareResponse = await app.request("/api/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({
        project_id: project.id,
        title: "Client review",
        asset_ids: ["01J00000000000000000000011"],
      }),
    });
    expect(shareResponse.status).toBe(201);
    const share = (await shareResponse.json()) as { share: { slug: string } };
    const access = await app.request(`/api/v1/s/${share.share.slug}/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Client" }),
    });
    expect(access.status).toBe(200);
    const viewerCookie = cookieFrom(access);
    const publicProjection = await app.request(
      `/api/v1/s/${share.share.slug}`,
      { headers: { cookie: viewerCookie } },
    );
    expect(publicProjection.status).toBe(200);
    const publicAssets = await app.request(`/s/${share.share.slug}/assets`, {
      headers: { cookie: viewerCookie },
    });
    expect(publicAssets.status).toBe(200);
    const publicComments = await app.request(
      `/api/v1/s/${share.share.slug}/assets/01J00000000000000000000011/comments`,
      { headers: { cookie: viewerCookie } },
    );
    expect(publicComments.status).toBe(200);
    expect((await publicComments.json()).items).toHaveLength(0);
    const publicComment = await app.request(
      `/s/${share.share.slug}/assets/01J00000000000000000000011/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: viewerCookie,
          origin: "http://test.local",
        },
        body: JSON.stringify({ frame_in: 20, body_text: "Client note" }),
      },
    );
    expect(publicComment.status).toBe(201);
    const publicCommentBody = (await publicComment.json()) as { id: string };
    const edited = await app.request(
      `/s/${share.share.slug}/comments/${publicCommentBody.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: viewerCookie,
          origin: "http://test.local",
        },
        body: JSON.stringify({ body_text: "Edited client note" }),
      },
    );
    expect(edited.status).toBe(200);
    sqlite.close();
  });
});

describe("audited defect fixes", () => {
  it("serves comment attachments through /media/* with token, range, and disposition", async () => {
    const ctx = makeTestApp(new MemoryBlobStore());
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const commentResponse = await ctx.app.request(
      `/api/v1/versions/${seeded.versionId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ body_text: "See attachment" }),
      },
    );
    expect(commentResponse.status).toBe(201);
    const comment = (await commentResponse.json()) as { id: string };
    const boundary = "----onelightboundary";
    const payload = "hello attachment";
    const formBody = [
      `--${boundary}`,
      'content-disposition: form-data; name="file"; filename="note.txt"',
      "content-type: text/plain",
      "",
      payload,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const attach = await ctx.app.request(
      `/api/v1/comments/${comment.id}/attachments`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: ORIGIN,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(
            new TextEncoder().encode(formBody).byteLength,
          ),
        },
        body: formBody,
      },
    );
    expect(attach.status).toBe(201);
    const attachment = (await attach.json()) as { id: string };
    const urlResponse = await ctx.app.request(
      `/api/v1/comments/${comment.id}/attachments/${attachment.id}`,
      { headers: { cookie } },
    );
    expect(urlResponse.status).toBe(200);
    const { url } = (await urlResponse.json()) as { url: string };
    /* Wire media URLs are origin-relative by design; base only for parsing. */
    const parsed = new URL(url, "http://wire.invalid");
    const withToken = await ctx.app.request(parsed.pathname + parsed.search, {
      headers: { cookie },
    });
    expect(withToken.status).toBe(200);
    expect(withToken.headers.get("content-type")).toBe("text/plain");
    expect(withToken.headers.get("content-disposition")).toBe(
      'attachment; filename="note.txt"',
    );
    expect(withToken.headers.get("content-length")).toBe(
      String(payload.length),
    );
    expect(await withToken.text()).toBe(payload);
    const withoutToken = await ctx.app.request(parsed.pathname, {
      headers: { cookie },
    });
    expect(withoutToken.status).toBe(401);
    const ranged = await ctx.app.request(parsed.pathname + parsed.search, {
      headers: { cookie, range: "bytes=0-4" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 0-4/${payload.length}`,
    );
    expect(ranged.headers.get("content-length")).toBe("5");
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(await ranged.text()).toBe("hello");
    const unsatisfiable = await ctx.app.request(
      parsed.pathname + parsed.search,
      { headers: { cookie, range: "bytes=99-" } },
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(
      `bytes */${payload.length}`,
    );
    ctx.sqlite.close();
  });

  it("blocks share-cookie mutations from a foreign origin", async () => {
    const ctx = makeTestApp();
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const shareResponse = await ctx.app.request("/api/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({
        project_id: seeded.projectId,
        title: "Client review",
        asset_ids: [seeded.assetId],
      }),
    });
    const share = (await shareResponse.json()) as { share: { slug: string } };
    const access = await ctx.app.request(
      `/api/v1/s/${share.share.slug}/access`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Client" }),
      },
    );
    const viewerCookie = cookieFrom(access);
    const blocked = await ctx.app.request(
      `/api/v1/s/${share.share.slug}/assets/${seeded.assetId}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: viewerCookie,
          origin: "http://evil.example",
        },
        body: JSON.stringify({ body_text: "csrf attempt" }),
      },
    );
    expect(blocked.status).toBe(403);
    const allowed = await ctx.app.request(
      `/api/v1/s/${share.share.slug}/assets/${seeded.assetId}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: viewerCookie,
          origin: ORIGIN,
        },
        body: JSON.stringify({ body_text: "legit comment" }),
      },
    );
    expect(allowed.status).toBe(201);
    ctx.sqlite.close();
  });

  it("paginates comments with a composite frame cursor and rejects bad cursors", async () => {
    const ctx = makeTestApp();
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const frames: Array<number | undefined> = [
      undefined,
      10,
      5,
      undefined,
      5,
      0,
      10,
    ];
    for (const [index, frame] of frames.entries()) {
      const response = await ctx.app.request(
        `/api/v1/versions/${seeded.versionId}/comments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin: ORIGIN,
          },
          body: JSON.stringify({
            body_text: `comment ${index}`,
            ...(frame === undefined ? {} : { frame_in: frame }),
          }),
        },
      );
      expect(response.status).toBe(201);
    }
    const fullResponse = await ctx.app.request(
      `/api/v1/versions/${seeded.versionId}/comments?limit=50`,
      { headers: { cookie } },
    );
    const full = (await fullResponse.json()) as {
      items: Array<{ id: string; frame_in: number | null }>;
    };
    expect(full.items).toHaveLength(frames.length);
    const fullFrames = full.items.map((item) => item.frame_in ?? -1);
    expect(fullFrames).toEqual([...fullFrames].sort((a, b) => a - b));
    const collected: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const cursorQuery: string = next
        ? `&cursor=${encodeURIComponent(next)}`
        : "";
      const pageResponse = await ctx.app.request(
        `/api/v1/versions/${seeded.versionId}/comments?limit=2${cursorQuery}`,
        { headers: { cookie } },
      );
      expect(pageResponse.status).toBe(200);
      const page = (await pageResponse.json()) as {
        items: Array<{ id: string }>;
        next_cursor: string | null;
      };
      collected.push(...page.items.map((item) => item.id));
      next = page.next_cursor;
      pages += 1;
    } while (next);
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(collected).toEqual(full.items.map((item) => item.id));
    expect(new Set(collected).size).toBe(frames.length);
    const malformed = await ctx.app.request(
      `/api/v1/versions/${seeded.versionId}/comments?cursor=not-a-cursor`,
      { headers: { cookie } },
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as {
      error: { code: string };
    };
    expect(malformedBody.error.code).toBe("validation_failed");
    ctx.sqlite.close();
  });

  it("returns the completed comment from POST /comments/:id/complete", async () => {
    const ctx = makeTestApp();
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const created = await ctx.app.request(
      `/api/v1/versions/${seeded.versionId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ body_text: "Finish this" }),
      },
    );
    const comment = (await created.json()) as { id: string };
    const completed = await ctx.app.request(
      `/api/v1/comments/${comment.id}/complete`,
      { method: "POST", headers: { cookie, origin: ORIGIN } },
    );
    expect(completed.status).toBe(200);
    const body = (await completed.json()) as {
      id: string;
      completed_at: number | null;
      completed_by: string | null;
    };
    expect(body.id).toBe(comment.id);
    expect(body.completed_at).toBeTruthy();
    expect(body.completed_by).toBe(seeded.userId);
    ctx.sqlite.close();
  });

  it("rejects webhook URLs that target private or local destinations", async () => {
    const ctx = makeTestApp();
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const blockedUrls = [
      "http://127.0.0.1/hook",
      "http://10.0.0.8/hook",
      "http://172.20.1.1/hook",
      "http://192.168.1.4/hook",
      "http://169.254.169.254/latest",
      "http://0.0.0.0/hook",
      "http://localhost/hook",
      "http://[::1]/hook",
      "http://build.internal/hook",
      "http://printer.local/hook",
      "ftp://example.com/hook",
    ];
    for (const url of blockedUrls) {
      const response = await ctx.app.request("/api/v1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ url, events: ["*"] }),
      });
      expect(response.status, url).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, url).toBe("validation_failed");
    }
    const allowed = await ctx.app.request("/api/v1/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({
        url: "https://hooks.example.com/deliver",
        events: ["*"],
      }),
    });
    expect(allowed.status).toBe(201);
    ctx.sqlite.close();
  });

  it("serializes versions and jobs with snake_case wire shapes only", async () => {
    const ctx = makeTestApp();
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const versionResponse = await ctx.app.request(
      `/api/v1/versions/${seeded.versionId}`,
      { headers: { cookie } },
    );
    expect(versionResponse.status).toBe(200);
    const version = (await versionResponse.json()) as Record<string, unknown>;
    expect(version.id).toBe(seeded.versionId);
    expect(version.asset_id).toBe(seeded.assetId);
    expect(version.checksum_crc32c).toBe("abc");
    expect(version.frame_rate_num).toBe(24);
    for (const forbidden of [
      "assetId",
      "versionNo",
      "originalBlobKey",
      "original_blob_key",
      "uploadSessionId",
      "upload_session_id",
      "mediaInfoJson",
      "deletedAt",
    ])
      expect(version, forbidden).not.toHaveProperty(forbidden);
    const now = Date.now();
    const jobId = "01J00000000000000000000020";
    await ctx.db
      .insert(jobs)
      .values({
        id: jobId,
        kind: "probe",
        payloadJson: JSON.stringify({
          workspace_id: seeded.workspaceId,
          project_id: seeded.projectId,
          asset_id: seeded.assetId,
          version_id: seeded.versionId,
          blob_key: "secret/blob/key.mp4",
        }),
        idempotencyKey: `probe:${seeded.versionId}`,
        status: "queued",
        priority: 0,
        capabilityJson: "{}",
        maxAttempts: 5,
        attempts: 0,
        runAfter: now,
        createdAt: now,
        startedAt: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        finishedAt: null,
        error: null,
        workerId: null,
      })
      .run();
    const jobResponse = await ctx.app.request(`/api/v1/jobs/${jobId}`, {
      headers: { cookie },
    });
    expect(jobResponse.status).toBe(200);
    const job = (await jobResponse.json()) as Record<string, unknown>;
    expect(job.id).toBe(jobId);
    expect(job.max_attempts).toBe(5);
    expect(job.payload).toEqual({
      workspace_id: seeded.workspaceId,
      project_id: seeded.projectId,
      asset_id: seeded.assetId,
      version_id: seeded.versionId,
    });
    for (const forbidden of [
      "idempotencyKey",
      "idempotency_key",
      "payloadJson",
      "capabilityJson",
      "capability",
      "workerId",
      "worker_id",
      "maxAttempts",
      "blobKey",
    ])
      expect(job, forbidden).not.toHaveProperty(forbidden);
    const adminJobs = await ctx.app.request("/api/v1/admin/jobs", {
      headers: { cookie },
    });
    expect(adminJobs.status).toBe(200);
    const adminBody = (await adminJobs.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const adminJob = adminBody.items.find((item) => item.id === jobId);
    expect(adminJob).toBeDefined();
    expect(adminJob).not.toHaveProperty("idempotencyKey");
    expect(
      (adminJob?.payload as Record<string, unknown>).blob_key,
    ).toBeUndefined();
    ctx.sqlite.close();
  });

  it("deletes upload sessions and refuses uploads referenced by versions", async () => {
    const ctx = makeTestApp(new MemoryBlobStore());
    const seeded = await seedVersionFixture(ctx);
    const { cookie } = seeded;
    const conflicted = await ctx.app.request(
      `/api/v1/uploads/${seeded.uploadSessionId}`,
      { method: "DELETE", headers: { cookie, origin: ORIGIN } },
    );
    expect(conflicted.status).toBe(409);
    const created = await ctx.app.request("/api/v1/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({
        project_id: seeded.projectId,
        filename: "b.mov",
        size: 4,
      }),
    });
    expect(created.status).toBe(201);
    const upload = (await created.json()) as { upload: { id: string } };
    const deleted = await ctx.app.request(
      `/api/v1/uploads/${upload.upload.id}`,
      { method: "DELETE", headers: { cookie, origin: ORIGIN } },
    );
    expect(deleted.status).toBe(204);
    const gone = await ctx.app.request(
      `/api/v1/uploads/${upload.upload.id}/parts`,
      { headers: { cookie } },
    );
    expect(gone.status).toBe(404);
    ctx.sqlite.close();
  });

  it("generates the OpenAPI paths from the registered routes", async () => {
    const ctx = makeTestApp();
    const response = await ctx.app.request("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = new Set(["get", "post", "put", "patch", "delete"]);
    for (const route of ctx.app.routes) {
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
      expect(body.paths[path], `${method} ${path}`).toBeDefined();
      expect(body.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    }
    for (const [path, method] of [
      ["/api/v1/assets/{id}/trash", "post"],
      ["/api/v1/assets/{id}/restore", "post"],
      ["/api/v1/versions/{id}/stack", "patch"],
      ["/api/v1/uploads/{id}", "delete"],
    ] as const)
      expect(body.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    const docs = await ctx.app.request("/api/docs");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    ctx.sqlite.close();
  });
});
