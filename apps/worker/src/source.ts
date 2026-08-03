import { createWriteStream } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import { constants, openAsBlob } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/* Scratch this process is responsible for: everything downloaded for a job is
   removed when the job ends, however it ends. */
export interface Fetched {
  path: string;
  discard: () => Promise<void>;
}

const keepIt: Fetched["discard"] = () => Promise.resolve();

/* Long, because this is a whole original coming down: a camera master is
   routinely tens of gigabytes, and a job that has already been claimed should
   not be abandoned over a slow copy. It is a bound, not a budget: without one,
   a server that stops sending mid-file holds a slot open forever. */
export const SOURCE_TIMEOUT_MS = 2 * 60 * 60_000;

export interface SourceRef {
  key?: string | undefined;
  path?: string | undefined;
  url?: string | undefined;
}

/**
 * A source, as a file this process can open.
 *
 * Two ways to have one, and the worker picks rather than the server. If the
 * envelope named a path and the file is really there, that is the source: a
 * worker sharing a volume with the server must not copy a 40 GB original
 * across it to make a proxy of it. Otherwise the bytes come down the URL the
 * claim handed out, into the work root, and are deleted when the job ends.
 *
 * The name it lands under keeps the key's own extension, because several
 * decoders here decide what a file is by its name: isStillSource and the still
 * ladder both do, so a source called `.tmp` would be treated as a different
 * kind of file than the one that was uploaded.
 */
export const fetchSource = async (
  reference: SourceRef,
  options: {
    workRoot: string;
    serverUrl: string;
    /* What the downloaded file is called, and what a failure calls it. */
    label: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<Fetched> => {
  const { workRoot, serverUrl, label } = options;
  if (reference.path && (await stat(reference.path).catch(() => null)))
    return { path: reference.path, discard: keepIt };
  if (!reference.url)
    throw new Error(
      `The ${label} is neither a readable path nor a URL to fetch it from.`,
    );
  await mkdir(workRoot, { recursive: true });
  const named = path.basename(
    reference.key ?? reference.url.split("?")[0] ?? "source",
  );
  const target = path.join(
    workRoot,
    `${label}-${named}`.replace(/[^A-Za-z0-9._-]/g, "-"),
  );
  const response = await (options.fetchImpl ?? fetch)(
    new URL(reference.url, `${serverUrl.replace(/\/$/, "")}/`),
    { signal: AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS) },
  );
  if (!response.ok || !response.body)
    throw new Error(
      `The ${label} could not be fetched: ${String(response.status)}.`,
    );
  const discard = () => rm(target, { force: true }).catch(() => undefined);
  try {
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream),
      createWriteStream(target),
    );
    /* A truncated download decodes into a plausible, wrong answer rather than
       an error, so the length the server declared is checked before anything
       reads the file. */
    const declared = Number(response.headers.get("content-length"));
    const written = await stat(target);
    if (Number.isFinite(declared) && declared !== written.size)
      throw new Error(
        `The ${label} arrived as ${String(written.size)} bytes of a declared ${String(declared)}.`,
      );
  } catch (error) {
    await discard();
    throw error;
  }
  return { path: target, discard };
};

/**
 * Whether this process can write into a directory the envelope named.
 *
 * How a worker decides where its outputs go. A worker sharing a volume with
 * the server writes the rendition straight into place, which is a rename away
 * from being served; a worker that mounts nothing cannot, and encodes into its
 * own scratch to upload afterwards. Asked rather than configured, because the
 * two halves of a deployment should not need to be told about each other.
 */
