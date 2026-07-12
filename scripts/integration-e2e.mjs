#!/usr/bin/env node
/* Full-stack integration exercise against a running Onelight compose stack.
 *
 * The script drives the real HTTP API with plain fetch (no dependencies
 * beyond Node itself): workspace setup, login, project creation, ffmpeg
 * fixture synthesis on the host, multipart upload with CRC32C, probe and
 * transcode completion, rendition and proxy colorimetry assertions
 * (ffprobe), Range serving, the passphrase plus watermark share flow
 * (202-while-pending, burned rendition differs from the clean proxy), and
 * a Resolve marker EDL export. A second leg uploads a PQ (smpte2084)
 * clip and asserts the worker tonemapped it to a bt709 SDR proxy, which
 * exercises libplacebo inside the worker container.
 *
 * Usage:
 *   node scripts/integration-e2e.mjs            # run against BASE URL
 *   node scripts/integration-e2e.mjs --dry-run  # validate the plan, no network
 *
 * Environment:
 *   ONELIGHT_E2E_URL       base URL (default http://localhost:3000); must
 *                          equal the stack's PUBLIC_URL or origin checks fail
 *   ONELIGHT_E2E_EMAIL     admin email (default e2e-admin@example.com)
 *   ONELIGHT_E2E_PASSWORD  admin password (default an e2e-only value)
 *   FFMPEG_PATH / FFPROBE_PATH  tool overrides, same as the qa package
 *
 * The DF/NDF fixture decision: the SDR leg is ONE coherent drop-frame
 * fixture, 30000/1001 with -timecode 00:59:55;00 -write_tmcd on, because
 * 24000/1001 is a non-drop rate and a ";" label there would be incoherent.
 * The expected start frame 107742 is hand-derived per SMPTE ST 12-1 and
 * matches qa/src/tmcd.spec.ts: (59*60+55)*30 + 0 - 2*(539 - 53) = 107742.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/* Node 18+ global fetch, referenced through globalThis so the script needs
   no runtime-global assumptions from the linter. */
const { fetch } = globalThis;

const DRY_RUN = process.argv.includes("--dry-run");
const BASE_URL = (
  process.env.ONELIGHT_E2E_URL ?? "http://localhost:3000"
).replace(/\/$/, "");
const API = `${BASE_URL}/api/v1`;
const ADMIN_EMAIL = process.env.ONELIGHT_E2E_EMAIL ?? "e2e-admin@example.com";
const ADMIN_PASSWORD =
  process.env.ONELIGHT_E2E_PASSWORD ?? "integration-only-password";
const ADMIN_NAME = "Integration Admin";
const WORKSPACE_NAME = "Integration Workspace";
const SHARE_PASSPHRASE = "integration passphrase";

const DF_TIMECODE = "00:59:55;00";
const DF_RATE = { num: 30000, den: 1001 };
const EXPECTED_START_FRAME = 107742;
const SDR_SECONDS = 5;
const EXPECTED_SDR_FRAMES = 150; // 5 s of CFR 30000/1001 lavfi output
const HDR_SECONDS = 3;
const HDR_RATE = { num: 25, den: 1 };

const TRANSCODE_TIMEOUT_MS = 5 * 60_000;
const WATERMARK_TIMEOUT_MS = 4 * 60_000;
const EXPORT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 120_000;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const log = (line) => console.log(`[e2e] ${line}`);

const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};

const poll = async (label, timeoutMs, intervalMs, fn) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() + intervalMs > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(intervalMs);
  }
};

/* Minimal cookie jar; the API uses httpOnly session and share cookies. */
const makeJar = () => {
  const cookies = new Map();
  return {
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
    },
    header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    names() {
      return [...cookies.keys()];
    },
  };
};

/* Fetch wrapper: cookie jar, origin header on mutations (the API enforces
 * same-origin on cookie-authenticated writes), JSON in and out, and an
 * expected-status contract that dumps the response body on mismatch. */
