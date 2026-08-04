import { buryAbandonedJob, findAbandonedJobs } from "@onelight/db";
import type { AppDb } from "@onelight/db";
import {
  EXPORT_RECLAIM_STALE_MS,
  reclaimStuckExports,
  runDueExport,
} from "./comment-exports.js";
import type { ExportBlobStore } from "./comment-exports.js";
import {
  FINGERPRINT_SWEEP_INTERVAL_MS,
  markAbandonedVersionFailed,
  SHUTTLE_AUDIO_SWEEP_INTERVAL_MS,
  STACK_KEY_SWEEP_BATCH,
  STACK_KEY_SWEEP_INTERVAL_MS,
  STILL_LADDER_SWEEP_INTERVAL_MS,
  sweepFingerprints,
  sweepReKindStills,
  sweepShuttleAudioJobs,
  sweepStackKeys,
  sweepStillLadderJobs,
  sweepWatermarkJobs,
  WATERMARK_SWEEP_INTERVAL_MS,
} from "@onelight/job-protocol";

/* The node target's own loop.
 *
 * What it drives is deliberately not the job protocol: workers claim their own
 * work over HTTP now, so this ticks the things nobody claims -- the single
 * export slot, the reclaim pass for exports a crash left in `processing`, the
 * abandoned-job burial, and the sweeps that queue follow-up work.
 *
 * It lives apart from the protocol because it is the half that cannot leave
 * this process: it reads the filesystem through the exports, and a deployment
 * whose storage is an object store runs the same sweeps from a scheduled
 * handler instead. */

export const startWorkerPump = (
  db: AppDb,
  /* The store rather than a path: exports write their result through storage
     now, so this loop no longer needs to know where storage happens to be. */
  options: { workerSecret?: string; store: ExportBlobStore },
): (() => void) => {
  /* Exports are pure DB-to-file work, so the pump runs them whether or not
     any worker exists; media jobs are no longer run here at all. The server
     queues them, hands them out over /api/v1/worker, and writes down what
     comes back, so what this flag now gates is whether there is any point
     queueing them: without a secret no worker can claim, and the jobs would
     pile up behind a door nobody can open. */
  const mediaEnabled = Boolean(options.workerSecret);
  if (!mediaEnabled)
    console.warn(
      "[onelight] Media processing is disabled: WORKER_SECRET is not set, so no worker can claim a job. Probe and transcode jobs will stay queued until one is configured; comment exports still run.",
    );
  let housekeeping = false;
  let exporting = false;
  let stopped = false;
  let lastWatermarkSweep = 0;
  let lastShuttleAudioSweep = 0;
  let lastStillLadderSweep = 0;
  let lastStackKeySweep = 0;
  let lastFingerprintSweep = 0;
  let reclaimedOnStart = false;

  /* Exports keep their own single slot. A long PDF report used to run inside
     the same awaited tick as media, so it head-of-line blocked every encode
     behind it for its whole duration; now it blocks only the next export. */
  const pumpExports = async (): Promise<void> => {
    if (exporting || stopped) return;
    exporting = true;
    try {
      await runDueExport(db, options.store, { mediaEnabled, now: Date.now() });
    } catch (error) {
      console.warn(
        `[onelight] export pump failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      exporting = false;
    }
  };

  const sweep = async (
    name: string,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      console.warn(
        `[onelight] ${name} sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /* Reclaims and sweeps. Their own re-entrancy guard, separate from the job
     slots, so a slow sweep never stops work being claimed. */
  const tick = async () => {
    if (!housekeeping) {
      housekeeping = true;
      try {
        const now = Date.now();
        // On the first tick, reclaim every export still in 'processing': the
        // pump processes exports one at a time, so such a row can only be an
        // orphan from a crashed previous process. Afterwards, reclaim only
        // rows older than the stale threshold, catching a mid-flight crash
        // without disturbing an export this pump is actively running.
        if (!reclaimedOnStart) {
          reclaimedOnStart = true;
          await reclaimStuckExports(db, now);
        } else {
          await reclaimStuckExports(db, now - EXPORT_RECLAIM_STALE_MS);
        }
        /* Media jobs whose worker vanished for good. Claiming already refuses
           them once their attempts are spent, so without this they would sit
           in `processing` forever and the version would never read as failed:
           nothing else fails a job nobody is holding. */
        for (const abandoned of await findAbandonedJobs(db, now)) {
          try {
            /* Write back first, bury second. The other order loses the
               version: once the job is `dead` no sweep selects it again, so a
               writeback that failed after burial would never be retried and
               the version would stay pending forever. */
            await markAbandonedVersionFailed(db, abandoned);
            await buryAbandonedJob(db, abandoned.id, now);
            console.warn(
              `[onelight] job ${abandoned.id} (${abandoned.kind}) was abandoned by its worker after ${String(abandoned.attempts)} attempts.`,
            );
          } catch (error) {
            /* Left `processing` on purpose: the next sweep picks it up. */
            console.warn(
              `[onelight] could not retire abandoned job ${abandoned.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        // Reconcile missing renditions on a throttle rather than every poll;
        // each sweep is bounded per pass.
        if (
          mediaEnabled &&
          now - lastWatermarkSweep >= WATERMARK_SWEEP_INTERVAL_MS
        ) {
          lastWatermarkSweep = now;
          await sweep("watermark", () => sweepWatermarkJobs(db));
        }
        if (now - lastStackKeySweep >= STACK_KEY_SWEEP_INTERVAL_MS) {
          lastStackKeySweep = now;
          /* A full batch means there is more, and there is a reason to hurry:
             batch versioning matches against this column, so an upload
             arriving before the backfill reaches its asset silently matches
             nothing and lands as a new asset instead. Draining at a batch per
             tick clears a large library in under a minute rather than over an
             hour; a short batch means it is done and the throttle resumes. */
          const filled = await sweepStackKeys(db).catch((error: unknown) => {
            console.warn(
              `[onelight] stack key sweep failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return 0;
          });
          if (filled >= STACK_KEY_SWEEP_BATCH) lastStackKeySweep = 0;
        }
        if (
          mediaEnabled &&
          now - lastStillLadderSweep >= STILL_LADDER_SWEEP_INTERVAL_MS
        ) {
          lastStillLadderSweep = now;
          await sweep("still re-kind", () => sweepReKindStills(db));
          await sweep("still ladder", () => sweepStillLadderJobs(db));
        }
        if (
          mediaEnabled &&
          now - lastFingerprintSweep >= FINGERPRINT_SWEEP_INTERVAL_MS
        ) {
          lastFingerprintSweep = now;
          await sweep("fingerprint", () => sweepFingerprints(db));
        }
        if (
          mediaEnabled &&
          now - lastShuttleAudioSweep >= SHUTTLE_AUDIO_SWEEP_INTERVAL_MS
        ) {
          lastShuttleAudioSweep = now;
          await sweep("shuttle audio", () => sweepShuttleAudioJobs(db));
        }
      } catch (error) {
        // A transient failure here must not wedge the pump: log it and let
        // the finally clear the guard for the next tick.
        console.warn(
          `[onelight] worker pump housekeeping failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        housekeeping = false;
      }
    }
    void pumpExports();
  };
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
