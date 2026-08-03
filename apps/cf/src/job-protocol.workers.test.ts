import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import * as cloudflareTest from "cloudflare:test";
import { createWorkerRoutes } from "@onelight/job-protocol";
import { applyD1Migrations, createD1Db } from "@onelight/db/cf";
import type { Env } from "./env.js";
import { R2BlobStore } from "./r2-store.js";

const { env } = cloudflareTest as unknown as { env: Env };

/* The gate for pointing a worker at this target.
 *
 * The job protocol could not be loaded here at all until now: it reached
 * `@onelight/worker` through the comment exports, `@onelight/worker` re-exports
 * `media.ts`, and `media.ts` imports `node:child_process`. workerd does not
 * report that as a missing module -- it takes SIGSEGV and the pool dies with no
 * diagnostic worth reading, so there was nothing to bisect from either.
 *
 * The node builtins were never the problem: `nodejs_compat` covers node:crypto,
 * node:path and node:fs/promises, all measured. Only the process spawner is
 * unavailable, which is why the split was drawn where it was.
 *
 * So this mounts the real routes on the real bindings and drives them, rather
 * than asserting that an import resolved: a module can load and still be
 * unusable here, and what step 4 needs to know is that the protocol answers.
 */
const routes = async () => {
  await applyD1Migrations(env.DB);
  return createWorkerRoutes({
    db: createD1Db(env.DB),
    /* No blob root: this deployment's storage is not a filesystem. */
    store: new R2BlobStore(env.BLOBS),
    workerSecret: "worker-secret-for-tests",
  });
};

describe("the job protocol, mounted on the Workers target", () => {
  it("refuses a claim that is not signed with the worker secret", async () => {
    const app = await routes();
    const response = await app.request("/api/v1/worker/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-onelight-signature": "0".repeat(64),
      },
      body: JSON.stringify({
        worker_id: "w-1",
        capabilities: ["cpu"],
        timestamp: Date.now(),
      }),
    });
    expect(response.status).toBe(401);
  });

  it("has nothing to hand out, and says so without a body", async () => {
    const app = await routes();
    /* An idle queue is a 204, not an error and not an empty job: the worker's
       loop reads the status rather than parsing a body to find out. Reaching
       this at all means the claim ran a real D1 query inside workerd. */
    const body = JSON.stringify({
      worker_id: "w-1",
      capabilities: ["cpu"],
      timestamp: Date.now(),
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("worker-secret-for-tests"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = [
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const response = await app.request("/api/v1/worker/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-onelight-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(204);
  });

  /* Mounted on the Worker itself, not just constructible from its parts.
     Reached through SELF, so what answers is the deployed fetch handler with
     its asset fallback and its API routing in front -- a route that exists in
     a test but is shadowed on the way in would pass every check above and
     still be unreachable in production.

     503 rather than 401 because this deployment has no WORKER_SECRET: nothing
     can claim, which is the same thing the node target says when media is
     unconfigured. What matters is that it is not a 404. */
  it("is reachable through the deployed handler", async () => {
    const response = await SELF.fetch(
      "https://example.com/api/v1/worker/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "w-1", timestamp: Date.now() }),
      },
    );
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "media processing is disabled",
    });
  });
});
