# P0-3: Stateless media workers

Status: in progress, 2026-08-02. Audit item 3, and the foundation the Workers/D1/R2
target (audit item 2) is built on.

## What is actually wrong

The server already keeps durable job state. `jobs` carries `status`, `attempts`,
`max_attempts`, `run_after`, `worker_id`, `heartbeat_at`, `lease_expires_at` and
`capability_json`, and `claimNextJob` is a conditional UPDATE that repeats every
claimability predicate, so two claimants leave exactly one winner. None of that
needs replacing.

What is wrong is the execution leg. `processJob` treats the media worker as a
synchronous RPC: it POSTs to one `WORKER_URL`, then long-polls `GET /jobs/:id`
on that same worker until the job settles. The worker holds the state of that
call in an in-memory `Map` (`apps/worker/src/index.ts`).

Four consequences, in the order they hurt:

1. **One worker.** The server dials a single configured URL. A second worker can
   only be reached by putting a load balancer in front, and then the status poll
   can land on a worker that never ran the job. "1..N workers" is unreachable.
2. **No capability routing.** `jobs.capability_json` and the `capabilities`
   argument to `claimNextJob` both exist, and the pump passes a hardcoded
   `["cpu"]`. A worker with NVENC, or with LibRaw, cannot say so, so a job that
   needs a capability cannot be steered to a node that has it.
3. **A restart is a whole retry.** When a worker restarts mid-encode its Map is
   gone, the status GET 404s, the pump throws, and the job is failed and
   requeued. That is survivable (the lease and attempt count are real) but the
   entire encode is redone from zero, and the server cannot tell a crashed
   worker from a rejected job.
4. **A shared filesystem is assumed.** The server resolves output paths with
   `path.relative(blobRoot, ...)`, `stat`s the files the worker wrote, and
   hashes them itself. Both processes must see one volume, which is exactly why
   the Workers/D1/R2 target leaves versions in `transcode_status: "pending"`.

Note what is NOT wrong, so it does not get rewritten: rendition registration is
already idempotent. `registerWorkerRenditions` looks up `(version_id, kind,
share_id IS NULL)` and updates in place when it finds a row, so a retried job
overwrites its rendition instead of duplicating it, and it already records a
`checksum_sha256` per rendition.

## The shape

The worker stops being dialled and starts pulling. The server keeps every
authoritative fact; the worker holds nothing across a restart that anyone needs.

```
worker                              server
  |  POST /api/v1/worker/claim        |
  |  {worker_id, capabilities}        |
  |---------------------------------->|  claimNextJob (lease, attempts += 1)
  |<----------------------------------|  {job envelope, job token, lease_expires_at}
  |                                   |
  |  POST .../jobs/:id/progress       |
  |  {token, percent}                 |
  |---------------------------------->|  heartbeatJob (extends the lease)
  |                                   |
  |  POST .../jobs/:id/complete|fail  |
  |  {token, outputs[], fingerprint}  |
  |---------------------------------->|  validate, register, completeJob
```

- **The envelope is self-contained.** Everything the worker needs to run the job
  travels with the claim: source locations, the outputs it must produce with
  their deterministic keys, the media contract each output must satisfy, and the
  expected source hash where one is known. The worker never reads the database.
- **The token is job-scoped.** Minted at claim, derived from the job id and the
  attempt number, valid only for that attempt, and accepted only on that job's
  progress and completion routes. A leaked token cannot complete a different
  job, and cannot complete a later attempt of its own job.
- **The callback origin is configuration, never payload.** The worker posts back
  to its configured server origin. It does not accept a `callback_url` from the
  job it was handed. (This closes half of audit item 5 as a side effect; the
  existing `callback_url`/`callback_secret` fields come out of the payload.)
- **Outputs are named by the server.** Deterministic keys per job and rendition
  kind, so a retry writes the same key and registration stays an upsert.
- **An output is registered only after it is verified**: size greater than zero,
  checksum matching what the worker reported, and the media contract satisfied.

## Leases and the vanishing worker

The lease is the only thing that decides a worker is gone. A claim sets
`lease_expires_at`; progress posts push it out. Nothing else may complete the
job: a completion whose token is for an older attempt is rejected, because by
then another worker legitimately owns the job.

Expired leases need no separate reaper: `claimNextJob` already treats a
`processing` job whose `lease_expires_at` has passed as claimable, and
increments `attempts` as it takes it.

**But it never checks `attempts` against `max_attempts`.** Today that is masked,
because a job only reaches its attempt ceiling through `failJob`, which the pump
calls when the worker call throws, and which does the dead-lettering. A job
whose worker *vanishes* never goes through `failJob` at all: the lease simply
expires and the next claim picks it up, forever.

That is exactly the scenario this phase's acceptance criterion creates, so the
gap becomes live the moment workers pull. `claimNextJob` must refuse a candidate
whose `attempts` have reached `max_attempts`, and something must move those rows
to `dead` so `recordDeadMediaJob` still marks the version failed. Both belong in
this phase, with a test that kills a worker `max_attempts` times and asserts the
job dead-letters instead of cycling.

This is what makes the acceptance criterion pass: kill a worker mid-encode and
its lease simply stops being renewed, so the job returns to the queue and any
other worker claims it. The half-written outputs are overwritten at the same
deterministic keys by the retry, and the rendition row is updated rather than
inserted twice.

## Capabilities

The worker advertises what it can actually do, probed at startup rather than
declared: `nvenc`, `vaapi`, `av1`, `hdr`, `raw`, `pdf`, and always `cpu`. The
hardware ones come from the encoder probe the worker already performs before it
accepts jobs; `raw` and `pdf` from the presence of the external tools. The claim
passes them straight to `claimNextJob`, which already filters on
`capability_json`.

## Acceptance

Three workers run concurrently against one server; any one may be killed during
an encode; the job is retried on another and the result plays, with no duplicate
rendition rows and no corrupt output. Exercised in the integration workflow, not
only in unit tests: scale the worker service to three, kill one mid-transcode,
and assert the version reaches `ready` with exactly one rendition row per kind
and a decodable proxy.

## Progress

- Transport isolated in `runOnWorker` (PR #2).
- Claiming refuses a job at its attempt ceiling, and abandoned jobs are written
  back and then buried, in that order, so the sequence is retryable (PR #3).
- `probe`, `transcode` and `fingerprint` split into `plan*`/`apply*` pairs,
  every apply recomputing its context from the payload and the database
  (PR #4).

**Watermark is the one left, and it is not a mechanical split.** Its apply half
needs `specHash`, the version row, `outputPath`, `shareId` and `outputKey`, all
derived in the plan half from a share that may since have been revoked or had
its spec changed. The other three kinds could recompute their context from the
payload; this one needs those values carried in the envelope, which is the
right answer anyway: the envelope is what a claiming worker is handed, and the
output key it must write to belongs in it. Do that first, then the routes.

## What this deliberately leaves for P0-2

The envelope is designed so the source and output locations can be presigned
URLs instead of shared-filesystem paths, but this phase keeps writing to the
shared volume. Swapping the locations for presigned R2 URLs, and the local
`stat`/hash for the checksum the worker reports, is the whole of the next phase.
