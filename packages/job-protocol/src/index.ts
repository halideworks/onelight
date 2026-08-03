/* How a worker is given work, and how what it did is written down.
 *
 * Claim, plan, apply and the worker-facing routes, in a package rather than in
 * the node server, because the Workers target has to mount the same protocol
 * rather than a second implementation of it. Nothing here opens a file or
 * starts a process: a job describes storage by key, and the two deployments
 * differ only in what they hand a worker to reach those keys with.
 *
 * What stayed behind in `apps/server` is the half that genuinely cannot leave:
 * the pump's own loop, the comment exports, and the blob GC.
 */
export * from "./worker-pump.js";
export * from "./worker-routes.js";
export * from "./json.js";
