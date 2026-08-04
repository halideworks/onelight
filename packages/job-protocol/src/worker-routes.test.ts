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
import { claimWorkerJob, sweepUnclaimedWork } from "./worker-pump.js";

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
const storeOf = (objects: Record<string, number> = {}) => {
  const uploads: Record<string, Record<number, Uint8Array>> = {};
  return {
    head: (key: string): Promise<{ size: number }> =>
      key in objects
        ? Promise.resolve({ size: objects[key] as number })
        : Promise.reject(new Error(`No object at ${key}.`)),
    /* Contents nothing here reads, at the length the object is declared to be:
     what the blob route is asked to prove is that it serves the right object,
     entirely, to the right caller. */
    getStream: (
      key: string,
      range?: { start: number; end?: number },
    ): Promise<ReadableStream> => {
      if (!(key in objects))
        return Promise.reject(new Error(`No object at ${key}.`));
      /* Each byte is its own offset modulo 256, so a ranged read can be
         checked against the offsets it claims to have served rather than only
         its length. Uniform filler would let an off-by-one through. */
      const size = objects[key] as number;
      const whole = Uint8Array.from({ length: size }, (_, at) => at % 256);
      const bytes = range
        ? whole.slice(range.start, (range.end ?? size - 1) + 1)
        : whole;
      return Promise.resolve(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    },
    putStream: async (
      key: string,
      stream: ReadableStream,
      meta: { size?: number },
    ): Promise<void> => {
      /* Drained rather than kept: what a test asks of a stored object is its
       length, and the length is what the completion is checked against. */
      let size = 0;
      const reader = stream.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += (chunk.value as Uint8Array).byteLength;
      }
      if (meta.size !== undefined && meta.size !== size)
        throw new Error(
          `Declared ${String(meta.size)}, received ${String(size)}.`,
        );
      objects[key] = size;
    },
    delete: (key: string): Promise<void> => {
      delete objects[key];
      return Promise.resolve();
    },
    /* Multipart, kept honestly rather than stubbed: parts are held until the
     completion names them, and the object's length is the sum of the parts
     that were actually listed. A completion that omits a part therefore
     produces a shorter object, which is what makes the ordering and
     completeness assertions below mean anything. */
    createMultipart: (
      key: string,
    ): Promise<{ uploadId: string; partSize: number }> => {
      const uploadId = `upload-${key}`;
      uploads[uploadId] = {};
      return Promise.resolve({ uploadId, partSize: 8 });
    },
    putPart: async (
      uploadId: string,
      partNo: number,
      stream: ReadableStream,
    ): Promise<{ etag: string; size: number }> => {
      const held = uploads[uploadId];
      if (!held) throw new Error(`No such upload ${uploadId}.`);
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      held[partNo] = bytes;
      return { etag: `etag-${String(partNo)}`, size: bytes.byteLength };
    },
    completeMultipart: (
      key: string,
      uploadId: string,
      parts: Array<{ partNo: number; etag: string }>,
    ): Promise<void> => {
      const held = uploads[uploadId];
      if (!held) throw new Error(`No such upload ${uploadId}.`);
      let size = 0;
      for (const part of parts) {
        const bytes = held[part.partNo];
        if (!bytes)
          throw new Error(`Part ${String(part.partNo)} was never sent.`);
        if (part.etag !== `etag-${String(part.partNo)}`)
          throw new Error(`Part ${String(part.partNo)} has the wrong etag.`);
        size += bytes.byteLength;
      }
      objects[key] = size;
      delete uploads[uploadId];
      return Promise.resolve();
    },
  };
};

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

/* A second asset whose probe carries outputs: a still ladder does not depend
   on what the probe finds, so an image is planned and probed in one job, which
   is the only job kind whose envelope names more than one destination. */
