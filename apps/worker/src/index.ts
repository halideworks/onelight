import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { MediaInfo, TranscodeJob } from "@onelight/core";
import {
  extractStill,
  probeFile,
  renderWatermark,
  runTranscode,
} from "@onelight/worker";
import type { WatermarkSpec, WatermarkTokens } from "@onelight/worker";

interface WorkerOutput {
  kind: string;
  path: string;
  height?: number;
}
interface WorkerRequest {
  job_id: string;
  kind: "probe" | "transcode" | "still" | "watermark";
  timestamp?: number;
  source_path?: string;
  source_url?: string;
  media_info?: MediaInfo;
  outputs?: WorkerOutput[];
  output_path?: string;
  frame?: number;
  rate?: { num: number; den: number };
  spec?: WatermarkSpec;
  tokens?: WatermarkTokens;
  callback_url?: string;
  callback_secret?: string;
}
interface JobState {
  status: "queued" | "processing" | "complete" | "failed";
  result?: unknown;
  error?: string;
  finishedAt?: number;
}

const port = Number(process.env.PORT ?? 8080);
const secret = process.env.WORKER_SECRET ?? "";
const workRoot = path.resolve(process.env.WORK_ROOT ?? "/data/work");
const jobs = new Map<string, JobState>();
const SIGNATURE_SKEW_MS = 5 * 60_000;
const PRUNE_AFTER_MS = 60 * 60_000;

