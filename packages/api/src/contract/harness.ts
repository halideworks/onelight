import type { Hono } from "hono";
import type {
  AppConfig,
  IdGen,
  Mailer,
  MultipartBlobStore,
  PasswordHasher,
} from "@onelight/core";
import type { AppDb } from "@onelight/db";
import type { Variables } from "../types.js";

/**
 * Injectable clock shared by the whole suite. Tests advance it instead of
 * sleeping; tests that jump far into the future must restore it afterwards
 * (see travel()) so long-lived seeded sessions stay valid.
 */
export class FakeClock {
  private current: number;

  constructor(start = Date.now()) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}

/** Run fn with the clock advanced by deltaMs, then restore the clock. */
export const travel = async <T>(
  clock: FakeClock,
  deltaMs: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const before = clock.now();
  clock.advance(deltaMs);
  try {
    return await fn();
  } finally {
    clock.set(before);
  }
};

/**
 * In-memory Mailer for the contract suite: captures every message so tests
 * can pull reset tokens out of the delivered text. Legs without a mailer
 * (the Workers harness) leave ContractHarness.mailer unset and the suite
 * seeds token rows directly instead.
 */
export class StubMailer implements Mailer {
  readonly messages: Array<{ to: string; subject: string; text: string }> = [];

  send(message: { to: string; subject: string; text: string }): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
}

export interface ContractCapabilities {
  /** A MultipartBlobStore is wired into the app under test. */
  blob: boolean;
  /**
   * The store accepts completing several tiny parts. The in-memory store
   * does; R2 (and its Miniflare simulation) requires every part except the
   * last to be at least 5 MiB, so multi-part assembly is Node-only.
   */
  multipartAssembly: boolean;
}

export interface ContractHarness {
  app: Hono<{ Variables: Variables }>;
  db: AppDb;
  clock: FakeClock;
  ids: IdGen;
  hasher: PasswordHasher;
  config: AppConfig;
  blobStore: MultipartBlobStore | null;
  /** Present when the leg wires a StubMailer into the app under test. */
  mailer?: StubMailer;
  teardown?: () => Promise<void> | void;
}

export interface RequestOptions {
  method?: string;
  cookie?: string;
  bearer?: string;
  /**
   * Origin header handling: true sends PUBLIC_URL's origin, a string sends
   * that literal value, false suppresses it. Defaults to true for mutating
   * requests that carry a cookie (the app's CSRF rule), false otherwise.
   */
  origin?: boolean | string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const req = async (
  h: ContractHarness,
  path: string,
  options: RequestOptions = {},
): Promise<Response> => {
  const method =
    options.method ?? (options.json !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  const origin =
    options.origin ?? (MUTATING.has(method) && Boolean(options.cookie));
  if (origin)
    headers.origin =
      origin === true ? new URL(h.config.PUBLIC_URL).origin : origin;
  let body = options.body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  return h.app.request(path, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
};

export const json = async <T = Record<string, unknown>>(
  response: Response,
): Promise<T> => (await response.json()) as T;

export const cookieFrom = (response: Response): string =>
  response.headers.get("set-cookie")?.split(";")[0] ?? "";

export const errorCode = async (response: Response): Promise<string> => {
  const body = await json<{ error?: { code?: string } }>(response);
  return body.error?.code ?? "";
};

const CAMEL = /[A-Z]/;

/**
 * Assert that every key in a wire object (recursively) is snake_case: no
 * camelCase leakage from drizzle rows. Only apply to payloads whose nested
 * keys the suite controls.
 */
export const assertSnakeCaseKeys = (
  value: unknown,
  path = "$",
  problems: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSnakeCaseKeys(entry, `${path}[${index}]`, problems),
    );
    return problems;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (CAMEL.test(key)) problems.push(`${path}.${key}`);
      assertSnakeCaseKeys(nested, `${path}.${key}`, problems);
    }
  }
  return problems;
};

/** Field names that must never appear in any wire object. */
export const FORBIDDEN_WIRE_KEYS = [
  "password_hash",
  "passwordHash",
  "token_hash",
  "tokenHash",
  "passphrase_hash",
  "passphraseHash",
  "viewerKey",
  "payload_json",
  "payloadJson",
  "settings_json",
  "settingsJson",
  "idempotency_key",
  "idempotencyKey",
  "worker_id",
  "workerId",
];

export const forbiddenKeysIn = (
  value: unknown,
  extra: string[] = [],
  path = "$",
  problems: string[] = [],
): string[] => {
  const banned = new Set([...FORBIDDEN_WIRE_KEYS, ...extra]);
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, nested] of Object.entries(node)) {
        if (banned.has(key)) problems.push(`${at}.${key}`);
        walk(nested, `${at}.${key}`);
      }
    }
  };
  walk(value, path);
  return problems;
};

export interface SseEvent {
  id: string;
  event: string;
  data: string;
}

/** Parse a fully buffered SSE response body. */
export const parseSse = (text: string): SseEvent[] => {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const event: SseEvent = { id: "", event: "", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) event.id = line.slice(3).trim();
      else if (line.startsWith("event:")) event.event = line.slice(6).trim();
      else if (line.startsWith("data:"))
        event.data += (event.data ? "\n" : "") + line.slice(5).trim();
    }
    if (event.id || event.event || event.data) events.push(event);
  }
  return events;
};