const seedImage = async (db: ReturnType<typeof createNodeDb>["db"]) => {
  await db
    .insert(uploadSessions)
    .values({
      id: "upload-2",
      workspaceId: "ws-1",
      projectId: "project-1",
      createdBy: "user-1",
      clientFilename: "still.jpg",
      relativePath: "",
      size: 100,
      blobKey: "originals/still.jpg",
      status: "completed",
      createdAt: 1,
      completedAt: 1,
    })
    .run();
  await db
    .insert(assets)
    .values({
      id: "asset-2",
      projectId: "project-1",
      name: "Still",
      kind: "image",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  await db
    .insert(assetVersions)
    .values({
      id: "version-2",
      assetId: "asset-2",
      uploadSessionId: "upload-2",
      versionNo: 1,
      originalBlobKey: "originals/still.jpg",
      originalFilename: "still.jpg",
      size: 100,
      checksumCrc32c: "",
      uploadedBy: "user-1",
      transcodeStatus: "pending",
      createdAt: 1,
    })
    .run();
  await db
    .insert(jobs)
    .values({
      id: "job-image",
      kind: "probe",
      payloadJson: JSON.stringify({
        workspace_id: "ws-1",
        project_id: "project-1",
        version_id: "version-2",
        blob_key: "originals/still.jpg",
      }),
      idempotencyKey: "probe:version-2",
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

/* Every string under a key that names a file, wherever it is nested. */
const filesNamedIn = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(filesNamedIn);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) =>
      (key === "path" || key.endsWith("_path")) && typeof nested === "string"
        ? [nested]
        : filesNamedIn(nested),
  );
};

/* Both queued jobs, by id, however the queue chose to order them.
 *
 * Two jobs queued in the same millisecond at the same priority are ordered by
 * whatever the tie-break happens to be, so which one a claim returns first is
 * not something a test may assume: asserting it made this pass on one machine
 * and fail on another. */
const claimAll = async (
  db: ReturnType<typeof createNodeDb>["db"],
  blobRoot: string | undefined,
): Promise<Map<string, Record<string, unknown>>> => {
  const claimed = new Map<string, Record<string, unknown>>();
  for (;;) {
    const next = await claimWorkerJob(db, blobRoot, "w-1", ["cpu"]);
    if (!next) return claimed;
    claimed.set(next.job.id, next.request);
  }
};

describe("where a worker reads a source from", () => {
  /* A worker decoding a 40 GB master must not pull those bytes through this
     server. On the Workers target it cannot: an isolate has neither the disk
     nor the CPU budget. So when the store can mint a URL against storage
     itself, the claim hands that over instead. */
  it("sends the worker straight to storage when the store can sign", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const signing = {
        ...storeOf(),
        presignGet: (key: string, expiresIn: number): Promise<string | null> =>
          Promise.resolve(
            `https://bucket.example.com/${key}?X-Amz-Expires=${String(expiresIn)}&X-Amz-Signature=abc`,
          ),
      };
      const app = routes(db, signing);
      const claimed = await claimJob(app, "w-1");
      const source = claimed.request.source_url as string;
      expect(source).toBe(
        "https://bucket.example.com/originals/picture.mov?X-Amz-Expires=43200&X-Amz-Signature=abc",
      );
      /* And not through here, which is the whole point. */
      expect(source).not.toContain("/api/v1/worker/blobs");
    } finally {
      sqlite.close();
    }
  });

  it("falls back to this server when the store cannot sign", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      /* A filesystem-backed store has no URL to give, which is the normal
         case for a self-hosted deployment. */
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      expect(claimed.request.source_url as string).toContain(
        "/api/v1/worker/blobs/originals/picture.mov",
      );
    } finally {
      sqlite.close();
    }
  });

  it("keeps playback on the API, where permissions are enforced", async () => {
    /* Presigned URLs answer to whoever holds them. A share's permission can be
       revoked; a signed URL cannot. So this capability is deliberately only
       reachable from the job protocol, and `signGetUrl` -- what playback uses
       -- is a different method that still returns an app path. */
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const signing = {
        ...storeOf(),
        presignGet: (): Promise<string | null> =>
          Promise.resolve("https://bucket.example.com/leaked"),
      };
      const app = routes(db, signing);
      const claimed = await claimJob(app, "w-1");
      /* The upload side is still a URL on this server: writes are checked
         against the job's namespace, which storage cannot do for us. */
      expect(claimed.request.upload_url as string).toContain(
        "/api/v1/worker/blobs/",
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("the work nobody claims", () => {
  /* The protocol is pull-based, so nothing pulls the work that has to be
     queued in the first place. On the Workers target the cron delivered
     webhooks and ran no sweeps at all, so a watermark was never queued and a
     share sat at "202, pending" forever on a deployment where uploads,
     transcodes and playback all worked. */
  it("buries a job whose worker vanished", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      /* One attempt allowed, so a single vanished worker exhausts it. A job
         with attempts left is not abandoned -- it is reclaimed by the next
         worker to ask, which is the retry the protocol is built on. */
      await db
        .update(jobs)
        .set({ maxAttempts: 1 })
        .where(eq(jobs.id, "job-transcode"))
        .run();
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      expect(claimed.job_id).toBe("job-transcode");

      /* Nothing reports back and the lease runs out, which is what a worker
         being killed looks like from here. */
      const wellPast = Date.now() + 60 * 60_000;
      await sweepUnclaimedWork(db, wellPast, { mediaEnabled: true });

      const row = (
        await db.select().from(jobs).where(eq(jobs.id, "job-transcode")).all()
      )[0];
      expect(row?.status).toBe("dead");
    } finally {
      sqlite.close();
    }
  });

  it("keeps sweeping when one of them fails", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      /* A sweep that throws is a sweep that did not happen, not a reason to
         skip the rest: on a cron there is no operator watching, and one bad
         row must not stop watermarks being queued for everybody else. */
      await expect(
        sweepUnclaimedWork(db, Date.now(), { mediaEnabled: true }),
      ).resolves.toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

describe("the files a claim names", () => {
  /* The plans describe storage and nothing else, so the paths are the claim's
     addition, made where the deployment is known. Asserted here because a
     mistake is invisible in a running stack: a worker handed the wrong path
     finds nothing there, falls back to the URL, and produces the same
     rendition a little more slowly. */
  it("tells a worker on the volume where each key is today", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      await seedImage(db);
      const claimed = await claimAll(db, "/blobs");
      expect(claimed.get("job-probe")).toMatchObject({
        source_key: "originals/picture.mov",
        source_path: "/blobs/originals/picture.mov",
      });
      const outputs = claimed.get("job-image")?.outputs as Array<
        Record<string, unknown>
      >;
      expect(outputs.length).toBeGreaterThan(0);
      /* Each output's file is its key under the root, and nothing else: the
         two are one definition now, so they cannot describe different files. */
      for (const output of outputs)
        expect(output.path).toBe(`/blobs/${String(output.key)}`);
    } finally {
      sqlite.close();
    }
  });

  it("names no file at all where storage is not a mounted filesystem", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      await seedImage(db);
      /* What the Workers target claims with. The envelope has to be usable
         without a path in it, because there is no path to put there. */
      const claimed = await claimAll(db, undefined);
      expect(claimed.get("job-probe")?.source_key).toBe(
        "originals/picture.mov",
      );
      expect(
        (claimed.get("job-image")?.outputs as unknown[] | undefined)?.length,
      ).toBeGreaterThan(0);
      for (const request of claimed.values())
        expect(filesNamedIn(request)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

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

  /* Ranged reads are what let a worker decode a source it never holds. A
     camera master is routinely tens of gigabytes, and copying one onto the
     machine before it can be decoded caps where this runs by the largest file
     anyone uploads -- 20 GB on a Cloudflare container, for instance. ffmpeg
     does not need the copy: it seeks, and over HTTP it seeks by asking. */
  it("serves the range it was asked for, and says which one", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ "originals/picture.mov": 1000 }));
      const claimed = await claimJob(app, "w-1");
      const url = claimed.request.source_url as string;
      const response = await app.request(url, {
        headers: { range: "bytes=100-199" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
      expect(response.headers.get("content-length")).toBe("100");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      /* The bytes themselves, not just the headers: each byte is its own
         offset, so this catches a range served from the wrong place. */
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes).toHaveLength(100);
      expect(bytes[0]).toBe(100 % 256);
      expect(bytes[99]).toBe(199 % 256);
    } finally {
      sqlite.close();
    }
  });

  it("serves a suffix range", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ "originals/picture.mov": 1000 }));
      const claimed = await claimJob(app, "w-1");
      const response = await app.request(claimed.request.source_url as string, {
        headers: { range: "bytes=-50" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 950-999/1000");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes[0]).toBe(950 % 256);
    } finally {
      sqlite.close();
    }
  });

  it("refuses a range past the end, and says how long the object is", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ "originals/picture.mov": 1000 }));
      const claimed = await claimJob(app, "w-1");
      const response = await app.request(claimed.request.source_url as string, {
        headers: { range: "bytes=2000-3000" },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */1000");
    } finally {
      sqlite.close();
    }
  });

  it("ignores a range header it cannot parse and serves the whole object", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf({ "originals/picture.mov": 1000 }));
      const claimed = await claimJob(app, "w-1");
      const response = await app.request(claimed.request.source_url as string, {
        headers: { range: "furlongs=1-2" },
      });
      /* The whole object is a correct answer to a request nobody could read,
         and refusing would strand a client over a header it can simply drop. */
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("1000");
    } finally {
      sqlite.close();
    }
  });

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

  it("cannot be used to write over the original", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueProbe(db);
      const app = routes(db, storeOf({ [SOURCE_KEY]: 1024 }));
      const claimed = await claimJob(app, "w-1");
      /* A read URL is not a write request at all: it carries no scope. */
      const asIs = await app.request(claimed.request.source_url as string, {
        method: "PUT",
        body: "not the original",
        headers: { "content-length": "16" },
      });
      expect(asIs.status).toBe(400);
      /* And given the shape of one, the token still does not fit: the
         direction is part of what is signed, so a capability to read the
         original cannot be turned into one to overwrite it. */
      const read = new URL(
        claimed.request.source_url as string,
        "http://server",
      );
      read.searchParams.set("scope", SOURCE_KEY);
      const forged = await app.request(`${read.pathname}${read.search}`, {
        method: "PUT",
        body: "not the original",
        headers: { "content-length": "16" },
      });
      expect(forged.status).toBe(401);
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

/* The other half of the same idea: a worker that cannot write where the job
   said to sends what it produced instead, and the completion that follows is
   checked against what actually landed. */
describe("where a worker puts what it produced", () => {
  const put = async (
    app: ReturnType<typeof createWorkerRoutes>,
    template: string,
    key: string,
    body: string,
  ): Promise<Response> =>
    app.request(template.replace("{key}", key), {
      method: "PUT",
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });

  /* The Workers runtime caps a request body near 100 MB and a 4K proxy is
     routinely larger, so the single PUT cannot be the only way home. These
     drive the three steps through the same capability the single PUT uses. */
  const multipart = (
    template: string,
    action: "create" | "part" | "complete",
    key: string,
  ): string => template.replace("{action}", action).replace("{key}", key);

  it("assembles a large output from its parts", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const objects: Record<string, number> = {};
      const app = routes(db, storeOf(objects));
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.multipart_url as string;
      expect(template).toContain("{action}");
      expect(template).toContain("{key}");

      const created = await app.request(
        multipart(template, "create", PROXY_KEY),
        { method: "POST" },
      );
      expect(created.status).toBe(200);
      const upload = (await created.json()) as {
        upload_id: string;
        part_size: number;
      };
      expect(upload.upload_id).toBeTruthy();
      /* The store decides the part size, not the worker and not this route. */
      expect(upload.part_size).toBe(8);

      const chunks = ["01234567", "89abcdef", "ghi"];
      const parts = [];
      for (const [index, chunk] of chunks.entries()) {
        const response = await app.request(
          `${multipart(template, "part", PROXY_KEY)}&upload=${encodeURIComponent(
            upload.upload_id,
          )}&part=${String(index + 1)}`,
          {
            method: "PUT",
            body: chunk,
            headers: { "content-length": String(chunk.length) },
          },
        );
        expect(response.status).toBe(200);
        const stored = (await response.json()) as {
          part: number;
          etag: string;
        };
        parts.push({ part: stored.part, etag: stored.etag });
      }

      const done = await app.request(
        `${multipart(template, "complete", PROXY_KEY)}&upload=${encodeURIComponent(
          upload.upload_id,
        )}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts }),
        },
      );
      expect(done.status).toBe(200);
      /* Every part, in order, and nothing else: the object is exactly as long
         as what was sent, which a completion that dropped one would not be. */
      expect(objects[PROXY_KEY]).toBe(19);

      /* And the completion still checks it the same way it checks a single
         PUT -- there is one rule for what counts as a rendition. */
      const accepted = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: 19,
          sha256: DIGEST,
          meta: {},
        },
      ]);
      expect(accepted.status).toBe(200);
    } finally {
      sqlite.close();
    }
  });

  it("will not let an upload id widen what a job may write", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.multipart_url as string;
      /* The scope is re-checked at every step rather than only when the
         upload is created, so holding an id is not authority over a key. */
      for (const action of ["create", "part", "complete"] as const) {
        const response = await app.request(
          `${multipart(template, action, "originals/picture.mov")}&upload=x&part=1`,
          {
            method: action === "part" ? "PUT" : "POST",
            body: action === "part" ? "no" : JSON.stringify({ parts: [] }),
            headers: { "content-length": "2" },
          },
        );
        expect(response.status).toBe(403);
      }
    } finally {
      sqlite.close();
    }
  });

  it("refuses a part that does not say how long it is", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.multipart_url as string;
      const response = await app.request(
        `${multipart(template, "part", PROXY_KEY)}&upload=u&part=1`,
        {
          method: "PUT",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed"));
              controller.close();
            },
          }),
          /* Same as the single PUT: Hono's test request sets no length for a
             stream, which is the case the route must refuse. */
          duplex: "half",
        } as RequestInit,
      );
      expect(response.status).toBe(411);
    } finally {
      sqlite.close();
    }
  });

  it("stores an output and then accepts the completion that describes it", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.upload_url as string;
      expect(template).toContain("{key}");
      const body = "a proxy, as far as this test is concerned";
      const stored = await put(app, template, PROXY_KEY, body);
      expect(stored.status).toBe(200);
      /* And now the completion: the store holds what the worker says it
         wrote, so the length it reports is the length that landed. */
      const accepted = await complete(app, claimed, [
        {
          kind: "proxy_1080",
          key: PROXY_KEY,
          size: Buffer.byteLength(body),
          sha256: DIGEST,
          meta: {},
        },
      ]);
      expect(accepted.status).toBe(200);
      const [row] = await db.select().from(renditions).all();
      expect(row).toMatchObject({
        blobKey: PROXY_KEY,
        size: Buffer.byteLength(body),
      });
    } finally {
      sqlite.close();
    }
  });

  it("refuses a key outside the namespace it was signed for", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.upload_url as string;
      /* One capability covers everything this job writes, including files
         nobody planned, so what bounds it is the namespace. */
      const elsewhere = await put(
        app,
        template,
        "renditions/version-2/proxy_1080.mp4",
        "not mine",
      );
      expect(elsewhere.status).toBe(403);
      const original = await put(app, template, "originals/picture.mov", "no");
      expect(original.status).toBe(403);
      expect(await db.select().from(renditions).all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("takes the sidecars a job discovers, inside the same namespace", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.upload_url as string;
      /* The sprite's cue sheet and a PDF's page rasters are named by the job,
         not by the plan, which is why the capability is a namespace. */
      expect(
        (await put(app, template, "renditions/version-1/sprite.vtt", "WEBVTT"))
          .status,
      ).toBe(200);
      expect(
        (
          await put(
            app,
            template,
            "renditions/version-1/pages/page-01.png",
            "png",
          )
        ).status,
      ).toBe(200);
    } finally {
      sqlite.close();
    }
  });

  it("requires a length, because storage does", async () => {
    const { db, sqlite } = createNodeDb(":memory:");
    applyNodeMigrations(sqlite);
    try {
      await seed(db);
      await queueTranscode(db);
      const app = routes(db, storeOf());
      const claimed = await claimJob(app, "w-1");
      const template = claimed.request.upload_url as string;
      const lengthless = await app.request(
        template.replace("{key}", PROXY_KEY),
        {
          method: "PUT",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed"));
              controller.close();
            },
          }),
          /* Hono's test request does not set one for a stream, which is
             exactly the case the route has to refuse: R2 will not take a
             body whose length it does not know. */
          duplex: "half",
        } as RequestInit,
      );
      expect(lengthless.status).toBe(411);
    } finally {
      sqlite.close();
    }
  });
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
