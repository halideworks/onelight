import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { cpus } from "node:os";
import path from "node:path";
import type { MediaInfo, TranscodeJob } from "@onelight/core";
import {
  captureIdentityFromTags,
  captureKeyOf,
  isStillSource,
  loadWorkerConfig,
} from "@onelight/core";
import {
  DEFAULT_WATERMARK_FONTFILE,
  SOFTWARE_ACCELERATION,
  exactWebCodecString,
  extractStill,
  fingerprintClipSignatures,
  frameIntervalSeconds,
  hardwareDecodeArgs,
  fingerprintStillSource,
  hardwareAccelerationName,
  playableRenditionMetadata,
  probeFile,
  renderWatermark,
  runTranscode,
  selectHardwareAcceleration,
} from "@onelight/worker";
import type {
  HardwareAcceleration,
  WatermarkSpec,
  WatermarkTokens,
} from "@onelight/worker";
import { canWriteInto, fetchSource, uploadBlob } from "./source.js";
import type { Fetched, SourceRef } from "./source.js";

interface WorkerOutput {
  kind: string;
  /* Where this output belongs in storage, and where it is written today. The
     key is what the worker reports back and what lands on a rendition row; the
     path is how it reaches the bytes while server and worker share a volume.
     P0-2 replaces the path with a presigned destination; the key does not
     change, because it never described a filesystem. */
  key: string;
  path: string;
  height?: number;
}
interface FingerprintSource {
  id: string;
  key?: string;
  path?: string;
  url?: string;
}
interface WorkerRequest {
  job_id: string;
  kind: "probe" | "transcode" | "still" | "watermark" | "fingerprint";
  source_key?: string;
  source_path?: string;
  source_url?: string;
  media_info?: MediaInfo;
  outputs?: WorkerOutput[];
  upload_url?: string;
  output_key?: string;
  output_path?: string;
  frame?: number;
  rate?: { num: number; den: number };
  timecode?: string;
  spec?: WatermarkSpec;
  tokens?: WatermarkTokens;
  sources?: FingerprintSource[];
}

/* What a claim hands back. The envelope is self-contained: everything needed
   to run the job travels with it, and the worker reads no database. */
interface Claim {
  job_id: string;
  kind: string;
  attempt: number;
  token: string;
  lease_ms: number;
  deadline_ms: number;
  request: WorkerRequest;
}

/* Parsed against the same manifest the server uses, so the worker's settings
   are governed by their declared types rather than by whatever each reader
   happened to accept. A malformed value stops the worker here, before it
   accepts a job it would run with the wrong settings. */
const workerConfig = loadWorkerConfig(process.env);
const port = workerConfig.PORT;
const secret = workerConfig.WORKER_SECRET ?? "";
const serverUrl = workerConfig.ONELIGHT_SERVER_URL.replace(/\/$/, "");
const workRoot = path.resolve(workerConfig.WORK_ROOT);
const ffmpeg = workerConfig.FFMPEG_PATH;
let hardwareAcceleration: HardwareAcceleration = SOFTWARE_ACCELERATION;
let capabilities: string[] = ["cpu"];

/* Encodes are the heaviest thing a box does, and a worker sharing a host with
   the site should leave cores alone. One claim per slot, no more. */
const slots = Math.max(
  1,
  workerConfig.mediaConcurrency ?? Math.max(1, cpus().length - 2),
);
/* How often an idle worker asks again, and the ceiling it backs off to. A busy
   worker never waits: each slot claims again the moment its job finishes. */
const CLAIM_INTERVAL_MS = 1000;
const IDLE_CEILING_MS = 5000;
/* Progress reports push the lease out. Three per lease, so two can be lost to
   a blip without the server deciding this worker is gone. */
const heartbeatIntervalMs = (leaseMs: number): number =>
  Math.max(2000, Math.floor(leaseMs / 3));

/* Distinct per container, and stable for the life of the process: the server
   records it on the job, checks it on every report, and mixes it into the
   token that scopes this worker to this attempt. */