const validSignature = (
  body: string,
  header: string | string[] | undefined,
  signingSecret = secret,
): boolean => {
  const value = Array.isArray(header) ? header[0] : header;
  if (!signingSecret || !value || !/^[0-9a-f]{64}$/i.test(value)) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(body)
    .digest("hex");
  return timingSafeEqual(
    Buffer.from(value, "hex"),
    Buffer.from(expected, "hex"),
  );
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 1_048_576) {
        request.destroy();
        reject(new Error("Job payload is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

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

const sourceFor = (body: WorkerRequest): string => {
  const source = body.source_path ?? body.source_url;
  if (!source) throw new Error("A source_path or source_url is required.");
  return source;
};

const callback = async (body: WorkerRequest, event: unknown): Promise<void> => {
  if (!body.callback_url || !body.callback_secret) return;
  const payload = JSON.stringify(event);
  const signature = createHmac("sha256", body.callback_secret)
    .update(payload)
    .digest("hex");
  await fetch(body.callback_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onelight-signature": signature,
    },
    body: payload,
  });
};

const runJob = async (body: WorkerRequest): Promise<void> => {
  jobs.set(body.job_id, { status: "processing" });
  try {
    const source = sourceFor(body);
    // Still and watermark jobs run against an already-probed proxy; the
    // single output lands via the same temp-name-and-rename convention as
    // transcode renditions.
    if (body.kind === "still" || body.kind === "watermark") {
      if (!body.output_path) throw new Error("An output_path is required.");
      if (body.kind === "still") {
        if (typeof body.frame !== "number" || !Number.isInteger(body.frame))
          throw new Error("An integer frame is required.");
        await extractStill(
          source,
          body.output_path,
          body.frame,
          body.rate ?? { num: 24, den: 1 },
        );
      } else {
        await renderWatermark(
          source,
          body.output_path,
          body.spec ?? {},
          body.tokens ?? {},
          body.rate,
        );
      }
      const complete = {
        job_id: body.job_id,
        status: "complete",
        renditions: [
          {
            kind: body.kind === "still" ? "still" : "watermarked",
            key: body.output_path,
            meta: body.kind === "still" ? { frame: body.frame } : {},
          },
        ],
        failures: [],
      };
      jobs.set(body.job_id, {
        status: "complete",
        result: complete,
        finishedAt: Date.now(),
      });
      await callback(body, complete);
      return;
    }
    const mediaInfo = body.media_info ?? (await probeFile(source));
    if (body.kind === "probe") {
      const result = {
        job_id: body.job_id,
        status: "complete",
        media_info: mediaInfo,
      };
      jobs.set(body.job_id, {
        status: "complete",
        result,
        finishedAt: Date.now(),
      });
      await callback(body, result);
      return;
    }
    await mkdir(workRoot, { recursive: true });
    const outputs = body.outputs ?? [];
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
    const result = await runTranscode(transcodeJob, outputs);
    const complete = {
      job_id: body.job_id,
      status: "complete",
      renditions: result.renditions,
      failures: result.failures,
    };
    jobs.set(body.job_id, {
      status: "complete",
      result: complete,
      finishedAt: Date.now(),
    });
    await callback(body, complete);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Worker job failed.";
    const failed = { job_id: body.job_id, status: "failed", error: message };
    jobs.set(body.job_id, {
      status: "failed",
      error: message,
      result: failed,
      finishedAt: Date.now(),
    });
    await callback(body, failed);
  }
};

const handler = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  if (request.method === "GET" && request.url === "/healthz") {
    json(response, 200, {
      status: "ok",
      worker: "onelight-worker",
      ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
      ffprobe: process.env.FFPROBE_PATH ?? "ffprobe",
    });
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/jobs/")) {
    // Status reads are signed over the full request path including a "ts"
    // timestamp, so probe results and filesystem paths never leak to
    // unauthenticated callers and a captured signed request cannot be
    // replayed beyond the skew window (mirrors the POST /jobs body timestamp).
    const signedPath = request.url;
    if (!validSignature(signedPath, request.headers["x-onelight-signature"])) {
      json(response, 401, { error: "invalid worker signature" });
      return;
    }
    const url = new URL(request.url, "http://worker");
    const ts = Number(url.searchParams.get("ts"));
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_SKEW_MS) {
      json(response, 401, { error: "stale or missing timestamp" });
      return;
    }
    const id = url.pathname.slice("/jobs/".length);
    const state = jobs.get(id);
    if (!state) {
      json(response, 404, { error: "job not found" });
      return;
    }
    json(response, 200, { job_id: id, ...state });
    return;
  }
  if (request.method !== "POST" || request.url !== "/jobs") {
    json(response, 404, { error: "not found" });
    return;
  }
  try {
    const bodyText = await readBody(request);
    if (!validSignature(bodyText, request.headers["x-onelight-signature"])) {
      json(response, 401, { error: "invalid worker signature" });
      return;
    }
    const body = JSON.parse(bodyText) as WorkerRequest;
    if (
      !body.job_id ||
      !["probe", "transcode", "still", "watermark"].includes(body.kind)
    ) {
      json(response, 400, { error: "invalid job" });
      return;
    }
    // Replay protection: the signed body carries a timestamp and stale
    // signatures are rejected beyond a five minute skew.
    if (
      typeof body.timestamp !== "number" ||
      Math.abs(Date.now() - body.timestamp) > SIGNATURE_SKEW_MS
    ) {
      json(response, 401, { error: "stale or missing timestamp" });
      return;
    }
    const existing = jobs.get(body.job_id);
    if (existing?.status === "complete") {
      json(response, 202, {
        accepted: true,
        job_id: body.job_id,
        duplicate: true,
      });
      return;
    }
    // A re-POST while the job is queued or processing must not spawn a
    // second concurrent ffmpeg run; only a failed job may re-run.
    if (existing?.status === "queued" || existing?.status === "processing") {
      json(response, 409, {
        error: "job is already processing",
        job_id: body.job_id,
        status: existing.status,
      });
      return;
    }
    jobs.set(body.job_id, { status: "queued" });
    void runJob(body);
    json(response, 202, { accepted: true, job_id: body.job_id });
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : "invalid job",
    });
  }
};

// Completed and failed jobs are pruned from the in-memory map after an hour
// so the map does not grow without bound.
const pruneTimer = setInterval(() => {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [id, state] of jobs)
    if (
      (state.status === "complete" || state.status === "failed") &&
      (state.finishedAt ?? 0) < cutoff
    )
      jobs.delete(id);
}, 600_000);
pruneTimer.unref();

const server = createServer((request, response) => {
  void handler(request, response);
});
server.listen(port, "0.0.0.0", () =>
  console.log(`Onelight worker listening on ${port}`),
);

const shutdown = (): void => {
  clearInterval(pruneTimer);
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
