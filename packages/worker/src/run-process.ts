/* Child process execution for every ffmpeg, ffprobe and pdftoppm run.

   Its own module so the stills pipeline can spawn a decoder without importing
   the whole media recipe file back into itself. */

import { spawn } from "node:child_process";
import { setPriority } from "node:os";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

/* An ffmpeg/ffprobe with no output for this long is treated as hung and
   killed. ffmpeg prints progress to stderr continuously while it works and a
   probe finishes in well under this, so only a genuinely stuck process (filter
   deadlock, unterminated probe) goes silent long enough to trip it. Without
   it, a hung child pins its job 'processing' forever, the pump's 6h deadline
   requeues it into a worker that still reports 409, and each of the retries
   burns another 6h against the same wedged process while it pegs a core. */
export const PROCESS_IDLE_TIMEOUT_MS = 5 * 60_000;

/*
 * Lowering a child's scheduling priority is the only thing that actually
 * protects the site, and it is worth being precise about why: capping encoder
 * threads does NOT bound what the process takes. Measured on the real 4K HDR
 * job, `lp=2` still averaged 3.3 of four cores, because the decode and filter
 * threads are not the encoder's to cap. Niceness needs no such bookkeeping --
 * an idle box still gives the rendition everything going spare, and the moment
 * a request arrives the request wins.
 */
export const runProcess = (
  command: string,
  args: string[],
  cwd?: string,
  idleTimeoutMs = PROCESS_IDLE_TIMEOUT_MS,
  niceness?: number,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (niceness !== undefined && child.pid !== undefined)
      try {
        setPriority(child.pid, niceness);
      } catch {
        /* Priority is an optimisation, not a requirement: a platform or a
           sandbox that refuses it must not fail the transcode. */
      }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let idle: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, idleTimeoutMs);
    };
    const settle = (): void => clearTimeout(idle);
    arm();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      arm();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      arm();
    });
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      if (timedOut) {
        reject(
          new Error(
            `${command} was killed after ${String(
              Math.round(idleTimeoutMs / 1000),
            )}s without output (treated as hung).`,
          ),
        );
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else
        reject(
          new Error(
            `${command} exited with ${code}: ${result.stderr.slice(-4000)}`,
          ),
        );
    });
  });
