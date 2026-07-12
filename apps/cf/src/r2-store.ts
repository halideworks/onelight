import type { MultipartBlobStore } from "@onelight/core";

// R2 multipart limits (docs/research/cloudflare-platform.md, section 2):
// parts are 5 MiB to 5 GiB, at most 10,000 per upload, and every part except
// the last must be the same size (stricter than AWS S3). 16 MiB matches
// LocalBlobStore, clears the 5 MiB floor, and caps a single object uploaded
// through this path at roughly 156 GiB.
const PART_SIZE = 16 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (value: string): string => {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const fromBase64Url = (value: string): string => {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return decoder.decode(bytes);
};

// Same shape rules as LocalBlobStore.resolve: normalize backslashes to
// forward slashes, then reject empty keys, absolute paths, and any ".."
// segment.
const normalizeKey = (key: string): string => {
  const normalized = key.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  )
    throw new Error("Invalid blob key.");
  return normalized;
};

export class R2BlobStore implements MultipartBlobStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  // The port hands putPart and abortMultipart only an uploadId, but the R2
  // binding resumes an upload by key plus uploadId. Pack the key into the
  // opaque uploadId the API persists; base64url never contains ".", so the
  // first "." splits the halves unambiguously.
  private packUploadId(key: string, r2UploadId: string): string {
    return `${toBase64Url(key)}.${r2UploadId}`;
  }

  private unpackUploadId(uploadId: string): { key: string; id: string } {
    const dot = uploadId.indexOf(".");
    if (dot < 1 || dot === uploadId.length - 1)
      throw new Error("Invalid multipart ID.");
    let key: string;
    try {
      key = fromBase64Url(uploadId.slice(0, dot));
    } catch {
      throw new Error("Invalid multipart ID.");
    }
    return { key: normalizeKey(key), id: uploadId.slice(dot + 1) };
  }

  async putStream(
    key: string,
    stream: ReadableStream,
    meta: { contentType?: string; size?: number },
  ): Promise<void> {
    const target = normalizeKey(key);
    const options: R2PutOptions = meta.contentType
      ? { httpMetadata: { contentType: meta.contentType } }
      : {};
    if (typeof meta.size === "number") {
      // R2 writes need a known length; FixedLengthStream carries the declared
      // size through and fails the put if the body does not match it.
      const fixed = new FixedLengthStream(meta.size);
      await Promise.all([
        this.bucket.put(target, fixed.readable, options),
        stream.pipeTo(fixed.writable),
      ]);
      return;
    }
    await this.bucket.put(
      target,
      await new Response(stream).arrayBuffer(),
      options,
    );
  }

  async createMultipart(
    key: string,
    meta: { contentType?: string; size?: number },
  ): Promise<{ uploadId: string; partSize: number }> {
    const target = normalizeKey(key);
    const options: R2MultipartOptions = meta.contentType
      ? { httpMetadata: { contentType: meta.contentType } }
      : {};
    const upload = await this.bucket.createMultipartUpload(target, options);
    return {
      uploadId: this.packUploadId(target, upload.uploadId),
      partSize: PART_SIZE,
    };
  }

  async putPart(
    uploadId: string,
    partNo: number,
    stream: ReadableStream,
    partLength?: number,
  ): Promise<{ etag: string; size: number }> {
    if (!Number.isInteger(partNo) || partNo < 1)
      throw new Error("Invalid part number.");
    const { key, id } = this.unpackUploadId(uploadId);
    const upload = this.bucket.resumeMultipartUpload(key, id);
    // Preferred path: the caller knows the exact part length (the API
    // validates it from the request Content-Length), so stream it straight to
    // R2 through a FixedLengthStream instead of buffering the whole part.
    // A part is up to ~17 MiB; several buffered concurrently in one isolate
    // could OOM-terminate it (128 MB limit). FixedLengthStream supplies the
    // known length R2 requires and fails the upload if the body length does
    // not match, so the reported size is exactly partLength.
    if (
      typeof partLength === "number" &&
      Number.isInteger(partLength) &&
      partLength >= 0
    ) {
      const fixed = new FixedLengthStream(partLength);
      const [uploaded] = await Promise.all([
        upload.uploadPart(partNo, fixed.readable),
        stream.pipeTo(fixed.writable),
      ]);
      return { etag: uploaded.etag, size: partLength };
    }
    // Fallback when the length is not supplied: the API's byte limiter strips
    // the known length R2 needs, so the part is buffered to learn its size.
    // The API caps part bodies near PART_SIZE, so this stays bounded, but the
    // streaming path above is preferred and the putPart route in packages/api
    // should pass the declared Content-Length to take it.
    const bytes = await new Response(stream).arrayBuffer();
    const uploaded = await upload.uploadPart(partNo, bytes);
    return { etag: uploaded.etag, size: bytes.byteLength };
  }

  signPartUrl(key: string, uploadId: string, partNo: number): Promise<string> {
    return Promise.resolve(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}/url?key=${encodeURIComponent(key)}`,
    );
  }

  // The R2 binding cannot enumerate the parts of an in-progress multipart
  // upload: R2MultipartUpload exposes only uploadPart, complete, and abort
  // (docs/research/cloudflare-platform.md, section 2, covers the binding
  // surface). The API layer never depends on this method; its upload_parts
  // table is the source of truth for which parts have landed, so after
  // validating the inputs an empty list is the honest answer.
  listParts(
    key: string,
    uploadId: string,
  ): Promise<Array<{ partNo: number; etag: string; size: number }>> {
    normalizeKey(key);
    this.unpackUploadId(uploadId);
    return Promise.resolve([]);
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ partNo: number; etag: string }>,
  ): Promise<void> {
    const target = normalizeKey(key);
    const { key: uploadKey, id } = this.unpackUploadId(uploadId);
    if (uploadKey !== target)
      throw new Error("Multipart upload does not match this key.");
    const ordered = [...parts].sort((a, b) => a.partNo - b.partNo);
    const assembled: R2UploadedPart[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const part = ordered[index];
      if (!part || (index > 0 && part.partNo === ordered[index - 1]?.partNo))
        throw new Error("Duplicate multipart part.");
      assembled.push({ partNumber: part.partNo, etag: part.etag });
    }
    await this.bucket.resumeMultipartUpload(target, id).complete(assembled);
  }

  async abortMultipart(uploadId: string): Promise<void> {
    const { key, id } = this.unpackUploadId(uploadId);
    try {
      await this.bucket.resumeMultipartUpload(key, id).abort();
    } catch (error) {
      // Match LocalBlobStore: aborting an upload that was already completed
      // or aborted is a no-op, not an error.
      if (
        !(error instanceof Error) ||
        !/does not exist|no such upload/i.test(error.message)
      )
        throw error;
    }
  }

  signGetUrl(
    key: string,
    options: { expires: number; contentDisposition?: string },
  ): Promise<string> {
    // Same API-relative shape as LocalBlobStore: the API layer signs these
    // URLs and streams the bytes back through /api/v1/media.
    const params = new URLSearchParams({ expires: String(options.expires) });
    if (options.contentDisposition)
      params.set("content-disposition", options.contentDisposition);
    return Promise.resolve(
      `/api/v1/media/${key.split("/").map(encodeURIComponent).join("/")}?${params}`,
    );
  }

  async getStream(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<ReadableStream> {
    const target = normalizeKey(key);
    // The port's range end is inclusive; R2 takes offset plus length.
    const options: R2GetOptions = range
      ? {
          range:
            range.end === undefined
              ? { offset: range.start }
              : { offset: range.start, length: range.end - range.start + 1 },
        }
      : {};
    const object = await this.bucket.get(target, options);
    if (!object) throw new Error("Blob not found.");
    return object.body;
  }

  async head(key: string): Promise<{ size: number }> {
    const object = await this.bucket.head(normalizeKey(key));
    if (!object) throw new Error("Blob not found.");
    return { size: object.size };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(normalizeKey(key));
  }
}
