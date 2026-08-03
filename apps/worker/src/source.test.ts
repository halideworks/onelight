import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canWriteInto,
  fetchSource,
  MULTIPART_THRESHOLD,
  placeOutputs,
  uploadBlob,
} from "./source.js";

const bytes = Buffer.from("a source file, as far as anything here knows");

const served =
  (body: Buffer, headers: Record<string, string> = {}): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-length": String(body.byteLength), ...headers },
      }),
    );

let root = "";
let work = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "onelight-source-"));
  work = path.join(root, "work");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the source a job reads", () => {
  it("uses the file on the volume when it is really there", async () => {
    const onVolume = path.join(root, "original.mov");
    await writeFile(onVolume, bytes);
    let fetched = false;
    const source = await fetchSource(
      { key: "originals/original.mov", path: onVolume, url: "/signed" },
      {
        workRoot: work,
        serverUrl: "http://server",
        label: "job-1-source",
        fetchImpl: () => {
          fetched = true;
          return Promise.reject(new Error("should not be called"));
        },
      },
    );
    expect(source.path).toBe(onVolume);
    expect(fetched).toBe(false);
    /* And discarding it does not delete the shared original: this process did
       not create the file, so it is not its to remove. */
    await source.discard();
    expect(await readFile(onVolume)).toEqual(bytes);
  });

  it("downloads it when the path is not there, keeping the extension", async () => {
    const source = await fetchSource(
      {
        key: "originals/01J.mov",
        path: path.join(root, "missing.mov"),
        url: "/api/v1/worker/blobs/originals/01J.mov?token=x",
      },
      {
        workRoot: work,
        serverUrl: "http://server/",
        label: "job-1-source",
        fetchImpl: served(bytes),
      },
    );
    expect(source.path.startsWith(work)).toBe(true);
    /* The name decides what several decoders think the file is, so the key's
       extension has to survive the trip. */
    expect(source.path.endsWith(".mov")).toBe(true);
    expect(await readFile(source.path)).toEqual(bytes);
    await source.discard();
    expect(await readdir(work)).toEqual([]);
  });

  it("refuses a download that arrived short", async () => {
    await expect(
      fetchSource(
        { key: "originals/01J.mov", url: "/signed" },
        {
          workRoot: work,
          serverUrl: "http://server",
          label: "job-1-source",
          /* The server declared more than it sent: a truncated original
             decodes into a plausible, wrong answer rather than an error. */
          fetchImpl: served(bytes, { "content-length": "999999" }),
        },
      ),
    ).rejects.toThrow(/declared/);
    /* Nothing half-written is left behind for the next job to trip over. */
    expect(await readdir(work)).toEqual([]);
  });

  it("refuses when the server will not serve it", async () => {
    await expect(
      fetchSource(
        { key: "originals/01J.mov", url: "/signed" },
        {
          workRoot: work,
          serverUrl: "http://server",
          label: "job-1-source",
          fetchImpl: () => Promise.resolve(new Response("no", { status: 409 })),
        },
      ),
    ).rejects.toThrow(/409/);
  });

  it("refuses a job it has no way to read", async () => {
    await expect(
      fetchSource(
        { key: "originals/01J.mov", path: path.join(root, "missing.mov") },
        { workRoot: work, serverUrl: "http://server", label: "job-1-source" },
      ),
    ).rejects.toThrow(/neither a readable path nor a URL/);
  });
});