const workerId = `${hostname()}-${String(process.pid)}`
  .replace(/[^A-Za-z0-9_.:-]/g, "-")
  .slice(0, 64);

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

/* Everything a job reads arrives through here: the file on the shared volume
   when there is one, and otherwise the URL the claim signed. */
const sourceFile = (reference: SourceRef, label: string): Promise<Fetched> =>
  fetchSource(reference, { workRoot, serverUrl, label });

/**
 * Where this worker will write what it produces, and whether it has to send it.
 *
 * The envelope names a place on the shared volume. If this process can write
 * there, that is where the rendition goes and nothing has to move afterwards.
 * If it cannot -- another machine, or the Workers target, where there is no
 * volume at all -- it encodes into its own scratch and uploads each output
 * when it is finished.
 */
const destinationsFor = async (
  body: WorkerRequest,
): Promise<{ outputs: WorkerOutput[]; sending: boolean }> => {
  const outputs = body.outputs ?? [];
  /* A probe of a video asks for nothing to be written, so there is nothing to
     place and nothing to send. Deciding otherwise would demand an upload URL
     for a job that produces no bytes. */
  if (outputs.length === 0) return { outputs, sending: false };
  if (await canWriteInto(path.dirname(outputs[0]?.path ?? "")))
    return { outputs, sending: false };
  /* Scratch that mirrors the key, so a PDF's pages/ nesting and the sprite's
     cue sheet still land beside the output they belong to, and the key each
     file maps back to is unchanged. */
  return {
    outputs: outputs.map((output) => ({
      ...output,
      path: path.join(workRoot, body.job_id, output.key),
    })),
    sending: true,
  };
};

/* Sending a single output where the envelope said outputs go, or nothing at
   all when the file is already in place on a shared volume. */
const senderFor = (
  body: WorkerRequest,
  sending: boolean,
): ((key: string, file: string) => Promise<void>) | null => {
  if (!sending) return null;
  const template = body.upload_url;
  if (!template)
    throw new Error(
      "This worker cannot write where the job said to, and was given no upload URL.",
    );
  return (key, file) => uploadBlob(template, key, file, { serverUrl });
};

/**
 * What a file the job produced is: its length and its sha256, measured here.
 *
 * Measured by the process that wrote the bytes, which is the only one that can
 * still see them once storage is an object store the server does not mount.
 * The server compares the length against what the store holds and records the
 * checksum, so this is read once, while the file is warm, instead of read
 * again on the server during the completion request.
 */
const describeFile = async (
  file: string,
): Promise<{ size: number; sha256: string }> => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    hash.update(bytes);
    size += bytes.byteLength;
  }
  return { size, sha256: hash.digest("hex") };
};

/**
 * The blob key for a file the media library reported by path.
 *
 * Every output the job was given carries both, so the mapping is the one the
 * server sent rather than anything derived from the shape of the filesystem.
 * A file written beside a planned output -- the sprite's cue sheet, a PDF's
 * page rasters -- maps through its directory, so those keep the key namespace
 * of the output they belong to. A path that matches nothing planned is not
 * something the server asked for, and is refused rather than guessed at.
 */
const keyForPath = (outputs: WorkerOutput[], file: string): string => {
  const resolved = path.resolve(file);
  const exact = outputs.find(
    (output) => path.resolve(output.path) === resolved,
  );
  if (exact) return exact.key;
  const nested = outputs
    .map((output) => ({
      dir: path.dirname(path.resolve(output.path)),
      keyDir: output.key.split("/").slice(0, -1).join("/"),
    }))
    .filter((entry) => resolved.startsWith(`${entry.dir}${path.sep}`))
    /* Longest directory first: a PDF's pages/ sits under the version's own
       directory, and the nearer of the two is the one that describes it. */
    .sort((left, right) => right.dir.length - left.dir.length)[0];
  if (!nested) throw new Error(`Nothing the job planned accounts for ${file}.`);
  const relative = path
    .relative(nested.dir, resolved)
    .split(path.sep)
    .join("/");
  return nested.keyDir ? `${nested.keyDir}/${relative}` : relative;
};

