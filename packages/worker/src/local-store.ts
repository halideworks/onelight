import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { MultipartBlobStore } from "@onelight/core";

const toWeb = (stream: NodeJS.ReadableStream): ReadableStream =>
  Readable.toWeb(stream as Readable) as unknown as ReadableStream;

export class LocalBlobStore implements MultipartBlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const normalized = key.replaceAll("\\", "/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    )
      throw new Error("Invalid blob key.");
    const resolved = path.resolve(this.root, normalized);
    if (!resolved.startsWith(`${this.root}${path.sep}`))
      throw new Error("Invalid blob key.");
    return resolved;
  }

  private multipartPath(uploadId: string, suffix = ""): string {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId))
      throw new Error("Invalid multipart ID.");
    return path.join(this.root, ".multipart", uploadId, suffix);
  }

  async putStream(
    key: string,
    stream: ReadableStream,
    meta: { contentType?: string; size?: number },
  ): Promise<void> {
    void meta;
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write to a sibling temp file and rename on success so a crash never
    // leaves a truncated object at the final key.
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      await pipeline(
        Readable.fromWeb(stream as unknown as NodeReadableStream),
        createWriteStream(temp),
      );
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async createMultipart(
    key: string,
    meta: { contentType?: string; size?: number },
  ): Promise<{ uploadId: string; partSize: number }> {
    const uploadId = randomUUID();
    const partSize = 16 * 1024 * 1024;
    const directory = this.multipartPath(uploadId);
    await mkdir(path.join(directory, "parts"), { recursive: true });
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ key, meta, partSize }),
      "utf8",
    );
    return { uploadId, partSize };
  }

  async putPart(
    uploadId: string,
    partNo: number,
    stream: ReadableStream,
  ): Promise<{ etag: string; size: number }> {
    if (!Number.isInteger(partNo) || partNo < 1)
      throw new Error("Invalid part number.");
    const target = this.multipartPath(uploadId, `parts/${partNo}`);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(
      Readable.fromWeb(stream as unknown as NodeReadableStream),
      createWriteStream(target),
    );
    const bytes = await readFile(target);
    return {
      etag: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  }

  signPartUrl(key: string, uploadId: string, partNo: number): Promise<string> {
    return Promise.resolve(
      `/api/v1/uploads/${encodeURIComponent(uploadId)}/parts/${partNo}/url?key=${encodeURIComponent(key)}`,
    );
  }

  async listParts(
    _key: string,
    uploadId: string,
  ): Promise<Array<{ partNo: number; etag: string; size: number }>> {
    const directory = this.multipartPath(uploadId, "parts");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const parts = [];
    for (const name of names
      .filter((value) => /^\d+$/.test(value))
      .sort((a, b) => Number(a) - Number(b))) {
      const file = path.join(directory, name);
      const bytes = await readFile(file);
      parts.push({
        partNo: Number(name),
        etag: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      });
    }
    return parts;
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ partNo: number; etag: string }>,
  ): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Assemble into a sibling temp file and rename on success so a crash
    // never leaves a truncated object at the final key.
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      const output = createWriteStream(temp);
      const ordered = [...parts].sort((a, b) => a.partNo - b.partNo);
      for (let index = 0; index < ordered.length; index += 1) {
        const part = ordered[index];
        if (!part || (index > 0 && part.partNo === ordered[index - 1]?.partNo))
          throw new Error("Duplicate multipart part.");
        const bytes = await readFile(
          this.multipartPath(uploadId, `parts/${part.partNo}`),
        );
        const etag = createHash("sha256").update(bytes).digest("hex");
        if (etag !== part.etag)
          throw new Error(`Multipart part ${part.partNo} has an invalid etag.`);
        const source = createReadStream(
          this.multipartPath(uploadId, `parts/${part.partNo}`),
        );
        await new Promise<void>((resolve, reject) => {
          source.on("error", reject);
          output.on("error", reject);
          source.on("end", resolve);
          source.pipe(output, { end: false });
        });
      }
      await new Promise<void>((resolve, reject) => {
        output.on("error", reject);
        output.end(resolve);
      });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await rm(this.multipartPath(uploadId), { recursive: true, force: true });
  }

  async abortMultipart(uploadId: string): Promise<void> {
    await rm(this.multipartPath(uploadId), { recursive: true, force: true });
  }

  signGetUrl(
    key: string,
    options: { expires: number; contentDisposition?: string },
  ): Promise<string> {
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
    const file = this.resolve(key);
    const info = await stat(file);
    return toWeb(
      createReadStream(
        file,
        range
          ? { start: range.start, end: range.end ?? info.size - 1 }
          : undefined,
      ),
    );
  }

  async head(key: string): Promise<{ size: number }> {
    const info = await stat(this.resolve(key));
    return { size: info.size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
