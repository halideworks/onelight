import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Database from "better-sqlite3";
import {
  applyNodeMigrations,
  createNodeDb,
  jobs,
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  reapAbandonedJobs,
} from "./index.js";
import type { AppDb } from "./index.js";

const openDb = (): { db: AppDb; sqlite: Database.Database } => {
  const { db, sqlite } = createNodeDb(":memory:");
  applyNodeMigrations(sqlite);
  return { db, sqlite };
};

const seedJob = async (
  db: AppDb,
  overrides: Partial<typeof jobs.$inferInsert> = {},
): Promise<string> => {
  const id = overrides.id ?? "01J00000000000000000000003";
  await db
    .insert(jobs)
    .values({
      id,
      kind: "probe",
      payloadJson: "{}",
      idempotencyKey: `probe:${id}`,
      status: "queued",
      priority: 10,
      capabilityJson: "{}",
      maxAttempts: 5,
      attempts: 0,
      runAfter: 1,
      createdAt: 1,
      startedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      finishedAt: null,
      error: null,
      workerId: null,
      ...overrides,
    })
    .run();
  return id;
};

const readJob = async (
  db: AppDb,
  id: string,
): Promise<typeof jobs.$inferSelect> => {
  const row = (
    await db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all()
  )[0];
  if (!row) throw new Error(`job ${id} missing`);
  return row;
};

describe("job leases", () => {
  it("claims, renews, completes, and dead-letters after max attempts", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db, { maxAttempts: 1 });
    const claimed = await claimNextJob(db, 10, "worker-a");
    expect(claimed?.status).toBe("processing");
    expect(claimed?.attempts).toBe(1);
    expect(await heartbeatJob(db, id, "worker-a", 20)).toBe(true);
    await failJob(db, id, "worker-a", 30, "fixture failed");
    const dead = await readJob(db, id);
    expect(dead.status).toBe("dead");
    expect(dead.error).toBe("fixture failed");
    expect(dead.finishedAt).toBe(30);
    await completeJob(db, id, "worker-a", 40);
    expect((await readJob(db, id)).status).toBe("dead");
    sqlite.close();
  });

  it("lets exactly one of two claimers win the same job", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db);
    const [first, second] = [
      await claimNextJob(db, 10, "worker-a"),
      await claimNextJob(db, 10, "worker-b"),
    ];
    expect(first?.id).toBe(id);
    expect(second).toBeUndefined();
    const row = await readJob(db, id);
    expect(row.workerId).toBe("worker-a");
    expect(row.attempts).toBe(1);
    sqlite.close();
  });

  it("reclaims after lease expiry with an in-database attempts increment and fences the old worker", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db);
    const first = await claimNextJob(db, 10, "worker-a", [], 1_000);
    expect(first?.attempts).toBe(1);
    // Lease still live: no reclaim.
    expect(await claimNextJob(db, 500, "worker-b", [], 1_000)).toBeUndefined();
    // Lease expired: worker-b takes over and the increment is applied to the
    // stored attempts value, not a stale snapshot.
    const second = await claimNextJob(db, 2_000, "worker-b", [], 1_000);
    expect(second?.workerId).toBe("worker-b");
    expect(second?.attempts).toBe(2);
    expect(second?.startedAt).toBe(10);
    // The old worker can no longer heartbeat, complete, or fail the job.
    expect(await heartbeatJob(db, id, "worker-a", 2_100)).toBe(false);
    await completeJob(db, id, "worker-a", 2_200);
    expect((await readJob(db, id)).status).toBe("processing");
    await failJob(db, id, "worker-a", 2_300, "stale worker");
    const row = await readJob(db, id);
    expect(row.status).toBe("processing");
    expect(row.workerId).toBe("worker-b");
    expect(row.error).toBeNull();
    await completeJob(db, id, "worker-b", 2_400);
    expect((await readJob(db, id)).status).toBe("complete");
    sqlite.close();
  });

  it("respects run_after backoff set by failJob", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db);
    const claimed = await claimNextJob(db, 10, "worker-a");
    expect(claimed?.id).toBe(id);
    await failJob(db, id, "worker-a", 100, "transient", 5_000);
    const row = await readJob(db, id);
    expect(row.status).toBe("queued");
    expect(row.runAfter).toBe(5_100);
    expect(await claimNextJob(db, 4_000, "worker-b")).toBeUndefined();
    const reclaimed = await claimNextJob(db, 6_000, "worker-b");
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(2);
    sqlite.close();
  });

  it("dead-letters after exactly max_attempts claim and fail cycles", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db, { maxAttempts: 3 });
    let now = 10;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const claimed = await claimNextJob(db, now, `worker-${String(cycle)}`);
      expect(claimed?.attempts).toBe(cycle);
      await failJob(db, id, `worker-${String(cycle)}`, now + 1, "boom");
      const row = await readJob(db, id);
      expect(row.status).toBe(cycle < 3 ? "queued" : "dead");
      now += 100;
    }
    const dead = await readJob(db, id);
    expect(dead.attempts).toBe(3);
    expect(dead.finishedAt).toBe(211);
    expect(await claimNextJob(db, now, "worker-x")).toBeUndefined();
    sqlite.close();
  });

  it("skips jobs whose capabilities are not offered", async () => {
    const { db, sqlite } = openDb();
    await seedJob(db, {
      capabilityJson: JSON.stringify({ requires: ["ffmpeg"] }),
    });
    expect(await claimNextJob(db, 10, "worker-a")).toBeUndefined();
    const claimed = await claimNextJob(db, 10, "worker-a", ["ffmpeg"]);
    expect(claimed?.status).toBe("processing");
    sqlite.close();
  });
});

