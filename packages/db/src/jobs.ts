import { and, asc, desc, eq, lte, lt, or, sql } from "drizzle-orm";
import { jobs } from "./schema.js";
import type { AppDb } from "./client.js";

interface CapabilityPayload {
  requires?: string[];
}

const canRun = (
  job: typeof jobs.$inferSelect,
  capabilities: Set<string>,
): boolean => {
  try {
    const payload = JSON.parse(job.capabilityJson) as CapabilityPayload;
    return (payload.requires ?? []).every((capability) =>
      capabilities.has(capability),
    );
  } catch {
    return false;
  }
};

export const claimNextJob = async (
  db: AppDb,
  now: number,
  workerId: string,
  capabilities: string[] = [],
  leaseMs = 60_000,
): Promise<typeof jobs.$inferSelect | undefined> => {
  const available = await db
    .select()
    .from(jobs)
    .where(
      and(
        lte(jobs.runAfter, now),
        or(
          eq(jobs.status, "queued"),
          and(eq(jobs.status, "processing"), lt(jobs.leaseExpiresAt, now)),
        ),
      ),
    )
    .orderBy(desc(jobs.priority), asc(jobs.runAfter), asc(jobs.id))
    .limit(50)
    .all();
  const capabilitySet = new Set(capabilities);
  for (const candidate of available) {
    if (!canRun(candidate, capabilitySet)) continue;
    // The WHERE clause repeats every claimability predicate and the SET
    // clause derives attempts and started_at in the database, so a claim
    // that races another worker either matches zero rows or applies a
    // correct increment. Nothing is written from the stale SELECT above.
    await db
      .update(jobs)
      .set({
        status: "processing",
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: sql`COALESCE(${jobs.startedAt}, ${now})`,
        heartbeatAt: now,
        leaseExpiresAt: now + leaseMs,
        workerId,
        error: null,
      })
      .where(
        and(
          eq(jobs.id, candidate.id),
          lte(jobs.runAfter, now),
          or(
            eq(jobs.status, "queued"),
            and(eq(jobs.status, "processing"), lt(jobs.leaseExpiresAt, now)),
          ),
        ),
      )
      .run();
    const claimed = (
      await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, candidate.id),
            eq(jobs.status, "processing"),
            eq(jobs.workerId, workerId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (claimed) return claimed;
  }
  return undefined;
};

export const heartbeatJob = async (
  db: AppDb,
  jobId: string,
  workerId: string,
  now: number,
  leaseMs = 60_000,
): Promise<boolean> => {
  await db
    .update(jobs)
    .set({ heartbeatAt: now, leaseExpiresAt: now + leaseMs })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.status, "processing"),
      ),
    )
    .run();
  return Boolean(
    (
      await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.workerId, workerId),
            eq(jobs.status, "processing"),
          ),
        )
        .limit(1)
        .all()
    ).length,
  );
};

export const completeJob = async (
  db: AppDb,
  jobId: string,
  workerId: string,
  now: number,
): Promise<void> => {
  await db
    .update(jobs)
    .set({
      status: "complete",
      finishedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.status, "processing"),
      ),
    )
    .run();
};

export const failJob = async (
  db: AppDb,
  jobId: string,
  workerId: string,
  now: number,
  message: string,
  retryAfterMs = 0,
): Promise<void> => {
  // Single conditional UPDATE: the worker_id and status guard stops a worker
  // whose lease expired from clobbering another worker's live claim, and the
  // dead versus queued decision reads attempts in the same statement instead
  // of from an earlier SELECT.
  await db
    .update(jobs)
    .set({
      status: sql`CASE WHEN ${jobs.attempts} >= ${jobs.maxAttempts} THEN 'dead' ELSE 'queued' END`,
      runAfter: now + retryAfterMs,
      error: message,
      finishedAt: sql`CASE WHEN ${jobs.attempts} >= ${jobs.maxAttempts} THEN ${now} ELSE NULL END`,
      heartbeatAt: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.workerId, workerId),
        eq(jobs.status, "processing"),
      ),
    )
    .run();
};
