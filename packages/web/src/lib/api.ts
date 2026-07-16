import { goto } from "$app/navigation";
import type { paths } from "./api-types.gen.js";

/* Thin typed fetch wrapper for the Onelight REST API.
   Unwraps the { error: { code, message } } envelope into a typed ApiError and
   redirects to /login on 401 outside the public surfaces.
   The typed helpers at the bottom are built on the generated OpenAPI types
   (api-types.gen.ts, regenerated with `pnpm openapi:gen`). */

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

const PUBLIC_PREFIXES = ["/login", "/setup", "/invite", "/reset", "/s"];

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

/* Defaults to void, because most DELETEs answer 204. Some answer with the
   object they changed -- reopening a comment returns the reopened comment --
   so the shape is a parameter rather than a second helper. */
export const apiDelete = <T = void>(path: string, init?: ApiInit): Promise<T> =>
  api<T>(path, { method: "DELETE", ...init });

export const messageFrom = (caught: unknown, fallback: string): string =>
  caught instanceof ApiError || caught instanceof Error
    ? caught.message || fallback
    : fallback;

/* Response types derived from the generated OpenAPI document: one source of
   truth with the server's zod validators. */
type JsonOf<T> = T extends { content: { "application/json": infer B } }
  ? B
  : never;
type Get<P extends keyof paths> = paths[P] extends {
  get: { responses: infer R };
}
  ? JsonOf<R[Extract<keyof R, 200 | "200">]>
  : never;
type PostBody<P extends keyof paths> = paths[P] extends {
  post: { requestBody: { content: { "application/json": infer B } } };
}
  ? B
  : never;
type Created<P extends keyof paths> = paths[P] extends {
  post: { responses: infer R };
}
  ? JsonOf<R[Extract<keyof R, 201 | "201">]>
  : never;
type PatchBody<P extends keyof paths> = paths[P] extends {
  patch: { requestBody: { content: { "application/json": infer B } } };
}
  ? B
  : never;

export type SessionResponse = Get<"/api/v1/auth/session">;
export type BootstrapResponse = Get<"/api/v1/bootstrap">;
export type ProjectPage = Get<"/api/v1/projects">;
export type Project = ProjectPage["items"][number];
export type ProjectCreateBody = PostBody<"/api/v1/projects">;
export type ProjectCreated = Created<"/api/v1/projects">;
export type AssetPage = Get<"/api/v1/projects/{id}/assets">;
export type Asset = Get<"/api/v1/assets/{id}">;
export type VersionList = Get<"/api/v1/assets/{id}/versions">;
export type Version = VersionList["items"][number];
export type CommentPage = Get<"/api/v1/versions/{id}/comments">;
export type Comment = CommentPage["items"][number];
export type NotificationPage = Get<"/api/v1/notifications">;
export type SearchPage = Get<"/api/v1/search">;
export type SearchHit = SearchPage["items"][number];
export type ShareList = Get<"/api/v1/shares">;
export type Share = ShareList["items"][number];
export type ShareCreateBody = PostBody<"/api/v1/shares">;
export type ShareCreated = Created<"/api/v1/shares">;
export type SharePatchBody = PatchBody<"/api/v1/shares/{id}">;
export type RenditionList = Get<"/api/v1/versions/{id}/renditions">;
export type Rendition = RenditionList["items"][number];

export type ShareViewerList = Get<"/api/v1/shares/{id}/viewers">;
export type ShareViewer = ShareViewerList["items"][number];
export type VersionCreated = Created<"/api/v1/assets/{id}/versions">;

/* The share watermark spec crosses the wire as a loose JSON record; this is
   the concrete shape the transcode worker consumes (media.ts WatermarkSpec). */
export type WatermarkSpec = {
  text?: string;
  position?: "tl" | "tr" | "bl" | "br" | "center" | "tile";
  opacity?: number;
  size?: number;
  box?: boolean;
};

/* Typed helpers for the common read paths. Pages may keep hand-rolled calls;
   these give new code a contract-typed entry point. */
export const getBootstrap = (): Promise<BootstrapResponse> =>
  api<BootstrapResponse>("/api/v1/bootstrap", { redirectOn401: false });
export const getSession = (): Promise<SessionResponse> =>
  api<SessionResponse>("/api/v1/auth/session", { redirectOn401: false });
export const listProjects = (cursor?: string): Promise<ProjectPage> =>
  api<ProjectPage>(
    `/api/v1/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
export const getProject = (id: string): Promise<Project> =>
  api<Project>(`/api/v1/projects/${id}`);
export const createProject = (
  body: ProjectCreateBody,
): Promise<ProjectCreated> => apiPost<ProjectCreated>("/api/v1/projects", body);
export const listProjectAssets = (
  projectId: string,
  cursor?: string,
): Promise<AssetPage> =>
  api<AssetPage>(
    `/api/v1/projects/${projectId}/assets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
export const getAsset = (id: string): Promise<Asset> =>
  api<Asset>(`/api/v1/assets/${id}`);
export const listVersions = (assetId: string): Promise<VersionList> =>
  api<VersionList>(`/api/v1/assets/${assetId}/versions`);
export const listComments = (
  versionId: string,
  cursor?: string,
): Promise<CommentPage> =>
  api<CommentPage>(
    `/api/v1/versions/${versionId}/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
export const listNotifications = (cursor?: string): Promise<NotificationPage> =>
  api<NotificationPage>(
    `/api/v1/notifications?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
export const searchWorkspace = (options: {
  q: string;
  scope?: "all" | "assets" | "comments";
  limit?: number;
  cursor?: string;
}): Promise<SearchPage> => {
  const params = new URLSearchParams({ q: options.q });
  if (options.scope) params.set("scope", options.scope);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  return api<SearchPage>(`/api/v1/search?${params.toString()}`);
};
export const listShares = (projectId?: string): Promise<ShareList> =>
  api<ShareList>(
    `/api/v1/shares${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`,
  );
export const createShare = (body: ShareCreateBody): Promise<ShareCreated> =>
  apiPost<ShareCreated>("/api/v1/shares", body);
export const updateShare = (id: string, body: SharePatchBody): Promise<Share> =>
  apiPatch<Share>(`/api/v1/shares/${id}`, body);
export const revokeShare = (id: string): Promise<void> =>
  apiDelete(`/api/v1/shares/${id}`);
export const listShareViewers = (id: string): Promise<ShareViewerList> =>
  api<ShareViewerList>(`/api/v1/shares/${id}/viewers`);
export const listRenditions = (versionId: string): Promise<RenditionList> =>
  api<RenditionList>(`/api/v1/versions/${versionId}/renditions`);
export const createAssetVersion = (
  assetId: string,
  body: { upload_id: string; name?: string; carry_forward?: boolean },
): Promise<VersionCreated> =>
  apiPost<VersionCreated>(`/api/v1/assets/${assetId}/versions`, body);
export const requestPasswordReset = (email: string): Promise<void> =>
  apiPost<void>(
    "/api/v1/auth/reset-request",
    { email },
    { redirectOn401: false },
  );
export const resetPassword = (token: string, password: string): Promise<void> =>
  apiPost<void>(
    "/api/v1/auth/reset",
    { token, password },
    { redirectOn401: false },
  );
