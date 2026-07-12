import type { Context } from "hono";
import type { z } from "zod";
import { AppError, errors } from "@onelight/core";
import type { Variables } from "./types.js";

const JSON_BODY_LIMIT = 1_048_576;

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

export const parseJsonValue = (value: string | null | undefined): unknown => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};