describe("where a worker writes what it produces", () => {
  it("uses the shared directory when it can write there", async () => {
    expect(await canWriteInto(path.join(root, "renditions", "v1"))).toBe(true);
  });

  it("says so when it cannot", async () => {
    /* The case this exists for: a worker with no volume mounted, where the
       directory the envelope named cannot even be created. */
    await writeFile(path.join(root, "not-a-directory"), "x");
    expect(
      await canWriteInto(path.join(root, "not-a-directory", "renditions")),
    ).toBe(false);
  });

  it("writes into the shared volume when the envelope named one it can use", async () => {
    const placed = await placeOutputs(
      [
        {
          kind: "proxy_1080",
          key: "renditions/v1/proxy_1080.mp4",
          path: path.join(root, "renditions", "v1", "proxy_1080.mp4"),
        },
      ],
      { workRoot: work, jobId: "job-1" },
    );
    expect(placed.sending).toBe(false);
    expect(placed.outputs[0]?.path).toBe(
      path.join(root, "renditions", "v1", "proxy_1080.mp4"),
    );
  });

  it("encodes into its own scratch when the named directory is unusable", async () => {
    await writeFile(path.join(root, "not-a-directory"), "x");
    const placed = await placeOutputs(
      [
        {
          kind: "proxy_1080",
          key: "renditions/v1/proxy_1080.mp4",
          path: path.join(root, "not-a-directory", "v1", "proxy_1080.mp4"),
        },
      ],
      { workRoot: work, jobId: "job-1" },
    );
    expect(placed.sending).toBe(true);
    /* Scratch that mirrors the key, so the sprite's cue sheet and a PDF's page
       rasters still land beside the output they belong to. */
    expect(placed.outputs[0]?.path).toBe(
      path.join(work, "job-1", "renditions/v1/proxy_1080.mp4"),
    );
  });

  it("sends when the envelope named no path at all", async () => {
    /* What a deployment whose storage is not a mounted filesystem hands out.
       The empty path must not be read as a writable directory: its dirname is
       `.`, and this process's working directory is writable, so a worker that
       merely tested the named directory would decide it could write in place
       and then have nowhere to write. */
    const placed = await placeOutputs(
      [{ kind: "proxy_1080", key: "renditions/v1/proxy_1080.mp4" }],
      { workRoot: work, jobId: "job-1" },
    );
    expect(placed.sending).toBe(true);
    expect(placed.outputs[0]?.path).toBe(
      path.join(work, "job-1", "renditions/v1/proxy_1080.mp4"),
    );
  });

  it("places nothing for a job that writes nothing", async () => {
    const placed = await placeOutputs([], { workRoot: work, jobId: "job-1" });
    expect(placed).toEqual({ outputs: [], sending: false });
  });

  it("sends an output with its length, where the template says", async () => {
    const file = path.join(root, "proxy_1080.mp4");
    await writeFile(file, bytes);
    let seen: { url: string; method?: string; length: number } | null = null;
    await uploadBlob(
      "/api/v1/worker/blobs/{key}?job=job-1&scope=renditions%2Fv1%2F",
      "renditions/v1/proxy_1080.mp4",
      file,
      {
        serverUrl: "http://server",
        fetchImpl: ((input: string | URL, init?: RequestInit) => {
          const body = init?.body as Blob;
          seen = {
            url: String(input),
            ...(init?.method ? { method: init.method } : {}),
            length: body.size,
          };
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).toMatchObject({
      url: "http://server/api/v1/worker/blobs/renditions/v1/proxy_1080.mp4?job=job-1&scope=renditions%2Fv1%2F",
      method: "PUT",
      /* A length, because R2 will not take a body without one. */
      length: bytes.byteLength,
    });
  });

  /* An output too large for one request body. The threshold is overridden
     rather than met, because writing 64 MB to prove an arithmetic branch is a
     waste of a test suite's time; what is under test is the chunking, and the
     real threshold is asserted separately. */
  it("sends a large output in parts, in order, and names them", async () => {
    const file = path.join(root, "proxy_2160.mp4");
    const content = Buffer.from("0123456789abcdefghij");
    await writeFile(file, content);
    const seen: Array<{ url: string; method: string; body?: string }> = [];
    await uploadBlob("/single/{key}", "renditions/v1/proxy_2160.mp4", file, {
      serverUrl: "http://server",
      multipartTemplate: "/api/v1/worker/multipart/{action}/{key}?job=job-1",
      threshold: 8,
      fetchImpl: ((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({
          url,
          method: init?.method ?? "GET",
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (url.includes("/create/"))
          return Promise.resolve(
            new Response(JSON.stringify({ upload_id: "u-1", part_size: 8 }), {
              status: 200,
            }),
          );
        if (url.includes("/part/")) {
          const part = new URL(url).searchParams.get("part");
          return Promise.resolve(
            new Response(JSON.stringify({ etag: `etag-${part ?? "?"}` }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof fetch,
    });

    /* Never the single-PUT URL: a file over the threshold must not be sent
       as one body at all, which is the whole point. */
    expect(seen.some((call) => call.url.includes("/single/"))).toBe(false);
    const parts = seen.filter((call) => call.url.includes("/part/"));
    /* 20 bytes in 8-byte parts is three, the last one short. */
    expect(parts).toHaveLength(3);
    expect(
      parts.map((call) => new URL(call.url).searchParams.get("part")),
    ).toEqual(["1", "2", "3"]);
    expect(parts.every((call) => call.method === "PUT")).toBe(true);
    const completion = seen.at(-1);
    expect(completion?.url).toContain("/complete/");
    expect(JSON.parse(completion?.body ?? "{}")).toEqual({
      parts: [
        { part: 1, etag: "etag-1" },
        { part: 2, etag: "etag-2" },
        { part: 3, etag: "etag-3" },
      ],
    });
  });

  it("still sends a small output as one body", async () => {
    const file = path.join(root, "poster.png");
    await writeFile(file, bytes);
    const seen: string[] = [];
    await uploadBlob(
      "/api/v1/worker/blobs/{key}",
      "renditions/v1/poster.png",
      file,
      {
        serverUrl: "http://server",
        multipartTemplate: "/api/v1/worker/multipart/{action}/{key}",
        fetchImpl: ((input: string | URL) => {
          seen.push(String(input));
          return Promise.resolve(new Response("{}", { status: 200 }));
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/blobs/");
  });

  it("keeps the threshold under what a Workers request body allows", () => {
    /* The runtime refuses a body much past 100 MB. This is the assertion that
       the constant means what its comment says; the test above overrides it. */
    expect(MULTIPART_THRESHOLD).toBeLessThan(100 * 1024 * 1024);
    expect(MULTIPART_THRESHOLD).toBeGreaterThan(8 * 1024 * 1024);
  });

  it("raises when the server refuses the output", async () => {
    const file = path.join(root, "proxy_1080.mp4");
    await writeFile(file, bytes);
    await expect(
      uploadBlob("/api/v1/worker/blobs/{key}", "renditions/v1/p.mp4", file, {
        serverUrl: "http://server",
        fetchImpl: () =>
          Promise.resolve(
            new Response("outside this job's scope", { status: 403 }),
          ),
      }),
    ).rejects.toThrow(/403/);
  });
});
