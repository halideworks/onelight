import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyNodeMigrations,
  assetVersions,
  assets,
  claimNextJob,
  createNodeDb,
  jobs,
  projects,
  uploadSessions,
  users,
  workspaces,
} from "@onelight/db";
import { renditions } from "@onelight/db/schema";
import { createWorkerRoutes } from "./worker-routes.js";

const SECRET = "worker-secret-for-tests";

const seed = async (db: ReturnType<typeof createNodeDb>["db"]) => {
  await db
    .insert(workspaces)
    .values({ id: "ws-1", name: "Studio", createdAt: 1 })
    .run();
  await db
    .insert(users)
    .values({
      id: "user-1",
      workspaceId: "ws-1",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db
    .insert(projects)
    .values({
      id: "project-1",
      workspaceId: "ws-1",
      name: "Film",
      palette: "kuro",
      createdBy: "user-1",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db
    .insert(uploadSessions)
    .values({
      id: "upload-1",
      workspaceId: "ws-1",
      projectId: "project-1",
      createdBy: "user-1",
      clientFilename: "picture.mov",
      relativePath: "",
      size: 100,
      blobKey: "originals/picture.mov",
      status: "completed",
      createdAt: 1,
      completedAt: 1,
    })
    .run();
  await db
    .insert(assets)
    .values({
      id: "asset-1",
      projectId: "project-1",
      name: "Picture",
      kind: "video",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db
    .insert(assetVersions)
    .values({
      id: "version-1",
      assetId: "asset-1",
      uploadSessionId: "upload-1",
      versionNo: 1,
      originalBlobKey: "originals/picture.mov",
      originalFilename: "picture.mov",
      size: 100,
      checksumCrc32c: "",
      uploadedBy: "user-1",
      transcodeStatus: "pending",
      createdAt: 1,
    })
    .run();
};

const queueProbe = async (
  db: ReturnType<typeof createNodeDb>["db"],
  overrides: { maxAttempts?: number } = {},
) => {
  await db
    .insert(jobs)
    .values({
      id: "job-probe",
      kind: "probe",
      payloadJson: JSON.stringify({
        workspace_id: "ws-1",
        project_id: "project-1",
        version_id: "version-1",
        blob_key: "originals/picture.mov",
      }),
      idempotencyKey: "probe:version-1",
      status: "queued",
      priority: 0,
      capabilityJson: "{}",
      maxAttempts: overrides.maxAttempts ?? 3,
      attempts: 0,
      runAfter: Date.now(),
      createdAt: Date.now(),
    })
    .run();
};

const claim = async (
  app: ReturnType<typeof createWorkerRoutes>,
  body: Record<string, unknown>,
  options: { secret?: string; signature?: string } = {},
): Promise<Response> => {
  const payload = JSON.stringify(body);
  return app.request("/api/v1/worker/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onelight-signature":
        options.signature ??
        createHmac("sha256", options.secret ?? SECRET)
          .update(payload)
          .digest("hex"),
    },
    body: payload,
  });
};

interface ClaimResponse {
  job_id: string;
  kind: string;
  attempt: number;
  token: string;
  lease_ms: number;
  deadline_ms: number;
  request: Record<string, unknown>;
}

const claimJob = async (
  app: ReturnType<typeof createWorkerRoutes>,
  workerId: string,
): Promise<ClaimResponse> => {
  const response = await claim(app, {
    worker_id: workerId,
    capabilities: ["cpu"],
    timestamp: Date.now(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ClaimResponse;
};

describe("the worker claim", () => {
  it("refuses a body that is not signed with the worker secret", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/tmp",
        workerSecret: SECRET,
      });
      const wrong = await claim(
        app,
        { worker_id: "w-1", capabilities: ["cpu"], timestamp: Date.now() },
        { secret: "not-the-secret" },
      );
      expect(wrong.status).toBe(401);
      const malformed = await claim(
        app,
        { worker_id: "w-1", capabilities: ["cpu"], timestamp: Date.now() },
        { signature: "nonsense" },
      );
      expect(malformed.status).toBe(401);
      // Nothing was handed out, so the job is still queued and unattempted.
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-probe")).all()
      )[0];
      expect(row?.status).toBe("queued");
      expect(row?.attempts).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a signed claim whose timestamp is outside the skew", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/tmp",
        workerSecret: SECRET,
      });
      const stale = await claim(app, {
        worker_id: "w-1",
        capabilities: ["cpu"],
        timestamp: Date.now() - 10 * 60_000,
      });
      expect(stale.status).toBe(401);
    } finally {
      sqlite.close();
    }
  });

  it("answers 204 when there is nothing to do", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/tmp",
        workerSecret: SECRET,
      });
      const idle = await claim(app, {
        worker_id: "w-1",
        capabilities: ["cpu"],
        timestamp: Date.now(),
      });
      expect(idle.status).toBe(204);
    } finally {
      sqlite.close();
    }
  });

  it("hands out a self-contained envelope and leases the job", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const claimed = await claimJob(app, "w-1");
      expect(claimed.job_id).toBe("job-probe");
      expect(claimed.attempt).toBe(1);
      expect(claimed.token).toMatch(/^[0-9a-f]{64}$/);
      /* Everything needed to run it travels with it: the worker reads no
         database, so a source it cannot resolve is a protocol failure. */
      expect(claimed.request).toMatchObject({
        job_id: "job-probe",
        kind: "probe",
        source_path: "/blobs/originals/picture.mov",
      });
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-probe")).all()
      )[0];
      expect(row?.status).toBe("processing");
      expect(row?.workerId).toBe("w-1");
      expect(row?.leaseExpiresAt).toBeGreaterThan(Date.now());
    } finally {
      sqlite.close();
    }
  });
});

