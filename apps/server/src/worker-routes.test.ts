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

/* What storage holds, as far as a test is concerned. The pump asks the store
   for the length of every output a worker reports, so a completion here
   declares what landed instead of writing files to a real disk. */
const storeOf = (objects: Record<string, number> = {}) => ({
  head: (key: string): Promise<{ size: number }> =>
    key in objects
      ? Promise.resolve({ size: objects[key] as number })
      : Promise.reject(new Error(`No object at ${key}.`)),
  /* Contents nothing here reads, at the length the object is declared to be:
     what the blob route is asked to prove is that it serves the right object,
     entirely, to the right caller. */
  getStream: (key: string): Promise<ReadableStream> => {
    if (!(key in objects))
      return Promise.reject(new Error(`No object at ${key}.`));
    const bytes = new Uint8Array(objects[key] as number).fill(7);
    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  },
  delete: (key: string): Promise<void> => {
    delete objects[key];
    return Promise.resolve();
  },
});

const routes = (
  db: ReturnType<typeof createNodeDb>["db"],
  store: ReturnType<typeof storeOf> = storeOf(),
): ReturnType<typeof createWorkerRoutes> =>
  createWorkerRoutes({ db, blobRoot: "/blobs", store, workerSecret: SECRET });

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
      const app = routes(db);
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
      const app = routes(db);
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
      const app = routes(db);
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
      const app = routes(db);
      const claimed = await claimJob(app, "w-1");
      expect(claimed.job_id).toBe("job-probe");
      expect(claimed.attempt).toBe(1);
      expect(claimed.token).toMatch(/^[0-9a-f]{64}$/);
      /* Everything needed to run it travels with it: the worker reads no
         database, so a source it cannot resolve is a protocol failure. */
      expect(claimed.request).toMatchObject({
        job_id: "job-probe",
        kind: "probe",
        source_key: "originals/picture.mov",
        source_path: "/blobs/originals/picture.mov",
      });
      /* And a way to reach those bytes without the volume: the worker uses
         the path when the file is really there and this when it is not. */
      expect(claimed.request.source_url).toMatch(
        /^\/api\/v1\/worker\/blobs\/originals\/picture\.mov\?job=job-probe&attempt=1&token=[0-9a-f]{64}$/,
      );
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

/* The source route exists for a worker that mounts nothing: on the Workers
   target there is no shared volume, and the only way to the bytes is a URL the
   claim signed. */