/**
 * What the worker says it wrote: a key, a length and a checksum per output.
 *
 * The server used to open each of these files itself to answer the same
 * question, which is only possible while the two processes share a volume.
 */
const describeRenditions = async (
  outputs: WorkerOutput[],
  produced: Array<{ kind: string; key: string; meta: Record<string, unknown> }>,
  send: ((key: string, file: string) => Promise<void>) | null,
): Promise<
  Array<{
    kind: string;
    key: string;
    size: number;
    sha256: string;
    meta: Record<string, unknown>;
  }>
> => {
  const described = [];
  for (const rendition of produced) {
    /* The media library reports where it wrote, by path. */
    const written = rendition.key;
    const meta = { ...rendition.meta };
    if (typeof meta.vtt_path === "string") {
      const vtt = await describeFile(meta.vtt_path);
      const vttKey = keyForPath(outputs, meta.vtt_path);
      if (send) await send(vttKey, meta.vtt_path);
      meta.vtt_key = vttKey;
      meta.vtt_size = vtt.size;
      delete meta.vtt_path;
    }
    const key = keyForPath(outputs, written);
    /* Measured before it is sent, and reported after: what the server checks
       is that the store ended up holding the length this worker measured. */
    const measured = await describeFile(written);
    if (send) await send(key, written);
    /* A rasterised PDF is one rendition and many files: the row points at the
       first page and its meta lists the rest, which the reader asks for by
       name. Sending only the one the row names would leave a document whose
       first page is the whole of it. */
    if (send && Array.isArray(meta.pages)) {
      const from = path.dirname(written);
      const under = key.split("/").slice(0, -1).join("/");
      for (const page of meta.pages)
        if (typeof page === "string" && page !== path.basename(written))
          await send(`${under}/${page}`, path.join(from, page));
    }
    described.push({ kind: rendition.kind, key, ...measured, meta });
  }
  return described;
};

const runOutputs = async (
  body: WorkerRequest,
  outputs: WorkerOutput[],
  mediaInfo: MediaInfo,
  source: string,
) => {
  await mkdir(workRoot, { recursive: true });
  const transcodeJob: TranscodeJob = {
    id: body.job_id,
    sourceKey: source,
    outputs: outputs.map((output) => ({
      kind: output.kind,
      key: output.path,
      ...(output.height === undefined ? {} : { width: output.height }),
    })),
    mediaInfo,
  };
  return runTranscode(
    transcodeJob,
    outputs,
    ffmpeg,
    workerConfig.PDFTOPPM_PATH,
    hardwareAcceleration,
    workerConfig.FFPROBE_PATH,
  );
};

/* What a file is, apart from its name: an exact capture identity where the
   file carries one, and a perceptual signature that only ever narrows. Both
   are computed here because both need a decoder, and a batch of them is one
   job so a delivery costs a handful rather than one per file. */
const runFingerprints = async (
  jobId: string,
  sources: FingerprintSource[],
): Promise<
  Array<{
    id: string;
    content_hash: string | null;
    capture_key: string | null;
    audio_hash?: string | null;
    motion_hash?: string | null;
    state: "ready" | "skipped" | "failed";
  }>
