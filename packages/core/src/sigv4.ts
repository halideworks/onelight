/* AWS Signature Version 4, for talking to object storage that is not a
 * Cloudflare binding.
 *
 * R2 is reached through a Workers binding today, which is the fastest path on
 * that runtime and the only one available to a Worker without credentials. It
 * is also the reason two things are currently impossible:
 *
 *   - handing a worker a URL it can read a 40 GB source from directly, rather
 *     than streaming those bytes through an isolate
 *   - storing blobs anywhere other than R2, when B2 is less than half the price
 *
 * Both need requests signed with an access key instead of a binding, which is
 * SigV4. Written here rather than pulled in because it is this much code, it
 * has to run on Workers as well as node, and the HMAC it needs is already in
 * `crypto.js` in WebCrypto form.
 *
 * Only what object storage actually uses: presigned URLs, and signing a
 * request's headers. No STS, no session tokens, no chunked payload signing.
 */
import { sha256Hex, utf8 } from "./crypto.js";

/* SigV4 derives its key by HMAC-ing with the previous HMAC's output, so every
   step after the first signs with binary rather than a string. `hmacSha256`
   in crypto.js takes a string secret, which is right for every other caller
   and wrong for this one. */
const hmac = async (
  key: Uint8Array | string,
  value: string,
): Promise<Uint8Array> => {
  const raw = typeof key === "string" ? utf8(key) : key;
  const imported = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, utf8(value) as BufferSource),
  );
};

const ALGORITHM = "AWS4-HMAC-SHA256";

/* S3 wants the payload hash for a presigned URL to be this literal rather
   than the hash of anything, because the body is not known when the URL is
   made and the recipient may send whatever they were given the URL for. */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /* The endpoint's host, without a scheme: `s3.us-west-004.backblazeb2.com`,
     or `<account>.r2.cloudflarestorage.com`. */
  host: string;
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/* Every byte outside the unreserved set is percent-encoded, including those
   `encodeURIComponent` leaves alone. AWS is strict about this and a signature
   over a differently-escaped path simply does not match. The forward slash is
   kept literal in a path and escaped in a query value, which is why the
   caller says which it wants. */
const uriEncode = (value: string, keepSlashes: boolean): string => {
  let out = "";
  for (const byte of utf8(value)) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(character)) out += character;
    else if (character === "/" && keepSlashes) out += character;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
};

/* A key derived per date, region and service, so a leaked signing key is
   useless tomorrow, elsewhere, or against another service. */
const signingKey = async (
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> => {
  const dateKey = await hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
};

/* AWS's own format: 20130524T000000Z, and the date half of it. */
export const amzDate = (at: Date): { stamp: string; date: string } => {
  const stamp = `${at.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
  return { stamp, date: stamp.slice(0, 8) };
};

/**
 * A URL that carries its own authorisation, good until it expires.
 *
 * What this is for: giving a media worker something ffmpeg can open and seek
 * inside without the bytes passing through the app at all. A presigned GET is
 * an ordinary GET, so Range works, which is what lets a worker decode a source
 * far larger than its own disk.
 *
 * Expiry is seconds, and S3 allows at most seven days.
 */
export const presignS3Url = async (
  credentials: S3Credentials,
  method: "GET" | "PUT" | "HEAD" | "DELETE",
  key: string,
  options: { expiresIn: number; now: Date; query?: Record<string, string> },
): Promise<string> => {
  const { stamp, date } = amzDate(options.now);
  const scope = `${date}/${credentials.region}/s3/aws4_request`;
  const canonicalPath = `/${uriEncode(key, true)}`;

  const parameters: Record<string, string> = {
    ...options.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(options.expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  /* Sorted by the encoded name, which is what AWS canonicalises on. */
  const canonicalQuery = Object.keys(parameters)
    .map((name): [string, string] => [
      uriEncode(name, false),
      uriEncode(parameters[name] ?? "", false),
    ])
    .sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    `host:${credentials.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hex(
    await hmac(
      await signingKey(
        credentials.secretAccessKey,
        date,
        credentials.region,
        "s3",
      ),
      stringToSign,
    ),
  );

  return `https://${credentials.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};
