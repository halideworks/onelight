import { goto } from "$app/navigation";

/* Thin typed fetch wrapper for the Onelight REST API.
   Unwraps the { error: { code, message } } envelope into a typed ApiError and
   redirects to /login on 401 outside the public surfaces.
   The spec's generated openapi-typescript client remains future work; this
   wrapper is the hand-written interim. */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const PUBLIC_PREFIXES = ["/login", "/setup", "/invite", "/s"];

const onPublicPage = (): boolean => {
  if (typeof location === "undefined") return true;
  const pathname = location.pathname;
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
};

export interface ApiInit extends RequestInit {
  /* Set false to surface a 401 to the caller instead of redirecting. */
  redirectOn401?: boolean;
}

export const api = async <T>(path: string, init?: ApiInit): Promise<T> => {
  const { redirectOn401 = true, ...request } = init ?? {};
  const response = await fetch(path, request);
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  let code = "request_failed";
  let message = `The request failed (${response.status}).`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    /* Non-JSON error body: keep the generic message. */
  }
  if (response.status === 401 && redirectOn401 && !onPublicPage())
    void goto("/login");
  throw new ApiError(response.status, code, message, details);
};

export const apiPost = <T>(
  path: string,
  body?: unknown,
  init?: ApiInit,
): Promise<T> =>
  api<T>(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    ...init,
  });

export const apiPatch = <T>(
  path: string,
  body: unknown,
  init?: ApiInit,
): Promise<T> =>
  api<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

export const apiDelete = (path: string, init?: ApiInit): Promise<void> =>
  api<void>(path, { method: "DELETE", ...init });

export const messageFrom = (caught: unknown, fallback: string): string =>
  caught instanceof ApiError || caught instanceof Error
    ? caught.message || fallback
    : fallback;
