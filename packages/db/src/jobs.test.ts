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
