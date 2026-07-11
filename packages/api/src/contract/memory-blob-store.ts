import type { MultipartBlobStore } from "@onelight/core";

const collectBytes = async (stream: ReadableStream): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

/**
 * In-memory MultipartBlobStore used by the Node contract leg (and any other
 * test that needs a blob store without touching disk). Promoted from
 * app.test.ts so both suites share one implementation.
 */
export class MemoryBlobStore implements MultipartBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  private readonly multiparts = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array> }
  >();
  private counter = 0;

  async putStream(key: string, stream: ReadableStream): Promise<void> {
    this.blobs.set(key, await collectBytes(stream));
  }

  createMultipart(
    key: string,
  ): Promise<{ uploadId: string; partSize: number }> {
    this.counter += 1;
    const uploadId = `memory-upload-${this.counter}`;
    this.multiparts.set(uploadId, { key, parts: new Map() });
    return Promise.resolve({ uploadId, partSize: 8 });
  }

  async putPart(
    uploadId: string,
    partNo: number,
    stream: ReadableStream,
  ): Promise<{ etag: string; size: number }> {
    const entry = this.multiparts.get(uploadId);
    if (!entry) throw new Error("Unknown multipart upload.");
    const bytes = await collectBytes(stream);
    entry.parts.set(partNo, bytes);
    return {
      etag: `etag-${partNo}-${bytes.byteLength}`,
      size: bytes.byteLength,
    };
  }

  signPartUrl(_key: string, uploadId: string, partNo: number): Promise<string> {
    return Promise.resolve(`/memory/${uploadId}/${partNo}`);
  }

  completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ partNo: number; etag: string }>,
  ): Promise<void> {
    const entry = this.multiparts.get(uploadId);
    if (!entry) return Promise.reject(new Error("Unknown multipart upload."));
    const ordered = [...parts].sort((a, b) => a.partNo - b.partNo);
    const chunks = ordered.map(
      (part) => entry.parts.get(part.partNo) ?? new Uint8Array(),
    );
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.blobs.set(key, joined);
    this.multiparts.delete(uploadId);
    return Promise.resolve();
  }

  listParts(
    _key: string,
    uploadId: string,
  ): Promise<Array<{ partNo: number; etag: string; size: number }>> {
    const entry = this.multiparts.get(uploadId);
    return Promise.resolve(
      entry
        ? [...entry.parts.entries()].map(([partNo, bytes]) => ({
            partNo,
            etag: `etag-${partNo}-${bytes.byteLength}`,
            size: bytes.byteLength,
          }))
        : [],
    );
  }

  abortMultipart(uploadId: string): Promise<void> {
    this.multiparts.delete(uploadId);
    return Promise.resolve();
  }

  signGetUrl(key: string): Promise<string> {
    return Promise.resolve(`/memory/${key}`);
  }

  getStream(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<ReadableStream> {
    const bytes = this.blobs.get(key);
    if (!bytes) return Promise.reject(new Error("Blob was not found."));
    const sliced = range
      ? bytes.slice(range.start, (range.end ?? bytes.byteLength - 1) + 1)
      : bytes.slice();
    const body = new Response(sliced.buffer).body;
    if (!body) return Promise.reject(new Error("Blob stream unavailable."));
    return Promise.resolve(body);
  }

  head(key: string): Promise<{ size: number }> {
    const bytes = this.blobs.get(key);
    if (!bytes) return Promise.reject(new Error("Blob was not found."));
    return Promise.resolve({ size: bytes.byteLength });
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }
}