describe("a worker that vanishes", () => {
  /* Nothing fails a job whose worker disappeared: the lease expires and that
     is all that happens. Claiming has to be what stops it, or the job is
     handed out forever with attempts climbing past the ceiling. */
  it("stops being claimable once its attempts are spent", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db, { maxAttempts: 3 });
    // Each round starts after the previous lease has expired, which is the
    // only way an abandoned job becomes claimable again.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimNextJob(db, 100_000 * attempt, `w${attempt}`);
      expect(claimed?.id, `attempt ${attempt}`).toBe(id);
      expect(claimed?.attempts).toBe(attempt);
      // The worker vanishes: no completion, no failure, just an expired lease.
    }
    const beyond = await claimNextJob(db, 10_000_000, "w4");
    expect(beyond).toBeUndefined();
    const row = (
      await db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all()
    )[0];
    expect(row?.attempts).toBe(3);
    sqlite.close();
  });

  it("is buried rather than left processing forever", async () => {
    const { db, sqlite } = openDb();
    const id = await seedJob(db, { maxAttempts: 1 });
    await claimNextJob(db, 1_000, "gone");
    // Before the lease expires there is nothing to bury.
    expect(await reapAbandonedJobs(db, 1_100)).toEqual([]);
    const buried = await reapAbandonedJobs(db, 10_000_000);
    expect(buried.map((job) => job.id)).toEqual([id]);
    const row = (
      await db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all()
    )[0];
    expect(row?.status).toBe("dead");
    expect(row?.finishedAt).toBe(10_000_000);
    expect(row?.error).toMatch(/stopped reporting/);
    sqlite.close();
  });

  /* If a later burial throws, the ones already buried are `dead`, so a sweep
     selecting `processing` can never see them again. Losing them here means
     their versions stay pending forever. */
  it("still reports what it buried when a later one fails", async () => {
    const { db, sqlite } = openDb();
    const first = await seedJob(db, {
      id: "01J0000000000000000000000A",
      maxAttempts: 1,
    });
    await seedJob(db, { id: "01J0000000000000000000000B", maxAttempts: 1 });
    await claimNextJob(db, 1_000, "gone-1");
    await claimNextJob(db, 1_100, "gone-2");

    // Fail every update after the first one.
    const realUpdate = db.update.bind(db);
    let updates = 0;
    (db as unknown as { update: typeof db.update }).update = ((
      table: Parameters<typeof db.update>[0],
    ) => {
      updates += 1;
      if (updates > 1) throw new Error("database went away");
      return realUpdate(table);
    }) as typeof db.update;

    const buried = await reapAbandonedJobs(db, 10_000_000);
    (db as unknown as { update: typeof db.update }).update = realUpdate;

    // The one that landed is reported, so its version can be marked failed.
    expect(buried.map((job) => job.id)).toEqual([first]);
    // And the one that did not is still processing, so the next sweep retries.
    const rows = await db.select().from(jobs).all();
    expect(rows.find((row) => row.id === first)?.status).toBe("dead");
    expect(
      rows.find((row) => row.id === "01J0000000000000000000000B")?.status,
    ).toBe("processing");
    sqlite.close();
  });

  /* A job still inside its lease belongs to whoever holds it. */
  it("leaves a live claim alone", async () => {
    const { db, sqlite } = openDb();
    await seedJob(db, { maxAttempts: 1 });
    await claimNextJob(db, 1_000, "working");
    expect(await reapAbandonedJobs(db, 1_500)).toEqual([]);
    expect(await claimNextJob(db, 1_500, "other")).toBeUndefined();
    sqlite.close();
  });
});
