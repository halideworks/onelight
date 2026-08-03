import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchSource } from "./source.js";

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
