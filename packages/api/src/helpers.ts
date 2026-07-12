import type { Context } from "hono";
import type { z } from "zod";
import { AppError, errors } from "@onelight/core";
import type { AppEnv, Variables } from "./types.js";

const JSON_BODY_LIMIT = 1_048_576;

/**
 * Rate-limit bucket key when the real client IP cannot be observed: no proxy
 * is trusted (TRUST_PROXY=false) and the runtime does not expose a peer
 * socket address (the Workers target, or a request re-dispatched without the
 * node-server bindings). Every such request shares one bucket, which is the
 * safe default: a spoofed header can never split it. Self-hosters who sit a
 * reverse proxy in front of Onelight must set TRUST_PROXY=true so the real
 * client IP is read from CF-Connecting-IP / X-Forwarded-For instead.
 */
const PROXYLESS_IP = "no-socket";

/**
 * The peer socket address, when the Node server exposes it. @hono/node-server
 * passes the underlying IncomingMessage as the Hono env (directly, or nested
 * under `server` in some versions); its socket.remoteAddress is the real,
 * unspoofable client address. On Workers, and in the in-memory test harness,
 * env carries no socket, so this returns undefined.
 */
const socketAddress = (
  c: Context<{ Variables: Variables }>,
): string | undefined => {
  const bindings = c.env as
    | {
        incoming?: { socket?: { remoteAddress?: unknown } };
        server?: { incoming?: { socket?: { remoteAddress?: unknown } } };
      }
    | undefined;
  const incoming = bindings?.incoming ?? bindings?.server?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === "string" && address.length > 0
    ? address
    : undefined;
};

/**
 * The client IP used for rate-limit buckets. TRUST_PROXY=false (default)
 * NEVER trusts request headers: a spoofed X-Forwarded-For cannot split a
 * bucket, because only the peer socket address (or a shared constant when it
 * is unavailable) is used. TRUST_PROXY=true trusts the proxy chain, reading
 * CF-Connecting-IP first, then the rightmost X-Forwarded-For hop (the address
 * the nearest trusted proxy observed).
 */
export const clientIp = (
  c: Context<{ Variables: Variables }>,
  env: AppEnv,
): string => {
  if (env.config.TRUST_PROXY) {
    const cfConnecting = c.req.header("cf-connecting-ip")?.trim();
    if (cfConnecting) return cfConnecting;
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded
        .split(",")
        .map((hop) => hop.trim())
        .filter(Boolean);
      const rightmost = hops[hops.length - 1];
      if (rightmost) return rightmost;
    }
    return "unknown";
  }
  return socketAddress(c) ?? PROXYLESS_IP;
};

export const jsonBody = async <S extends z.ZodTypeAny>(
  c: Context<{ Variables: Variables }>,
  schema: S,
): Promise<z.output<S>> => {
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > JSON_BODY_LIMIT) throw errors.payloadTooLarge();
  // Read the stream directly so chunked bodies cannot bypass the cap.
  const source = c.req.raw.body;
  if (!source) throw errors.validation("Request body must be valid JSON.");
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > JSON_BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw errors.payloadTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw errors.validation("Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw errors.validation("Request validation failed.", {
      issues: parsed.error.issues,
    });
  return parsed.data as z.output<S>;
};

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const fromBase64Url = (value: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
      char.charCodeAt(0),
    ),
  );

const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const cursorParam = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const decoded = fromBase64Url(value);
    if (!ULID_PATTERN.test(decoded)) throw new Error("invalid cursor");
    return decoded;
  } catch {
    throw errors.validation("Cursor is invalid.");
  }
};

export const encodeCursor = (id: string): string => toBase64Url(id);

export interface CommentCursor {
  f: number;
  id: string;
}

export const encodeCommentCursor = (frame: number, id: string): string =>
  toBase64Url(JSON.stringify({ f: frame, id }));

export const commentCursorParam = (
  value: string | undefined,
): CommentCursor | undefined => {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(fromBase64Url(value)) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof (decoded as CommentCursor).f !== "number" ||
      !Number.isInteger((decoded as CommentCursor).f) ||
      typeof (decoded as CommentCursor).id !== "string" ||
      !ULID_PATTERN.test((decoded as CommentCursor).id)
    )
      throw new Error("invalid cursor");
    return {
      f: (decoded as CommentCursor).f,
      id: (decoded as CommentCursor).id,
    };
  } catch {
    throw errors.validation("Cursor is invalid.");
  }
};

export interface SearchCursor {
  t: "asset" | "comment";
  /** Continue after this ULID; absent means the start of the stream. */
  id?: string;
}

export const encodeSearchCursor = (t: SearchCursor["t"], id?: string): string =>
  toBase64Url(JSON.stringify(id ? { t, id } : { t }));

export const searchCursorParam = (
  value: string | undefined,
): SearchCursor | undefined => {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(fromBase64Url(value)) as unknown;
    const cursor = decoded as SearchCursor;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      (cursor.t !== "asset" && cursor.t !== "comment") ||
      (cursor.id !== undefined &&
        (typeof cursor.id !== "string" || !ULID_PATTERN.test(cursor.id)))
    )
      throw new Error("invalid cursor");
    return cursor.id === undefined ? { t: cursor.t } : cursor;
  } catch {
    throw errors.validation("Cursor is invalid.");
  }
};

export const getLimit = (value: string | undefined): number => {
  if (!value) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw errors.validation("Limit must be an integer between 1 and 200.");
  return limit;
};

export const userFromContext = (c: Context<{ Variables: Variables }>) => {
  const user = c.get("user");
  if (!user) throw errors.unauthorized();
  return user;
};

export const mapError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  if (error instanceof SyntaxError) return errors.validation();
  return errors.internal();
};

export const parseJsonObject = (
  value: string | null | undefined,
): Record<string, unknown> => {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

/**
 * Hashtags are derived from comment body text, never stored: #[a-z0-9_]+
 * case-insensitive, deduplicated, lowercased, in order of first appearance.
 */
export const extractHashtags = (text: string): string[] => {
  const tags: string[] = [];
  for (const match of text.matchAll(/#([a-z0-9_]+)/gi)) {
    const tag = (match[1] ?? "").toLowerCase();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
};

export const parseJsonValue = (value: string | null | undefined): unknown => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};
