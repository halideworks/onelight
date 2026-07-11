import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalBlobStore } from "./local-store.js";

const streamOf = (value: string): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });

describe("LocalBlobStore", () => {
  it("resumes multipart parts and assembles them in order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "onelight-store-"));
    try {
      const store = new LocalBlobStore(root);
      const multipart = await store.createMultipart(
        "workspace/project/file.txt",
        { size: 11 },
      );
      const one = await store.putPart(
        multipart.uploadId,
        1,
        streamOf("hello "),
      );
      const two = await store.putPart(multipart.uploadId, 2, streamOf("world"));
      expect(
        (
          await store.listParts(
            "workspace/project/file.txt",
            multipart.uploadId,
          )
        ).map((part) => part.partNo),
      ).toEqual([1, 2]);
      await store.completeMultipart(
        "workspace/project/file.txt",
        multipart.uploadId,
        [
          { partNo: 1, etag: one.etag },
          { partNo: 2, etag: two.etag },
        ],
      );
      expect(
        await readFile(path.join(root, "workspace/project/file.txt"), "utf8"),
      ).toBe("hello world");
      const names = await readdir(path.join(root, "workspace/project"));
      expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes putStream atomically and leaves no temp files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "onelight-store-"));
    try {
      const store = new LocalBlobStore(root);
      await store.putStream("a/b/object.bin", streamOf("payload"), {});
      expect(await readFile(path.join(root, "a/b/object.bin"), "utf8")).toBe(
        "payload",
      );
      expect(
        (await readdir(path.join(root, "a/b"))).filter((name) =>
          name.includes(".tmp-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leave a partial object when the source stream fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "onelight-store-"));
    try {
      const store = new LocalBlobStore(root);
      const failing = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("upload interrupted"));
        },
      });
      await expect(
        store.putStream("a/b/broken.bin", failing, {}),
      ).rejects.toThrow();
      const names = await readdir(path.join(root, "a/b")).catch(
        () => [] as string[],
      );
      expect(names).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