> => {
  await mkdir(workRoot, { recursive: true });
  const out = [];
  for (const entry of sources) {
    /* One at a time, and discarded before the next: a delivery of a hundred
       camera masters is one job, and holding all of them at once would fill
       any scratch disk this worker has. */
    let fetched: Fetched | null = null;
    try {
      fetched = await sourceFile(entry, `${jobId}-${entry.id}`);
      const file = fetched.path;
      if (isStillSource(file)) {
        const print = await fingerprintStillSource(file, { ffmpeg });
        out.push({
          id: entry.id,
          content_hash: print.contentHash,
          capture_key: captureKeyOf(print.capture),
          state: "ready" as const,
        });
        continue;
      }
      const info = await probeFile(file);
      const duration = Number(info.format.duration ?? 0);
      /* One decode for the picture, the cut and the sound, on the GPU where
         the codec allows it: the same numbers the seek path produces, for a
         third of the time. */
      const signatures = await fingerprintClipSignatures(file, {
        durationSeconds: duration,
        frameIntervalSeconds: frameIntervalSeconds(info),
        workDirectory: workRoot,
        withAudio: info.streams.some((stream) => stream.codec_type === "audio"),
        ffmpeg,
        tag: entry.id,
        decodeArgs: hardwareDecodeArgs(info, hardwareAcceleration),
      });
      out.push({
        id: entry.id,
        content_hash: signatures.content,
        audio_hash: signatures.audio,
        motion_hash: signatures.motion,
        capture_key: captureKeyOf(
          captureIdentityFromTags(
            (info.format.tags as Record<string, unknown>) ?? {},
            info.sourceTimecodeStart ?? null,
          ),
        ),
        /* A file with neither identity is not a failure: a screen grab has
           no capture time and a flat clip has no usable signature. */
        state: "ready" as const,
      });
    } catch {
      out.push({
        id: entry.id,
        content_hash: null,
        capture_key: null,
        state: "failed" as const,
      });
    } finally {
      if (fetched) await fetched.discard();
    }
  }
  return out;
};

/**
 * One job, run to its answer.
 *
 * Returns what the server writes down, and throws what the server records as
 * the failure. Nothing is kept afterwards: the job's state lives in the
 * server's row, which is the whole point of the worker being disposable.
 */
const runJob = async (
  body: WorkerRequest,
): Promise<Record<string, unknown>> => {
  if (body.kind === "fingerprint")
    return {
      fingerprints: await runFingerprints(body.job_id, body.sources ?? []),
    };
  const fetched = await sourceFile(
    { key: body.source_key, path: body.source_path, url: body.source_url },
    `${body.job_id}-source`,
  );
  try {
    return await runJobAgainst(body, fetched.path);
  } finally {
    await fetched.discard();
    /* Anything this job encoded into its own scratch has been sent by now, or
       the job failed and nobody wants it. Either way it does not survive the
       job: a worker that keeps them fills its disk and then fails everything. */
    await rm(path.join(workRoot, body.job_id), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
};

/** The job itself, once its source is a file this process can open. */
const runJobAgainst = async (
  body: WorkerRequest,
  source: string,
): Promise<Record<string, unknown>> => {
  // Still and watermark jobs run against an already-probed proxy; the single
  // output lands via the same temp-name-and-rename convention as transcode
  // renditions.
  if (body.kind === "still" || body.kind === "watermark") {
    if (!body.output_key) throw new Error("An output_key is required.");
    /* One output, chosen the same way the ladder's are: the shared path when
       this process can write it, and its own scratch when it cannot. */
    const shared =
      body.output_path && (await canWriteInto(path.dirname(body.output_path)));
    const outputPath = shared
      ? (body.output_path as string)
      : path.join(workRoot, body.job_id, body.output_key);
    await mkdir(path.dirname(outputPath), { recursive: true });
    if (body.kind === "still") {
      if (typeof body.frame !== "number" || !Number.isInteger(body.frame))
        throw new Error("An integer frame is required.");
      await extractStill(
        source,
        outputPath,
        body.frame,
        body.rate ?? { num: 24, den: 1 },
      );
    } else {
      await renderWatermark(
        source,
        outputPath,
        body.spec ?? {},
        body.tokens ?? {},
        body.rate,
        ffmpeg,
        DEFAULT_WATERMARK_FONTFILE,
        hardwareAcceleration,
        body.timecode,
      );
    }
    const meta =
      body.kind === "still"
        ? { frame: body.frame }
        : playableRenditionMetadata(
            await probeFile(outputPath),
            await exactWebCodecString(outputPath),
          );
    const measured = await describeFile(outputPath);
    const send = senderFor(body, !shared);
    if (send) await send(body.output_key, outputPath);
    return {
      renditions: [
        {
          kind: body.kind === "still" ? "still" : "watermarked",
          key: body.output_key,
          ...measured,
          meta,
        },
      ],
      failures: [],
    };
  }
  const mediaInfo = body.media_info ?? (await probeFile(source));
  const { outputs, sending } = await destinationsFor(body);
  const send = senderFor(body, sending);
  if (body.kind === "probe") {
    /* A probe that arrives carrying outputs is a still: its ladder does not
       depend on anything the probe finds, so it is rendered in this same call
       rather than costing a second job and a second round trip. */
    const rendered =
      outputs.length > 0
        ? await runOutputs(body, outputs, mediaInfo, source)
        : null;
    return {
      media_info: mediaInfo,
      ...(rendered
        ? {
            renditions: await describeRenditions(
              outputs,
              rendered.renditions,
              send,
            ),
            failures: rendered.failures,
            /* A still is probed and rendered in one call, so its identity
               comes back through this reply and not the transcode one. */
            ...(rendered.fingerprint
              ? { fingerprint: rendered.fingerprint }
              : {}),
          }
        : {}),
    };
  }
  const result = await runOutputs(body, outputs, mediaInfo, source);
  return {
    renditions: await describeRenditions(outputs, result.renditions, send),
    failures: result.failures,
    ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
  };
};

/* The job outran the ceiling the server handed down with it. Its own type
   because the response is drastic -- the worker stops -- and deciding that by
   matching on the text of an error message would let an ffmpeg that happened
   to say "ceiling" take the process down. */
class CeilingExceeded extends Error {}

/* Is the tool actually here? Spawning it is the only honest answer: a
   configured path can name a binary the image does not carry, and an image
   can carry one the operator never configured. A failing exit code still
   means present -- pdftoppm with no arguments is an error, and that is fine. */
const PROBE_TIMEOUT_MS = 5000;

const toolPresent = (command: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    /* Startup must not be able to hang on a tool that never exits: a worker
       stuck probing is a worker that never claims, with nothing in the log to
       say why. */
    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(giveUp);
      resolve(false);
    });
    child.once("close", () => {
      clearTimeout(giveUp);
      resolve(true);
    });
  });

