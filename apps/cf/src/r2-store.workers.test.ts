import { describe, expect, it } from "vitest";
import * as cloudflareTest from "cloudflare:test";
import type { Env } from "./env.js";
import { R2BlobStore } from "./r2-store.js";

// cloudflare-test.d.ts declares only SELF, so pull env through the module
// namespace; vitest-pool-workers provides it at runtime from the bindings in
// wrangler.jsonc.
const { env } = cloudflareTest as unknown as { env: Env };

const encoder = new TextEncoder();

const streamOf = (bytes: Uint8Array): ReadableStream => {
  // workers-types BodyInit does not accept a bare Uint8Array; hand the
  // Response the underlying buffer instead.
  const body = new Response(bytes.buffer as ArrayBuffer).body;
  if (!body) throw new Error("Could not create a test stream.");
  return body;
};

const collect = async (stream: ReadableStream): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("R2BlobStore", () => {
  it("round-trips putStream and getStream with a declared size", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const bytes = encoder.encode("onelight r2 round trip");
    await store.putStream("ws/media/roundtrip.bin", streamOf(bytes), {
      contentType: "application/octet-stream",
      size: bytes.byteLength,
    });
    const read = await collect(await store.getStream("ws/media/roundtrip.bin"));
    expect(text(read)).toBe("onelight r2 round trip");
  });

  it("round-trips putStream without a declared size", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const bytes = encoder.encode("chunked body, no content-length");
    await store.putStream("ws/media/chunked.bin", streamOf(bytes), {});
    const read = await collect(await store.getStream("ws/media/chunked.bin"));
    expect(text(read)).toBe("chunked body, no content-length");
  });

  it("serves bounded and open-ended range reads", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const bytes = encoder.encode("0123456789");
    await store.putStream("ws/media/range.bin", streamOf(bytes), {
      size: bytes.byteLength,
    });
    const middle = await collect(
      await store.getStream("ws/media/range.bin", { start: 2, end: 5 }),
    );
    expect(text(middle)).toBe("2345");
    const tail = await collect(
      await store.getStream("ws/media/range.bin", { start: 6 }),
    );
    expect(text(tail)).toBe("6789");
  });

  it("reports size through head and throws for missing keys", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const bytes = encoder.encode("sized");
    await store.putStream("ws/media/sized.bin", streamOf(bytes), {
      size: bytes.byteLength,
    });
    expect(await store.head("ws/media/sized.bin")).toEqual({ size: 5 });
    await expect(store.head("ws/media/absent.bin")).rejects.toThrow(
      "Blob not found.",
    );
    await expect(store.getStream("ws/media/absent.bin")).rejects.toThrow(
      "Blob not found.",
    );
  });

  it("assembles multipart uploads in part number order", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const key = "ws/media/multipart.bin";
    // R2 requires every part except the last to be at least 5 MiB and all
    // non-final parts to share one size, so the first part is a full 5 MiB.
    const partOne = new Uint8Array(5 * 1024 * 1024).fill(0xaa);
    const partTwo = new Uint8Array(1024).fill(0xbb);
    const { uploadId, partSize } = await store.createMultipart(key, {
      contentType: "application/octet-stream",
      size: partOne.byteLength + partTwo.byteLength,
    });
    expect(partSize).toBe(16 * 1024 * 1024);
    const first = await store.putPart(uploadId, 1, streamOf(partOne));
    const second = await store.putPart(uploadId, 2, streamOf(partTwo));
    expect(first.size).toBe(partOne.byteLength);
    expect(second.size).toBe(partTwo.byteLength);
    // Completion order must not matter: the store sorts by part number.
    await store.completeMultipart(key, uploadId, [
      { partNo: 2, etag: second.etag },
      { partNo: 1, etag: first.etag },
    ]);
    const assembled = await collect(await store.getStream(key));
    expect(assembled.byteLength).toBe(partOne.byteLength + partTwo.byteLength);
    expect(assembled[0]).toBe(0xaa);
    expect(assembled[partOne.byteLength - 1]).toBe(0xaa);
    expect(assembled[partOne.byteLength]).toBe(0xbb);
    expect(assembled[assembled.byteLength - 1]).toBe(0xbb);
    expect(await store.head(key)).toEqual({
      size: partOne.byteLength + partTwo.byteLength,
    });
  });

  it("rejects duplicate parts at completion", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const key = "ws/media/duplicate.bin";
    const { uploadId } = await store.createMultipart(key, {});
    const part = await store.putPart(
      uploadId,
      1,
      streamOf(encoder.encode("only part")),
    );
    await expect(
      store.completeMultipart(key, uploadId, [
        { partNo: 1, etag: part.etag },
        { partNo: 1, etag: part.etag },
      ]),
    ).rejects.toThrow("Duplicate multipart part.");
    await store.abortMultipart(uploadId);
  });

  it("aborts multipart uploads and leaves no object behind", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const key = "ws/media/aborted.bin";
    const { uploadId } = await store.createMultipart(key, {});
    const part = await store.putPart(
      uploadId,
      1,
      streamOf(encoder.encode("abandoned part")),
    );
    await store.abortMultipart(uploadId);
    await expect(
      store.completeMultipart(key, uploadId, [{ partNo: 1, etag: part.etag }]),
    ).rejects.toThrow();
    await expect(store.head(key)).rejects.toThrow("Blob not found.");
    // A second abort is a no-op, matching LocalBlobStore.
    await store.abortMultipart(uploadId);
  });

  it("deletes blobs idempotently", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const bytes = encoder.encode("delete me");
    await store.putStream("ws/media/deleted.bin", streamOf(bytes), {
      size: bytes.byteLength,
    });
    await store.delete("ws/media/deleted.bin");
    await expect(store.head("ws/media/deleted.bin")).rejects.toThrow(
      "Blob not found.",
    );
    await store.delete("ws/media/deleted.bin");
  });

  it("rejects path traversal key shapes", async () => {
    const store = new R2BlobStore(env.BLOBS);
    const unsafe = [
      "",
      "/absolute.bin",
      "..",
      "a/../b.bin",
      "nested\\..\\escape.bin",
      "\\leading-backslash.bin",
    ];
    for (const key of unsafe) {
      await expect(
        store.putStream(key, streamOf(encoder.encode("x")), {}),
      ).rejects.toThrow("Invalid blob key.");
      await expect(store.getStream(key)).rejects.toThrow("Invalid blob key.");
      await expect(store.head(key)).rejects.toThrow("Invalid blob key.");
      await expect(store.delete(key)).rejects.toThrow("Invalid blob key.");
      await expect(store.createMultipart(key, {})).rejects.toThrow(
        "Invalid blob key.",
      );
    }
    // Backslashes normalize to forward slashes, matching LocalBlobStore.
    const bytes = encoder.encode("normalized");
    await store.putStream("ws\\media\\normalized.bin", streamOf(bytes), {
      size: bytes.byteLength,
    });
    expect(await store.head("ws/media/normalized.bin")).toEqual({ size: 10 });
  });
});