const makeClient = (jar) => {
  return async (method, url, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method))
      headers.origin = BASE_URL;
    let body = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const response = await fetch(url, { method, headers, body });
    jar.store(response);
    const expected = options.expect ?? [200];
    if (!expected.includes(response.status)) {
      const text = await response.text().catch(() => "<unreadable>");
      throw new Error(
        `${method} ${url} returned ${response.status}, expected ${expected.join("/")}: ${text.slice(0, 800)}`,
      );
    }
    return response;
  };
};

/* ------------------------------------------------------------------ */
/* Process helpers                                                     */
/* ------------------------------------------------------------------ */

const ffmpegBin = () => process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH ?? "ffprobe";

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else
        reject(
          new Error(
            `${command} exited with ${code}: ${result.stderr.slice(-2000)}`,
          ),
        );
    });
  });

const ffprobeJson = async (file) => {
  const result = await run(ffprobeBin(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return JSON.parse(result.stdout);
};

/* ------------------------------------------------------------------ */
/* Fixture synthesis (argument builders are pure so --dry-run can      */
/* validate and print them without running ffmpeg)                     */
/* ------------------------------------------------------------------ */

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "C:\\Windows\\Fonts\\arial.ttf",
];

const findFontFile = () =>
  FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

const escapeFontPath = (fontFile) =>
  fontFile.replaceAll("\\", "/").replaceAll(":", "\\:");

const counterFilter = (fontFile) =>
  fontFile === null
    ? []
    : [
        `drawtext=fontfile='${escapeFontPath(fontFile)}':text='%{frame_num}':fontsize=140:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
      ];

/* Drop-frame SDR fixture: 30000/1001, 5 s, frame counter, sine audio (so
 * the audio_peaks rendition is planned), start timecode 00:59:55;00 with a
 * tmcd track, exactly the shape the proxy recipe re-embeds. */
export const sdrFixtureArgs = (outputPath, fontFile) => [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `color=c=0x2f2f2f:s=1280x720:r=${DF_RATE.num}/${DF_RATE.den}:d=${SDR_SECONDS}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${SDR_SECONDS}`,
  ...(fontFile ? ["-vf", counterFilter(fontFile).join(",")] : []),
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-g",
  "30",
  "-keyint_min",
  "30",
  "-sc_threshold",
  "0",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
  "-c:a",
  "aac",
  "-b:a",
  "96k",
  "-timecode",
  DF_TIMECODE,
  "-write_tmcd",
  "on",
  "-movflags",
  "+faststart",
  outputPath,
];

/* PQ (smpte2084) fixture: 10-bit testsrc2 tagged bt2020/smpte2084. The
 * pixels are not real PQ light, but the tags are what routes the transcode
 * through HDR_TONEMAP_FILTER (libplacebo on lavapipe in the container);
 * the assertion is that a bt709 SDR proxy comes out the other end. Small
 * frame size keeps software-Vulkan tonemapping fast. */
export const hdrFixtureArgs = (outputPath) => [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `testsrc2=s=640x360:r=${HDR_RATE.num}/${HDR_RATE.den}:d=${HDR_SECONDS}`,
  "-vf",
  "format=yuv420p10le",
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p10le",
  "-g",
  "25",
  "-keyint_min",
  "25",
  "-sc_threshold",
  "0",
  "-color_primaries",
  "bt2020",
  "-color_trc",
  "smpte2084",
  "-colorspace",
  "bt2020nc",
  "-color_range",
  "tv",
  "-movflags",
  "+faststart",
  outputPath,
];

/* ------------------------------------------------------------------ */
/* CRC32C: prefer the product implementation (@onelight/core) through  */
/* tsx so the checksum path under test is the shipped one; fall back   */
/* to a local table when the workspace toolchain is unavailable.       */
/* ------------------------------------------------------------------ */

const localCrc32cTable = (() => {
  const values = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    values[index] = value >>> 0;
  }
  return values;
})();

const localCrc32cHex = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (localCrc32cTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
};

const crc32cHexOfFile = async (file) => {
  try {
    const result = await run(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "crc32c-file.ts"), file],
      repoRoot,
    );
    const hex = result.stdout.trim();
    if (!/^[0-9a-f]{8}$/.test(hex)) throw new Error(`bad output: ${hex}`);
    log(`crc32c via @onelight/core (tsx): ${hex}`);
    return hex;
  } catch (error) {
    const hex = localCrc32cHex(await readFile(file));
    log(
      `crc32c via local fallback (${hex}); tsx path unavailable: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
    return hex;
  }
};

