import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
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