export const canWriteInto = async (directory: string): Promise<boolean> => {
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/* What the envelope asks for: a key, which is where the output belongs in
   storage, and on a deployment whose storage this process might share, the file
   that key is today. The path is optional because it is the deployment's
   addition and not the job's -- a Workers deployment has no filesystem to name. */
export interface PlannedOutput {
  kind: string;
  key: string;
  path?: string;
  height?: number;
}

/* The same output once this process has decided where it will write it. */
export interface PlacedOutput extends PlannedOutput {
  path: string;
}

/**
 * Where this worker will write what it produces, and whether it has to send it.
 *
 * If the envelope named files and this process can write where they go, that is
 * where the renditions go and nothing has to move afterwards. If it named none
 * -- storage the server does not mount -- or named files this process cannot
 * write, it encodes into its own scratch and uploads each output when it is
 * finished.
 *
 * An envelope with no paths in it has to be read as "you cannot write in
 * place", and not merely fail the writability check by accident: the empty
 * string has a dirname of `.`, so a worker with a writable working directory
 * would otherwise be told it could write where the server had named nowhere.
 */
export const placeOutputs = async (
  outputs: PlannedOutput[],
  options: { workRoot: string; jobId: string },
): Promise<{ outputs: PlacedOutput[]; sending: boolean }> => {
  /* A probe of a video asks for nothing to be written, so there is nothing to
     place and nothing to send. Deciding otherwise would demand an upload URL
     for a job that produces no bytes. */
  if (outputs.length === 0) return { outputs: [], sending: false };
  if (
    outputs.every(
      (output): output is PlacedOutput => typeof output.path === "string",
    )
  ) {
    const first = outputs[0];
    if (first && (await canWriteInto(path.dirname(first.path))))
      return { outputs, sending: false };
  }
  /* Scratch that mirrors the key, so a PDF's pages/ nesting and the sprite's
     cue sheet still land beside the output they belong to, and the key each
     file maps back to is unchanged. */
  return {
    outputs: outputs.map((output) => ({
      ...output,
      path: path.join(options.workRoot, options.jobId, output.key),
    })),
    sending: true,
  };
};

/**
 * A file this job produced, put where the server said outputs go.
 *
 * The URL is a template because a job writes files nobody planned: the
 * sprite's cue sheet, a PDF's page rasters. The key goes where {key} is, and
 * the server checks it against the namespace the capability was signed for.
 *
 * Sent as a Blob rather than a stream so the request carries a length: R2 will
 * not take a body without one, and a store writing to a file wants to know
 * when what it was promised did not all arrive.
 */
/* Above this, an output goes up in parts.
 *
 * The Workers runtime refuses a request body much past 100 MB, and a 4K proxy
 * is routinely larger, so a single PUT cannot be the only way home. Well under
 * the cap rather than at it: the limit is the whole request, and the margin
 * costs nothing because a file under it takes the single PUT anyway.
 *
 * The node target has no such limit and does not need this, but the worker
 * cannot tell which target it is talking to and does not have to: one rule for
 * both, chosen by the only thing that matters, which is how big the file is. */
export const MULTIPART_THRESHOLD = 64 * 1024 * 1024;

const encodeKey = (key: string): string =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const failed = async (key: string, response: Response): Promise<Error> =>
  new Error(
    `${key} could not be stored: ${String(response.status)} ${await response
      .text()
      .catch(() => "")}`.trim(),
  );

/**
 * An output sent in parts, for one too large to be a single request body.
 *
 * Three steps against the one capability the claim handed out: start the
 * upload, send each part, then name the parts that make up the object. The
 * part size comes back from the server rather than being chosen here, because
 * it is a property of the storage underneath and not of this process.
 *
 * Nothing is retried. A part that fails fails the job, which is then retried
 * whole on some worker -- the same worker or another one -- and that is the
 * behaviour every other failure here already has. Resuming an upload across
 * attempts would mean an attempt inheriting authority from an earlier one,
 * which is exactly what the capability is scoped to prevent.
 */
const uploadInParts = async (
  template: string,
  key: string,
  file: string,
  size: number,
  options: {
    serverUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<void> => {
  const send = options.fetchImpl ?? fetch;
  const base = `${options.serverUrl.replace(/\/$/, "")}/`;
  const at = (action: string, query = ""): URL =>
    new URL(
      `${template.replace("{action}", action).replace("{key}", encodeKey(key))}${query}`,
      base,
    );
  const signal = () =>
    AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS);

  const started = await send(at("create"), {
    method: "POST",
    signal: signal(),
  });
  if (!started.ok) throw await failed(key, started);
  const upload = (await started.json()) as {
    upload_id?: unknown;
    part_size?: unknown;
  };
  const uploadId =
    typeof upload.upload_id === "string" ? upload.upload_id : undefined;
  const partSize =
    typeof upload.part_size === "number" && upload.part_size > 0
      ? upload.part_size
      : undefined;
  if (!uploadId || !partSize)
    throw new Error(`${key} could not be started as a multipart upload.`);

  const parts: Array<{ part: number; etag: string }> = [];
  const whole = await openAsBlob(file);
  for (
    let offset = 0, partNo = 1;
    offset < size;
    offset += partSize, partNo++
  ) {
    const end = Math.min(offset + partSize, size);
    const response = await send(
      at(
        "part",
        `&upload=${encodeURIComponent(uploadId)}&part=${String(partNo)}`,
      ),
      { method: "PUT", body: whole.slice(offset, end), signal: signal() },
    );
    if (!response.ok) throw await failed(key, response);
    const stored = (await response.json()) as { etag?: unknown };
    if (typeof stored.etag !== "string" || !stored.etag)
      throw new Error(
        `${key} part ${String(partNo)} was stored without a tag.`,
      );
    parts.push({ part: partNo, etag: stored.etag });
  }

  const done = await send(
    at("complete", `&upload=${encodeURIComponent(uploadId)}`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
      signal: signal(),
    },
  );
  if (!done.ok) throw await failed(key, done);
};

export const uploadBlob = async (
  template: string,
  key: string,
  file: string,
  options: {
    serverUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /* The multipart capability from the same claim. Absent only for a
       deployment that never issued one, in which case a file too large for a
       single body fails loudly at the server rather than silently here. */
    multipartTemplate?: string | undefined;
    threshold?: number;
  },
): Promise<void> => {
  const size = (await stat(file)).size;
  const threshold = options.threshold ?? MULTIPART_THRESHOLD;
  if (size > threshold && options.multipartTemplate)
    return uploadInParts(options.multipartTemplate, key, file, size, options);
  const target = new URL(
    template.replace("{key}", encodeKey(key)),
    `${options.serverUrl.replace(/\/$/, "")}/`,
  );
  const response = await (options.fetchImpl ?? fetch)(target, {
    method: "PUT",
    body: await openAsBlob(file),
    signal: AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) throw await failed(key, response);
};