/* ------------------------------------------------------------------ */
/* API flows                                                           */
/* ------------------------------------------------------------------ */

const waitForHealth = async () => {
  await poll("server /healthz", HEALTH_TIMEOUT_MS, 2000, async () => {
    try {
      const response = await fetch(`${API}/healthz`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    return undefined;
  });
  log(`server healthy at ${BASE_URL}`);
};

const setupOrLogin = async (client) => {
  const bootstrap = await (await client("GET", `${API}/bootstrap`)).json();
  if (bootstrap.setup_required) {
    log("setup required; creating workspace and admin");
    await client("POST", `${API}/setup`, {
      json: {
        workspace_name: WORKSPACE_NAME,
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      },
      expect: [201],
    });
  } else {
    log("setup already complete; logging in");
    await client("POST", `${API}/auth/login`, {
      json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
  }
  const session = await (await client("GET", `${API}/auth/session`)).json();
  assert(session.user?.role === "admin", "authenticated user is admin");
  log(`authenticated as ${session.user.email}`);
};

const uploadAndAttach = async (client, projectId, filePath, filename) => {
  const size = (await stat(filePath)).size;
  const checksum = await crc32cHexOfFile(filePath);
  const created = await (
    await client("POST", `${API}/uploads`, {
      json: {
        project_id: projectId,
        filename,
        size,
        checksum_crc32c: checksum,
      },
      expect: [200, 201],
    })
  ).json();
  const uploadId = created.upload.id;
  const multipart = await (
    await client("POST", `${API}/uploads/${uploadId}/multipart`)
  ).json();
  const partSize = multipart.part_size;
  assert(
    Number.isInteger(partSize) && partSize > 0,
    `multipart part_size is a positive integer (got ${partSize})`,
  );
  const bytes = await readFile(filePath);
  const parts = [];
  for (let offset = 0, partNo = 1; offset < bytes.length; partNo += 1) {
    const chunk = bytes.subarray(offset, offset + partSize);
    const response = await client(
      "PUT",
      `${API}/uploads/${uploadId}/parts/${partNo}`,
      { body: chunk, expect: [204] },
    );
    const etag = response.headers.get("etag");
    assert(etag, `part ${partNo} returned an etag`);
    parts.push({ part_no: partNo, etag });
    offset += partSize;
  }
  log(`uploaded ${filename}: ${bytes.length} bytes in ${parts.length} part(s)`);
  await client("POST", `${API}/uploads/${uploadId}/complete`, {
    json: { parts, checksum_crc32c: checksum },
    expect: [202],
  });
  const asset = await (
    await client("POST", `${API}/projects/${projectId}/assets`, {
      json: { upload_id: uploadId },
      expect: [201],
    })
  ).json();
  log(
    `asset ${asset.id} created (version ${asset.version_id}, probe job ${asset.job_id})`,
  );
  return asset;
};

const failFastOnDeadJob = async (client, versionId) => {
  const dead = await (
    await client("GET", `${API}/admin/jobs?status=dead&limit=50`)
  ).json();
  const match = dead.items?.find(
    (job) => job.payload?.version_id === versionId,
  );
  if (match)
    throw new Error(
      `job ${match.id} (${match.kind}) is dead for version ${versionId}: ${match.error}`,
    );
};

const waitForReadyVersion = async (client, asset) => {
  await poll(
    `probe job ${asset.job_id}`,
    TRANSCODE_TIMEOUT_MS,
    2000,
    async () => {
      const job = await (
        await client("GET", `${API}/jobs/${asset.job_id}`)
      ).json();
      if (job.status === "complete") return true;
      if (job.status === "dead" || job.status === "failed")
        throw new Error(
          `probe job ${asset.job_id} ${job.status}: ${job.error}`,
        );
      return undefined;
    },
  );
  log("probe complete; waiting for transcode");
  return await poll(
    `version ${asset.version_id} transcode`,
    TRANSCODE_TIMEOUT_MS,
    3000,
    async () => {
      const version = await (
        await client("GET", `${API}/versions/${asset.version_id}`)
      ).json();
      if (version.transcode_status === "ready") return version;
      if (
        version.transcode_status === "failed" ||
        version.transcode_status === "skipped"
      )
        throw new Error(
          `version ${asset.version_id} transcode_status is ${version.transcode_status}`,
        );
      await failFastOnDeadJob(client, asset.version_id);
      return undefined;
    },
  );
};

const downloadBytes = async (client, url, headers = {}, expect = [200]) => {
  const response = await client("GET", url, { headers, expect });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
};

const videoStreamOf = (probe) =>
  (probe.streams ?? []).find((stream) => stream.codec_type === "video");

const assertBt709Proxy = (probe, label, expectedRate) => {
  const video = videoStreamOf(probe);
  assert(video, `${label}: proxy has a video stream`);
  assert(
    video.color_primaries === "bt709",
    `${label}: color_primaries is bt709 (got ${video.color_primaries})`,
  );
  assert(
    video.color_transfer === "bt709",
    `${label}: color_transfer is bt709 (got ${video.color_transfer})`,
  );
  const matrix = video.color_space ?? video.colorspace;
  assert(matrix === "bt709", `${label}: color matrix is bt709 (got ${matrix})`);
  assert(
    video.pix_fmt === "yuv420p",
    `${label}: pix_fmt is yuv420p (got ${video.pix_fmt})`,
  );
  assert(
    video.avg_frame_rate === `${expectedRate.num}/${expectedRate.den}`,
    `${label}: avg_frame_rate is ${expectedRate.num}/${expectedRate.den} (got ${video.avg_frame_rate})`,
  );
};

/* ------------------------------------------------------------------ */
/* Legs                                                                */
/* ------------------------------------------------------------------ */

const sdrLeg = async (client, projectId, workDir, fontFile) => {
  log("--- SDR drop-frame leg (30000/1001, 00:59:55;00) ---");
  const clipPath = path.join(workDir, "e2e-df-2997.mp4");
  await run(ffmpegBin(), sdrFixtureArgs(clipPath, fontFile));
  log(`synthesized ${clipPath}`);

  const asset = await uploadAndAttach(
    client,
    projectId,
    clipPath,
    "e2e-df-2997.mp4",
  );
  const version = await waitForReadyVersion(client, asset);

  /* Wire assertions: the DF fixture must come back exactly. */
  assert(
    version.frame_rate_num === DF_RATE.num &&
      version.frame_rate_den === DF_RATE.den,
    `version frame rate is ${DF_RATE.num}/${DF_RATE.den} (got ${version.frame_rate_num}/${version.frame_rate_den})`,
  );
  assert(version.drop_frame === true, "version drop_frame is true");
  assert(
    version.source_timecode_start === DF_TIMECODE,
    `source_timecode_start is ${DF_TIMECODE} (got ${version.source_timecode_start})`,
  );
  assert(
    version.source_start_frame === EXPECTED_START_FRAME,
    `source_start_frame is ${EXPECTED_START_FRAME} per SMPTE ST 12-1 (got ${version.source_start_frame})`,
  );
  assert(
    version.duration_frames === EXPECTED_SDR_FRAMES,
    `duration_frames is ${EXPECTED_SDR_FRAMES} (got ${version.duration_frames})`,
  );
  log("version wire: rate, drop_frame, start frame, and duration all match");

  const renditions = await (
    await client("GET", `${API}/versions/${asset.version_id}/renditions`)
  ).json();
  const kinds = renditions.items.map((item) => item.kind);
  for (const required of ["proxy_1080", "poster", "sprite", "audio_peaks"])
    assert(
      kinds.includes(required),
      `renditions include ${required} (got ${kinds.join(", ")})`,
    );
  log(`renditions present: ${kinds.sort().join(", ")}`);

  const proxy = renditions.items.find((item) => item.kind === "proxy_1080");
  assert(proxy.url, "proxy_1080 rendition carries a signed URL");

  const { bytes: proxyBytes } = await downloadBytes(client, proxy.url);
  const proxyPath = path.join(workDir, "downloaded-proxy-1080.mp4");
  await writeFile(proxyPath, proxyBytes);
  const probe = await ffprobeJson(proxyPath);
  assertBt709Proxy(probe, "proxy_1080", DF_RATE);
  const tmcd = (probe.streams ?? []).find(
    (stream) =>
      stream.codec_tag_string === "tmcd" || stream.codec_name === "tmcd",
  );
  assert(tmcd, "proxy_1080 carries a tmcd timecode track");
  const timecodeTag =
    probe.format?.tags?.timecode ??
    (probe.streams ?? [])
      .map((stream) => stream.tags?.timecode)
      .find((value) => typeof value === "string");
  assert(
    timecodeTag === DF_TIMECODE,
    `proxy timecode tag is ${DF_TIMECODE} (got ${timecodeTag})`,
  );
  log("proxy ffprobe: bt709 tags, tmcd track, and DF timecode re-embedded");

  const range = await client("GET", proxy.url, {
    headers: { range: "bytes=0-1023" },
    expect: [206],
  });
  const rangeBytes = Buffer.from(await range.arrayBuffer());
  assert(rangeBytes.length === 1024, "range request returned 1024 bytes");
  const contentRange = range.headers.get("content-range") ?? "";
  assert(
    /^bytes 0-1023\/\d+$/.test(contentRange),
    `content-range header is well-formed (got ${contentRange})`,
  );
  log("range request served 206 with a correct content-range");

  return { asset, version, proxyBytes };
};

const shareAndWatermarkLeg = async (client, projectId, asset, proxyBytes) => {
  log("--- share, watermark, and viewer leg ---");
  const commentBody =
    "Reel 42 note: keep | pipes intact\nsecond line for the EDL";
  await client("POST", `${API}/versions/${asset.version_id}/comments`, {
    json: { frame_in: 24, frame_out: 48, body_text: commentBody },
    expect: [201],
  });
  log("comment created at frame 24");

  const shareCreated = await (
    await client("POST", `${API}/shares`, {
      json: {
        project_id: projectId,
        title: "Integration Review",
        asset_ids: [asset.id],
        passphrase: SHARE_PASSPHRASE,
        allow_comments: true,
        allow_download: "none",
        watermark_spec: {
          text: "ONELIGHT {share} {date}",
          position: "tile",
          opacity: 0.7,
          size: 0.06,
          box: true,
        },
      },
      expect: [201],
    })
  ).json();
  const share = shareCreated.share;
  log(`share ${share.id} created with slug ${share.slug}`);

  /* Viewer flow uses its own cookie jar: no admin session involved. */
  const viewerJar = makeJar();
  const viewer = makeClient(viewerJar);
  await viewer("POST", `${API}/s/${share.slug}/access`, {
    json: {
      passphrase: SHARE_PASSPHRASE,
      name: "Integration Viewer",
      email: "viewer@example.com",
    },
  });
  assert(
    viewerJar.names().some((name) => name.startsWith("ol_share_")),
    "viewer cookie was issued",
  );
  log("viewer authenticated with the passphrase");

  const mediaUrl = `${API}/s/${share.slug}/assets/${asset.id}/media`;
  const first = await viewer("GET", mediaUrl, { expect: [200, 202] });
  assert(
    first.status === 202,
    `watermarked media is 202 processing right after share creation (got ${first.status})`,
  );
  const firstBody = await first.json();
  assert(
    firstBody.status === "processing",
    "202 body carries status processing",
  );
  log("watermarked media correctly answered 202 while the burn is pending");

  const ready = await poll(
    "watermarked rendition",
    WATERMARK_TIMEOUT_MS,
    5000,
    async () => {
      const response = await viewer("GET", mediaUrl, { expect: [200, 202] });
      const body = await response.json();
      return response.status === 200 ? body : undefined;
    },
  );
  log("watermarked rendition is ready");

  const { bytes: watermarkedBytes } = await downloadBytes(viewer, ready.url);
  assert(
    !watermarkedBytes.equals(proxyBytes),
    "watermarked bytes differ from the clean proxy",
  );
  const ratio = watermarkedBytes.length / proxyBytes.length;
  assert(
    watermarkedBytes.length > 100_000 && ratio > 0.2 && ratio < 5,
    `watermarked size is plausible (clean ${proxyBytes.length}, burned ${watermarkedBytes.length})`,
  );
  log(
    `watermark burned: clean ${proxyBytes.length} bytes, burned ${watermarkedBytes.length} bytes (drawtext changed the encode)`,
  );

  return { share, commentBody };
};

const edlExportLeg = async (client, share, commentBody) => {
  log("--- Resolve marker EDL export leg ---");
  const created = await (
    await client("POST", `${API}/shares/${share.id}/export`, {
      json: { format: "resolve_edl" },
      expect: [202],
    })
  ).json();
  const exportId = created.id;
  await poll(`export ${exportId}`, EXPORT_TIMEOUT_MS, 2000, async () => {
    const job = await (
      await client("GET", `${API}/exports/${exportId}`)
    ).json();
    if (job.status === "complete") return true;
    if (job.status === "failed") throw new Error(`export failed: ${job.error}`);
    return undefined;
  });
  const download = await (
    await client("GET", `${API}/exports/${exportId}/download`)
  ).json();
  const { bytes } = await downloadBytes(client, download.url);
  const edl = bytes.toString("utf8");
  assert(edl.startsWith("TITLE: "), "EDL starts with a TITLE line");
  assert(
    edl.includes("FCM: DROP FRAME"),
    "EDL declares DROP FRAME for the DF version",
  );
  /* The exporter encodes pipes as "/" and newlines as the literal "\n". */
  const expectedMarker = commentBody
    .replaceAll("|", "/")
    .replace(/\r\n|\r|\n/g, "\\n");
  assert(
    edl.includes(`|M:${expectedMarker}`),
    `EDL carries the encoded marker text (looked for |M:${expectedMarker})`,
  );
  assert(/\|D:25(\s|$)/.test(edl), "EDL marker duration is 25 frames");
  log("EDL export: title, DF flag, encoded marker text, and duration verified");
};

const hdrLeg = async (client, projectId, workDir) => {
  log("--- HDR (PQ) tonemap leg ---");
  const clipPath = path.join(workDir, "e2e-pq.mp4");
  await run(ffmpegBin(), hdrFixtureArgs(clipPath));
  log(`synthesized ${clipPath}`);

  const asset = await uploadAndAttach(
    client,
    projectId,
    clipPath,
    "e2e-pq.mp4",
  );
  const version = await waitForReadyVersion(client, asset);

  const sourceVideo = videoStreamOf(version.media_info);
  assert(
    sourceVideo?.color_transfer === "smpte2084",
    `stored media_info shows the smpte2084 source transfer (got ${sourceVideo?.color_transfer})`,
  );

  const renditions = await (
    await client("GET", `${API}/versions/${asset.version_id}/renditions`)
  ).json();
  const kinds = renditions.items.map((item) => item.kind);
  assert(kinds.includes("proxy_1080"), "HDR source produced an SDR proxy_1080");
  log(
    `HDR renditions present: ${kinds.sort().join(", ")} (hdr_av1/hdr_hevc are non-primary; presence is informational)`,
  );

  const proxy = renditions.items.find((item) => item.kind === "proxy_1080");
  const { bytes } = await downloadBytes(client, proxy.url);
  const proxyPath = path.join(workDir, "downloaded-hdr-proxy.mp4");
  await writeFile(proxyPath, bytes);
  const probe = await ffprobeJson(proxyPath);
  assertBt709Proxy(probe, "tonemapped proxy", HDR_RATE);
  log(
    "tonemapped proxy is bt709 yuv420p: libplacebo ran inside the worker container",
  );
};

/* ------------------------------------------------------------------ */
/* Dry run: validate argument building and print the plan, no network  */
/* ------------------------------------------------------------------ */

const dryRun = () => {
  log("dry run: validating the plan without network or ffmpeg");
  const fontFile = findFontFile();
  const sdrArgs = sdrFixtureArgs("<work>/e2e-df-2997.mp4", fontFile);
  const hdrArgs = hdrFixtureArgs("<work>/e2e-pq.mp4");
  for (const plan of [
    { name: "sdr", args: sdrArgs },
    { name: "hdr", args: hdrArgs },
  ]) {
    assert(
      Array.isArray(plan.args) && plan.args.length > 10,
      `${plan.name} args are built`,
    );
    assert(
      plan.args.every((value) => typeof value === "string" && value.length > 0),
      `${plan.name} args are non-empty strings`,
    );
  }
  assert(
    sdrArgs.includes("-timecode") && sdrArgs.includes(DF_TIMECODE),
    "sdr fixture embeds the DF start timecode",
  );
  assert(sdrArgs.includes("-write_tmcd"), "sdr fixture writes a tmcd track");
  assert(hdrArgs.includes("smpte2084"), "hdr fixture is tagged smpte2084");
  assert(hdrArgs.includes("yuv420p10le"), "hdr fixture is 10-bit");
  assert(
    localCrc32cHex(Buffer.from("123456789")) === "e3069283",
    "local crc32c fallback matches the CRC-32C check value",
  );
  log(`base url: ${BASE_URL}`);
  log(`ffmpeg: ${ffmpegBin()}, ffprobe: ${ffprobeBin()}`);
  log(`drawtext font: ${fontFile ?? "none found (counter omitted)"}`);
  log(`sdr fixture argv: ffmpeg ${sdrArgs.join(" ")}`);
  log(`hdr fixture argv: ffmpeg ${hdrArgs.join(" ")}`);
  log(
    "plan: health check -> setup/login -> create project -> SDR DF upload " +
      "(multipart + crc32c) -> probe/transcode -> version wire asserts " +
      `(rate ${DF_RATE.num}/${DF_RATE.den}, drop_frame, start frame ${EXPECTED_START_FRAME}) -> ` +
      "renditions (proxy_1080, poster, sprite, audio_peaks) -> proxy ffprobe " +
      "(bt709 + tmcd) -> range 206 -> comment -> passphrase share with " +
      "watermark -> viewer 202 then burned rendition differs -> resolve EDL " +
      "export -> HDR PQ upload -> tonemapped bt709 proxy",
  );
  log("dry run ok");
};

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const main = async () => {
  if (DRY_RUN) {
    dryRun();
    return;
  }
  const adminJar = makeJar();
  const client = makeClient(adminJar);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "onelight-e2e-"));
  log(`work directory: ${workDir}`);
  try {
    await waitForHealth();
    await setupOrLogin(client);

    const project = await (
      await client("POST", `${API}/projects`, {
        json: { name: `Integration ${Date.now()}` },
        expect: [201],
      })
    ).json();
    log(`project ${project.id} created`);

    const fontFile = findFontFile();
    if (!fontFile) log("no known font file found; frame counter omitted");

    const { asset, proxyBytes } = await sdrLeg(
      client,
      project.id,
      workDir,
      fontFile,
    );
    const { share, commentBody } = await shareAndWatermarkLeg(
      client,
      project.id,
      asset,
      proxyBytes,
    );
    await edlExportLeg(client, share, commentBody);
    await hdrLeg(client, project.id, workDir);

    log("all integration assertions passed");
  } finally {
    if (process.env.ONELIGHT_E2E_KEEP_ARTIFACTS !== "1")
      await rm(workDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(
    `[e2e] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