describe("the attempt token", () => {
  const report = async (
    app: ReturnType<typeof createWorkerRoutes>,
    route: string,
    jobId: string,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    app.request(`/api/v1/worker/jobs/${jobId}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("is accepted for the attempt it was minted for", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const claimed = await claimJob(app, "w-1");
      const progress = await report(app, "progress", claimed.job_id, {
        worker_id: "w-1",
        attempt: claimed.attempt,
        token: claimed.token,
      });
      expect(progress.status).toBe(200);
      const extended = (await progress.json()) as { lease_expires_at: number };
      expect(extended.lease_expires_at).toBeGreaterThan(Date.now());
    } finally {
      sqlite.close();
    }
  });

  it("cannot complete a later attempt of its own job", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const first = await claimJob(app, "w-1");
      /* The first worker vanishes: its lease runs out and a second worker
         legitimately takes the job. This is the exact situation the token
         exists for -- the first worker may still be alive and about to
         report a result for work nobody is waiting on any more. */
      await db
        .update(jobs)
        .set({ leaseExpiresAt: Date.now() - 1 })
        .where(eq(jobs.id, first.job_id))
        .run();
      const second = await claimJob(app, "w-2");
      expect(second.attempt).toBe(2);
      expect(second.token).not.toBe(first.token);

      const late = await report(app, "complete", first.job_id, {
        worker_id: "w-1",
        attempt: first.attempt,
        token: first.token,
        result: { media_info: { format: {}, streams: [] } },
      });
      expect(late.status).toBe(409);
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, first.job_id)).all()
      )[0];
      expect(row?.status).toBe("processing");
      expect(row?.workerId).toBe("w-2");
    } finally {
      sqlite.close();
    }
  });

  it("says nothing about another job", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      await db
        .insert(jobs)
        .values({
          id: "job-other",
          kind: "probe",
          payloadJson: JSON.stringify({
            version_id: "version-1",
            blob_key: "originals/picture.mov",
          }),
          idempotencyKey: "probe:other",
          status: "queued",
          priority: 0,
          capabilityJson: "{}",
          maxAttempts: 3,
          attempts: 0,
          runAfter: Date.now(),
          createdAt: Date.now(),
        })
        .run();
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const mine = await claimJob(app, "w-1");
      const theirs = await claimJob(app, "w-2");
      expect(theirs.job_id).not.toBe(mine.job_id);
      const crossed = await report(app, "fail", theirs.job_id, {
        worker_id: "w-1",
        attempt: theirs.attempt,
        token: mine.token,
        error: "not mine to fail",
      });
      expect(crossed.status).toBe(409);
    } finally {
      sqlite.close();
    }
  });

  it("is refused when it is simply wrong", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const claimed = await claimJob(app, "w-1");
      const forged = await report(app, "progress", claimed.job_id, {
        worker_id: "w-1",
        attempt: claimed.attempt,
        token: "a".repeat(64),
      });
      expect(forged.status).toBe(401);
      const missing = await report(app, "progress", "job-that-is-not-here", {
        worker_id: "w-1",
        attempt: 1,
        token: claimed.token,
      });
      expect(missing.status).toBe(404);
    } finally {
      sqlite.close();
    }
  });
});

describe("a worker that vanishes", () => {
  /* The acceptance criterion of the phase, at unit scale: a job whose worker
     stops reporting comes back to the queue, is retried by somebody else, and
     dead-letters at its ceiling instead of cycling forever. The three-worker
     version of this runs in the integration workflow against real containers. */
  it("loses the job to the next claimant, and it dies at the ceiling", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db, { maxAttempts: 2 });
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const first = await claimJob(app, "w-1");
      expect(first.attempt).toBe(1);
      // It never reports again. The lease is the only thing that decides it
      // is gone, so run the clock past it.
      await db
        .update(jobs)
        .set({ leaseExpiresAt: Date.now() - 1 })
        .where(eq(jobs.id, "job-probe"))
        .run();

      const second = await claimJob(app, "w-2");
      expect(second.attempt).toBe(2);

      // The second worker vanishes too, which spends the ceiling.
      await db
        .update(jobs)
        .set({ leaseExpiresAt: Date.now() - 1 })
        .where(eq(jobs.id, "job-probe"))
        .run();
      const third = await claim(app, {
        worker_id: "w-3",
        capabilities: ["cpu"],
        timestamp: Date.now(),
      });
      expect(third.status).toBe(204);
      /* Claiming refuses it now, which is what the burial sweep looks for.
         Without the ceiling check this row would be handed out forever. */
      expect(
        await claimNextJob(db, Date.now(), "w-4", ["cpu"]),
      ).toBeUndefined();
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-probe")).all()
      )[0];
      expect(row?.attempts).toBe(2);
      expect(row?.status).toBe("processing");
    } finally {
      sqlite.close();
    }
  });
});

describe("what a worker says it wrote", () => {
  /* The worker is the process that opens files nobody vetted, which is why it
     runs sandboxed. A rendition key pointing outside the blob root would be
     stored on a row and later read back off the server's disk by the media
     route, so the completion is refused rather than believed. */
  it("is refused when it points outside the blob root", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await db
        .insert(jobs)
        .values({
          id: "job-transcode",
          kind: "transcode",
          payloadJson: JSON.stringify({
            workspace_id: "ws-1",
            version_id: "version-1",
            asset_id: "asset-1",
            blob_key: "originals/picture.mov",
          }),
          idempotencyKey: "transcode:version-1",
          status: "queued",
          priority: 0,
          capabilityJson: "{}",
          maxAttempts: 3,
          attempts: 0,
          runAfter: Date.now(),
          createdAt: Date.now(),
        })
        .run();
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const claimed = await claimJob(app, "w-1");
      const escaped = await app.request(
        `/api/v1/worker/jobs/${claimed.job_id}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            worker_id: "w-1",
            attempt: claimed.attempt,
            token: claimed.token,
            result: {
              renditions: [
                { kind: "proxy_1080", key: "/etc/shadow", meta: {} },
              ],
              failures: [],
            },
          }),
        },
      );
      expect(escaped.status).toBe(422);
      expect((await escaped.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("outside the blob root") as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
      // And the job is failed rather than left leased on a worker that lied.
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-transcode")).all()
      )[0];
      expect(row?.status).toBe("queued");
      expect(row?.error).toContain("outside the blob root");
    } finally {
      sqlite.close();
    }
  });

  it("is refused when the body is larger than any report could be", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      /* A body has to be read before it can be authenticated, so the cap is
         what stops an unauthenticated caller making the server buffer it. */
      const huge = await app.request("/api/v1/worker/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "w-1", pad: "x".repeat(6_000_000) }),
      });
      expect(huge.status).toBe(413);
    } finally {
      sqlite.close();
    }
  });
});

describe("a job nobody needs any more", () => {
  it("is completed by the claim rather than handed to a worker", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      /* A fingerprint job whose uploads have since been deleted plans to
         nothing. Handing a worker an empty envelope would have it fail a job
         that is not failing, so the claim retires it and looks for real work. */
      await db
        .insert(jobs)
        .values({
          id: "job-moot",
          kind: "fingerprint",
          payloadJson: JSON.stringify({ upload_ids: ["gone-1"] }),
          idempotencyKey: "fingerprint:gone",
          status: "queued",
          priority: 0,
          capabilityJson: "{}",
          maxAttempts: 3,
          attempts: 0,
          runAfter: Date.now(),
          createdAt: Date.now(),
        })
        .run();
      const app = createWorkerRoutes({
        db,
        blobRoot: "/blobs",
        workerSecret: SECRET,
      });
      const response = await claim(app, {
        worker_id: "w-1",
        capabilities: ["cpu"],
        timestamp: Date.now(),
      });
      expect(response.status).toBe(204);
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-moot")).all()
      )[0];
      expect(row?.status).toBe("complete");
    } finally {
      sqlite.close();
    }
  });
});