const ffmpegLists = async (
  flag: string,
  needles: string[],
): Promise<boolean> => {
  try {
    const listing = await new Promise<string>((resolve, reject) => {
      const child = spawn(ffmpeg, ["-hide_banner", flag], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      const giveUp = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${ffmpeg} ${flag} did not answer.`));
      }, PROBE_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", (error) => {
        clearTimeout(giveUp);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(giveUp);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    return needles.some((needle) => listing.includes(needle));
  } catch {
    return false;
  }
};

/**
 * What this worker can actually do, probed rather than declared.
 *
 * The claim carries these and the server filters jobs against them, so a job
 * that needs a GPU is never handed to a box without one. Everything here is
 * measured: the hardware backend is the one the encoder probe actually got a
 * frame out of, and the tools are asked to run rather than assumed present
 * because a path variable has a default.
 */
const probeCapabilities = async (): Promise<string[]> => {
  const found = new Set<string>(["cpu"]);
  if (hardwareAcceleration.backend !== "software")
    found.add(hardwareAcceleration.backend);
  if (
    await ffmpegLists("-encoders", [
      "libsvtav1",
      "libaom-av1",
      "av1_nvenc",
      "av1_vaapi",
      "av1_qsv",
    ])
  )
    found.add("av1");
  if (await ffmpegLists("-filters", ["libplacebo"])) found.add("hdr");
  if (await toolPresent(workerConfig.DCRAW_PATH, ["-h"])) found.add("raw");
  if (await toolPresent(workerConfig.PDFTOPPM_PATH, ["-v"])) found.add("pdf");
  return [...found].sort();
};

let stopped = false;
let running = 0;
let idleDelay = CLAIM_INTERVAL_MS;

/* A claim, a heartbeat or a failure is a small round trip. A completion is
   the one report the server does real work behind: it asks storage about
   every object the job says it wrote, and writes the rows. It no longer reads
   those objects back -- the checksums arrive with the report -- but the
   allowance stays generous, because timing a completion out reports a failure
   for work the server was in the middle of accepting. */
const REPORT_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 10 * 60_000;

const post = async (
  route: string,
  body: Record<string, unknown>,
  /* Only the claim is signed with the shared secret. Everything after it
     presents the token that claim minted, which is authority over one attempt
     at one job and nothing else. */
  signed = false,
  timeoutMs = REPORT_TIMEOUT_MS,
): Promise<Response> => {
  const payload = JSON.stringify(body);
  return fetch(`${serverUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signed
        ? {
            "x-onelight-signature": createHmac("sha256", secret)
              .update(payload)
              .digest("hex"),
          }
        : {}),
    },
    body: payload,
    /* Node's fetch has no default timeout, and a server that stops answering
       mid-request would otherwise hold a slot open forever. */
    signal: AbortSignal.timeout(timeoutMs),
  });
};

/**
 * The worker gives up on everything and stops.
 *
 * Reached when a job outruns its ceiling or when the lease this worker was
 * holding has gone to somebody else. In both cases there may be an ffmpeg
 * still writing to the output path of a job another worker is now running,
 * and two writers on one path is corruption. Exiting is what makes that
 * impossible: the container dies, its children die with it, and the
 * supervisor starts a clean one. Jobs in flight lose their leases and are
 * retried, which is the case this whole protocol is built around.
 */
const abandonEverything = (reason: string): void => {
  if (stopped) return;
  stopped = true;
  console.error(`[onelight-worker] stopping: ${reason}`);
  // A moment for a completion that is already in flight to land.
  setTimeout(() => process.exit(1), 5000);
};

const runClaim = async (claim: Claim): Promise<void> => {
  const report = (
    route: string,
    extra: Record<string, unknown>,
    timeoutMs = REPORT_TIMEOUT_MS,
  ) =>
    post(
      `/api/v1/worker/jobs/${claim.job_id}/${route}`,
      {
        worker_id: workerId,
        attempt: claim.attempt,
        token: claim.token,
        ...extra,
      },
      false,
      timeoutMs,
    );
  let lost = false;
  /* The work is done and the answer is being posted. The heartbeat keeps
     running through it -- the server checks every object the report describes
     before it answers, which can outlast a lease -- but from here a 409 means
     the server has already settled this job, not that it was taken away
     mid-encode: nothing of ours is still writing. */
  let reporting = false;
  const beat = setInterval(() => {
    void (async () => {
      try {
        const response = await report("progress", {});
        /* 409 means this attempt no longer holds the job: the lease expired
           and somebody else has it. Nothing this run produces may be
           reported, and nothing it is still writing can be trusted. */
        if (response.status === 409 && !reporting) {
          lost = true;
          abandonEverything(
            `job ${claim.job_id} was taken from this worker while it was running`,
          );
        }
      } catch (error) {
        /* A missed heartbeat is survivable; the lease has room for two. */
        console.warn(
          `[onelight-worker] progress for ${claim.job_id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
  }, heartbeatIntervalMs(claim.lease_ms));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runJob(claim.request),
      new Promise<never>((unused, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new CeilingExceeded(
                `Job exceeded its ${String(
                  Math.round(claim.deadline_ms / 1000),
                )}s ceiling.`,
              ),
            ),
          claim.deadline_ms,
        );
      }),
    ]);
    if (lost) return;
    reporting = true;
    const response = await report("complete", { result }, COMPLETE_TIMEOUT_MS);
    if (!response.ok)
      console.warn(
        `[onelight-worker] completion for ${claim.job_id} was refused with ${String(
          response.status,
        )}.`,
      );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Worker job failed.";
    /* A job that outran its ceiling leaves an ffmpeg this process can no
       longer account for, so the worker reports the failure and then stops
       rather than carrying on beside it. */
    const outranCeiling = error instanceof CeilingExceeded;
    if (!lost)
      try {
        await report("fail", { error: message });
      } catch (inner) {
        console.warn(
          `[onelight-worker] could not report failure of ${claim.job_id}: ${
            inner instanceof Error ? inner.message : String(inner)
          }`,
        );
      }
    if (outranCeiling)
      abandonEverything(`job ${claim.job_id} outran its ceiling`);
  } finally {
    clearInterval(beat);
    if (deadline) clearTimeout(deadline);
  }
};

const claimOne = async (): Promise<Claim | null> => {
  const response = await post(
    "/api/v1/worker/claim",
    {
      worker_id: workerId,
      capabilities,
      timestamp: Date.now(),
    },
    true,
  );
  if (response.status === 204) return null;
  if (!response.ok)
    throw new Error(`Claim was refused with ${String(response.status)}.`);
  return (await response.json()) as Claim;
};

/* Slots, filled by pulling. Each slot claims again the moment its job
   finishes, so a queue drains continuously rather than one job per tick, and
   an idle worker backs off instead of asking every second forever. */
const pump = async (): Promise<void> => {
  while (!stopped && running < slots) {
    running += 1;
    let claim: Claim | null;
    try {
      claim = await claimOne();
    } catch (error) {
      running -= 1;
      idleDelay = Math.min(IDLE_CEILING_MS, idleDelay * 2);
      console.warn(
        `[onelight-worker] claim failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!claim) {
      running -= 1;
      idleDelay = Math.min(IDLE_CEILING_MS, idleDelay + CLAIM_INTERVAL_MS);
      return;
    }
    idleDelay = CLAIM_INTERVAL_MS;
    const taken = claim;
    void (async () => {
      try {
        await runClaim(taken);
      } catch (error) {
        console.warn(
          `[onelight-worker] job ${taken.job_id} ended badly: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        running -= 1;
        void pump();
      }
    })();
  }
};

/* Health only. The worker no longer accepts jobs over HTTP: there is nothing
   to POST to it, which is what makes running three of them behind no load
   balancer possible. */
const handler = (request: IncomingMessage, response: ServerResponse): void => {
  if (request.method === "GET" && request.url === "/healthz") {
    json(response, 200, {
      status: "ok",
      worker: "onelight-worker",
      worker_id: workerId,
      ffmpeg,
      ffprobe: workerConfig.FFPROBE_PATH,
      hardware_acceleration: hardwareAccelerationName(hardwareAcceleration),
      capabilities,
      slots,
    });
    return;
  }
  json(response, 404, { error: "not found" });
};

const server = createServer((request, response) => {
  handler(request, response);
});

let timer: ReturnType<typeof setInterval> | undefined;

const start = async (): Promise<void> => {
  hardwareAcceleration = await selectHardwareAcceleration(ffmpeg);
  console.log(
    `[onelight-worker] hardware acceleration: ${hardwareAccelerationName(hardwareAcceleration)}`,
  );
  capabilities = await probeCapabilities();
  console.log(`[onelight-worker] capabilities: ${capabilities.join(", ")}`);
  server.listen(port, "0.0.0.0", () =>
    console.log(
      `Onelight worker ${workerId} listening on ${String(port)}, claiming from ${serverUrl} with ${String(slots)} slot(s)`,
    ),
  );
  if (!secret) {
    /* Every claim would be refused, so asking is only noise. The health
       endpoint stays up, which is what makes the misconfiguration visible. */
    console.warn(
      "[onelight-worker] WORKER_SECRET is not set: this worker cannot claim any job and will not try.",
    );
    return;
  }
  /* One ticker, re-armed to the backoff the last pass settled on. A busy
     worker never waits on it: finishing a job calls pump() directly. */
  const tick = async (): Promise<void> => {
    await pump();
    if (!stopped) timer = setTimeout(() => void tick(), idleDelay);
  };
  await tick();
};
void start().catch((error: unknown) => {
  console.error(
    `[onelight-worker] startup failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});

const shutdown = (): void => {
  stopped = true;
  if (timer) clearTimeout(timer);
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