describe("the source a claim hands out", () => {
  const SOURCE_KEY = "originals/picture.mov";

  it("serves the whole object to the attempt it was signed for", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = routes(db, storeOf({ [SOURCE_KEY]: 1024 }));
      const claimed = await claimJob(app, "w-1");
      const url = claimed.request.source_url as string;
      const served = await app.request(url);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-length")).toBe("1024");
      expect((await served.arrayBuffer()).byteLength).toBe(1024);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a signature that is not for this key", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = routes(
        db,
        storeOf({ [SOURCE_KEY]: 1024, "originals/other.mov": 8 }),
      );
      const claimed = await claimJob(app, "w-1");
      const url = new URL(
        claimed.request.source_url as string,
        "http://server",
      );
      /* The same token, pointed at another object. It is an HMAC over the key
         as well as the job, so it does not travel. */
      const elsewhere = await app.request(
        `/api/v1/worker/blobs/originals/other.mov${url.search}`,
      );
      expect(elsewhere.status).toBe(401);
      const tampered = await app.request(
        `/api/v1/worker/blobs/${SOURCE_KEY}?job=job-probe&attempt=1&token=${"0".repeat(64)}`,
      );
      expect(tampered.status).toBe(401);
    } finally {
      sqlite.close();
    }
  });

  it("stops working once the attempt is over", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = routes(db, storeOf({ [SOURCE_KEY]: 1024 }));
      const claimed = await claimJob(app, "w-1");
      const url = claimed.request.source_url as string;
      expect((await app.request(url)).status).toBe(200);
      /* The lease went to somebody else: the URL a worker was handed is
         authority over an attempt, and this one is no longer running. */
      await db
        .update(jobs)
        .set({ status: "queued", attempts: 2 })
        .where(eq(jobs.id, "job-probe"))
        .run();
      expect((await app.request(url)).status).toBe(409);
    } finally {
      sqlite.close();
    }
  });

  it("is a 404 when the store does not hold it", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const missing = await app.request(claimed.request.source_url as string);
      expect(missing.status).toBe(404);
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
      const app = routes(db);
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
      const app = routes(db);
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
      const app = routes(db);
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
      const app = routes(db);
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
      const app = routes(db);
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
      const app = routes(db);
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
                {
                  kind: "proxy_1080",
                  key: "/etc/shadow",
                  size: 10,
                  sha256: "a".repeat(64),
                  meta: {},
                },
              ],
              failures: [],
            },
          }),
        },
      );
      expect(escaped.status).toBe(422);
      expect((await escaped.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining(
          "outside renditions/version-1/",
        ) as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
      // And the job is failed rather than left leased on a worker that lied.
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-transcode")).all()
      )[0];
      expect(row?.status).toBe("queued");
      expect(row?.error).toContain("outside renditions/version-1/");
    } finally {
      sqlite.close();
    }
  });

  it("is refused when the body is larger than any report could be", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      const app = routes(db);
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
      const app = routes(db);
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

const queueTranscode = async (db: ReturnType<typeof createNodeDb>["db"]) => {
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
};

const PROXY_KEY = "renditions/version-1/proxy_1080.mp4";
const DIGEST = "b".repeat(64);

const complete = async (
  app: ReturnType<typeof createWorkerRoutes>,
  claimed: ClaimResponse,
  reported: Array<Record<string, unknown>>,
  workerId = "w-1",
): Promise<Response> =>
  app.request(`/api/v1/worker/jobs/${claimed.job_id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      worker_id: workerId,
      attempt: claimed.attempt,
      token: claimed.token,
      result: { renditions: reported, failures: [] },
    }),
  });

/* The inversion audit item 2 asks for, tested from both sides: the worker is
   the process that saw the bytes, so it reports the length and the checksum,
   and the server binds that report to what storage actually holds instead of
   opening the file itself. Under R2 there is no file for it to open. */
describe("a completion that reports what was written", () => {
  it("records the length and the checksum the worker reported", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ [PROXY_KEY]: 4096 }));
      const claimed = await claimJob(app, "w-1");
      const accepted = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: 4096,
          sha256: DIGEST,
          meta: {},
        },
      ]);
      expect(accepted.status).toBe(200);
      const [row] = await db.select().from(renditions).all();
      expect(row).toMatchObject({
        kind: "proxy_1080",
        blobKey: PROXY_KEY,
        size: 4096,
        checksumSha256: DIGEST,
      });
      /* And the job really ran to its end, rather than being accepted and
         quietly doing nothing: the version is ready. */
      const version = (
        await db
          .select()
          .from(assetVersions)
          .where(eq(assetVersions.id, "version-1"))
          .all()
      )[0];
      expect(version?.transcodeStatus).toBe("ready");
    } finally {
      sqlite.close();
    }
  });

  it("is refused when the store does not hold what was reported", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const refused = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: 4096,
          sha256: DIGEST,
          meta: {},
        },
      ]);
      expect(refused.status).toBe(422);
      expect((await refused.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining(
          "which the store does not hold",
        ) as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
      /* Queued, not dead: a report the server could not accept is a job
         another worker gets to run again. */
      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-transcode")).all()
      )[0];
      expect(row?.status).toBe("queued");
    } finally {
      sqlite.close();
    }
  });

  it("is refused when the reported length disagrees with the stored object", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ [PROXY_KEY]: 11 }));
      const claimed = await claimJob(app, "w-1");
      const refused = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: 4096,
          sha256: DIGEST,
          meta: {},
        },
      ]);
      expect(refused.status).toBe(422);
      expect((await refused.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("but the store holds 11") as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("is refused when there is no usable checksum", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ [PROXY_KEY]: 4096 }));
      const claimed = await claimJob(app, "w-1");
      const noDigest = await complete(app, claimed, [
        { kind: "proxy_1080", key: PROXY_KEY, size: 4096, meta: {} },
      ]);
      expect(noDigest.status).toBe(422);
      expect((await noDigest.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("no usable sha256") as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("is refused when there is no usable length", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ [PROXY_KEY]: 4096 }));
      const claimed = await claimJob(app, "w-1");
      const noSize = await complete(app, claimed, [
        { kind: "proxy_1080", key: PROXY_KEY, sha256: DIGEST, meta: {} },
      ]);
      expect(noSize.status).toBe(422);
      expect((await noSize.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("no usable size") as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("checks the sprite's cue sheet the same way as the sprite", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    const spriteKey = "renditions/version-1/sprite.png";
    const vttKey = "renditions/version-1/sprite.vtt";
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(
        db,
        storeOf({ [PROXY_KEY]: 4096, [spriteKey]: 2048, [vttKey]: 96 }),
      );
      const claimed = await claimJob(app, "w-1");
      const accepted = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: 4096,
          sha256: DIGEST,
          meta: {},
        },
        {
          kind: "sprite",
          key: spriteKey,
          size: 2048,
          sha256: DIGEST,
          meta: { vtt_key: vttKey, vtt_size: 96 },
        },
      ]);
      expect(accepted.status).toBe(200);
      const sprite = (
        await db
          .select()
          .from(renditions)
          .where(eq(renditions.kind, "sprite"))
          .all()
      )[0];
      expect(JSON.parse(sprite?.metaJson ?? "{}")).toMatchObject({
        vtt_blob_key: vttKey,
        vtt_size: 96,
      });
    } finally {
      sqlite.close();
    }
  });

  /* A worker old enough to answer with the path it wrote to would otherwise
     lose its cue sheet quietly, and hover scrub with it. */
  it("refuses a cue sheet reported as a path", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    const spriteKey = "renditions/version-1/sprite.png";
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ [spriteKey]: 2048 }));
      const claimed = await claimJob(app, "w-1");
      const refused = await complete(app, claimed, [
        {
          kind: "sprite",
          key: spriteKey,
          size: 2048,
          sha256: DIGEST,
          meta: { vtt_path: "/blobs/renditions/version-1/sprite.vtt" },
        },
      ]);
      expect(refused.status).toBe(422);
      expect((await refused.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining(
          "expects vtt_key and vtt_size",
        ) as string,
      });
      expect(await db.select().from(renditions).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("skips an output the worker reported as empty and keeps the rest", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ [PROXY_KEY]: 4096 }));
      const claimed = await claimJob(app, "w-1");
      /* ffmpeg can exit 0 with an empty poster on a degenerate source. The
         store is never asked about it, because a 0-byte output is not a
         rendition and registering it would leave a broken blob behind. */
      const accepted = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: 4096,
          sha256: DIGEST,
          meta: {},
        },
        {
          kind: "poster",
          key: "renditions/version-1/poster.png",
          size: 0,
          sha256: DIGEST,
          meta: {},
        },
      ]);
      expect(accepted.status).toBe(200);
      const rows = await db.select().from(renditions).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("proxy_1080");
    } finally {
      sqlite.close();
    }
  });
});
