import { z } from "zod";
import { PALETTES } from "@onelight/core";

/*
 * One source of truth for the public API contract.
 *
 * `bodies` holds the exact zod objects the routes pass to jsonBody; app.ts
 * imports them from here, so the OpenAPI document and the runtime
 * validators cannot drift. `wire` holds response shapes, and `routeDocs`
 * maps "METHOD /hono/path" to the request/response schemas the OpenAPI
 * builder publishes at /api/v1/openapi.json.
 */

const projectRole = z.enum(["manager", "editor", "commenter", "viewer"]);
const workspaceRole = z.enum(["admin", "member"]);
const approvalStatus = z.enum([
  "none",
  "in_review",
  "approved",
  "changes_requested",
]);
const allowDownload = z.enum(["none", "proxy", "original"]);
const shareLayout = z.enum(["grid", "list", "reel"]);
const shareKind = z.enum(["review", "presentation"]);
const exportFormat = z.enum([
  "resolve_edl",
  "avid_txt",
  "avid_xml",
  "xmeml",
  "fcpxml",
  "csv",
  "json",
  "text",
  "pdf",
]);

const commentText = z.string().min(1).max(10000);

const commentBody = z.object({
  body_text: commentText,
  annotation: z.unknown().optional(),
});

export const bodies = {
  setup: z.object({
    workspace_name: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    email: z.string().email(),
    password: z.string(),
  }),
  login: z.object({ email: z.string().email(), password: z.string() }),
  workspacePatch: z.object({
    name: z.string().min(1).max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  }),
  usersMePatch: z.object({
    name: z.string().min(1).max(200).optional(),
    password: z.object({ current: z.string(), new: z.string() }).optional(),
  }),
  userPatch: z.object({
    role: workspaceRole.optional(),
    disabled: z.boolean().optional(),
  }),
  inviteCreate: z.object({
    email: z.string().email(),
    role: workspaceRole.default("member"),
    project_grants: z
      .array(z.object({ project_id: z.string(), role: projectRole }))
      .default([]),
  }),
  inviteLookup: z.object({ token: z.string().min(1) }),
  inviteAccept: z.object({
    token: z.string().min(1),
    name: z.string().min(1).max(200),
    password: z.string(),
  }),
  tokenCreate: z.object({ name: z.string().min(1).max(200) }),
  projectCreate: z.object({
    name: z.string().min(1).max(200),
    palette: z.enum(PALETTES).optional(),
    restricted: z.boolean().default(false),
  }),
  projectPatch: z.object({
    name: z.string().min(1).max(200).optional(),
    palette: z.enum(PALETTES).optional(),
    restricted: z.boolean().optional(),
    status: z.enum(["active", "archived"]).optional(),
  }),
  memberPut: z.object({ role: projectRole }),
  folderCreate: z.object({
    name: z.string().min(1).max(200),
    parent_id: z.string().nullable().optional(),
  }),
  folderPatch: z.object({
    name: z.string().min(1).max(200).optional(),
    parent_id: z.string().nullable().optional(),
  }),
  commentCreate: z.object({
    frame_in: z.number().int().nonnegative().optional(),
    frame_out: z.number().int().nonnegative().optional(),
    body_text: commentText,
    annotation: z.unknown().optional(),
    pin_xy: z.unknown().optional(),
    page_no: z.number().int().positive().optional(),
    internal: z.boolean().default(false),
  }),
  commentPatch: z.object({
    frame_in: z.number().int().nonnegative().optional(),
    frame_out: z.number().int().nonnegative().optional(),
    body_text: commentText.optional(),
    annotation: z.unknown().optional(),
    pin_xy: z.unknown().optional(),
  }),
  replyCreate: commentBody,
  reactionCreate: z.object({ code: z.string().regex(/^[a-z0-9_]{1,32}$/) }),
  carryForward: z.object({ from_version_id: z.string() }),
  approvalPatch: z.object({ status: approvalStatus }),
  notificationsRead: z.object({ ids: z.array(z.string()).min(1) }),
  notificationPreferencesPatch: z.object({
    mode: z.enum(["instant", "hourly", "daily"]),
    muted_projects: z.array(z.string()).default([]),
  }),
  shareCreate: z.object({
    project_id: z.string(),
    kind: shareKind.default("review"),
    title: z.string().min(1).max(200),
    layout: shareLayout.default("grid"),
    passphrase: z.string().min(1).optional(),
    expires_at: z.number().int().positive().nullable().optional(),
    allow_download: allowDownload.default("none"),
    allow_comments: z.boolean().default(true),
    show_all_versions: z.boolean().default(false),
    watermark_spec: z.record(z.unknown()).nullable().optional(),
    brand: z.record(z.unknown()).nullable().optional(),
    asset_ids: z.array(z.string()).min(1),
  }),
  sharePatch: z.object({
    title: z.string().min(1).max(200).optional(),
    layout: shareLayout.optional(),
    passphrase: z.string().min(1).nullable().optional(),
    expires_at: z.number().int().positive().nullable().optional(),
    allow_download: allowDownload.optional(),
    allow_comments: z.boolean().optional(),
    show_all_versions: z.boolean().optional(),
    watermark_spec: z.record(z.unknown()).nullable().optional(),
    revoked: z.boolean().optional(),
  }),
  webhookCreate: z.object({
    url: z.string().url(),
    secret: z.string().min(16).optional(),
    events: z.array(z.string()).min(1),
  }),
  exportCreate: z.object({
    format: exportFormat,
    filters: z.record(z.unknown()).default({}),
    timecode_base: z.enum(["source", "record_run"]).default("source"),
  }),
  shareAccess: z.object({
    passphrase: z.string().optional(),
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
  }),
  shareCommentCreate: z.object({
    frame_in: z.number().int().nonnegative().optional(),
    frame_out: z.number().int().nonnegative().optional(),
    body_text: commentText,
    annotation: z.unknown().optional(),
  }),
  shareCommentPatch: commentBody,
  shareReplyCreate: commentBody,
  shareApprovalPatch: z.object({
    asset_id: z.string(),
    status: approvalStatus,
  }),
  uploadCreate: z.object({
    project_id: z.string(),
    filename: z.string().min(1).max(500),
    relative_path: z.string().max(2000).default(""),
    size: z.number().int().positive(),
    checksum_crc32c: z
      .string()
      .regex(/^[A-Za-z0-9+/=_-]+$/)
      .optional(),
  }),
  uploadComplete: z.object({
    parts: z
      .array(
        z.object({ part_no: z.number().int().positive(), etag: z.string() }),
      )
      .min(1),
    checksum_crc32c: z.string().optional(),
  }),
  assetCreate: z.object({
    name: z.string().max(500).optional(),
    folder_id: z.string().nullable().optional(),
    upload_id: z.string(),
  }),
  assetPatch: z.object({
    name: z.string().min(1).max(500).optional(),
    folder_id: z.string().nullable().optional(),
    status: approvalStatus.optional(),
    description: z.string().max(10000).optional(),
    tags: z.array(z.string().min(1).max(100)).max(100).optional(),
  }),
  stackPatch: z.object({ version_no: z.number().int().positive() }),
};

/* Response shapes. */

const timestamp = z.number().int();
const jsonRecord = z.record(z.unknown());

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), next_cursor: z.string().nullable() });
const list = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item) });

const user = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: workspaceRole,
  disabled_at: timestamp.nullable(),
  created_at: timestamp,
});

const workspace = z.object({
  id: z.string(),
  name: z.string(),
  settings: jsonRecord,
  oidc_enabled: z.boolean(),
});

const inviteItem = z.object({
  id: z.string(),
  email: z.string(),
  role: workspaceRole,
  project_grants: z.array(
    z.object({ project_id: z.string(), role: projectRole }),
  ),
  invited_by: z.string(),
  created_at: timestamp,
  expires_at: timestamp,
});

const tokenItem = z.object({
  id: z.string(),
  name: z.string(),
  token_prefix: z.string(),
  created_at: timestamp,
  last_used_at: timestamp.nullable(),
});

const project = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "archived"]),
  palette: z.string(),
  restricted: z.boolean(),
  created_by: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
  my_role: projectRole.optional(),
});

const folder = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  name: z.string(),
  created_at: timestamp,
});

const comment = z.object({
  id: z.string(),
  version_id: z.string(),
  parent_id: z.string().nullable(),
  author_user_id: z.string().nullable(),
  author_name: z.string().nullable(),
  author_email: z.string().nullable(),
  frame_in: z.number().int().nullable(),
  frame_out: z.number().int().nullable(),
  body_text: z.string(),
  annotation: jsonRecord.nullable(),
  pin_xy: jsonRecord.nullable(),
  page_no: z.number().int().nullable(),
  internal: z.boolean(),
  completed_at: timestamp.nullable(),
  completed_by: z.string().nullable(),
  carried_from_comment_id: z.string().nullable(),
  deleted_at: timestamp.nullable(),
  created_at: timestamp,
  edited_at: timestamp.nullable(),
});

const signedUrl = z.object({ url: z.string(), expires_at: timestamp });

const notification = z.object({
  id: z.string(),
  kind: z.string(),
  payload: jsonRecord,
  read_at: timestamp.nullable(),
  created_at: timestamp,
});

const notificationPreferences = z.object({
  mode: z.enum(["instant", "hourly", "daily"]),
  muted_projects: z.array(z.string()),
});

const sessionItem = z.object({
  id: z.string(),
  created_at: timestamp,
  expires_at: timestamp,
  last_seen_at: timestamp,
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
});

const searchAssetHit = z.object({
  type: z.literal("asset"),
  id: z.string(),
  name: z.string(),
  project_id: z.string(),
});

const searchCommentHit = z.object({
  type: z.literal("comment"),
  id: z.string(),
  body_text: z.string(),
  asset_id: z.string(),
  version_id: z.string(),
  project_id: z.string(),
});

const searchHit = z.discriminatedUnion("type", [
  searchAssetHit,
  searchCommentHit,
]);

const share = z.object({
  id: z.string(),
  project_id: z.string(),
  slug: z.string(),
  kind: shareKind,
  title: z.string(),
  layout: shareLayout,
  expires_at: timestamp.nullable(),
  allow_download: allowDownload,
  allow_comments: z.boolean(),
  show_all_versions: z.boolean(),
  watermark_spec: jsonRecord.nullable(),
  brand: jsonRecord.nullable(),
  created_by: z.string(),
  revoked_at: timestamp.nullable(),
  created_at: timestamp,
});

const webhookItem = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  created_at: timestamp,
});

const exportJob = z.object({
  id: z.string(),
  project_id: z.string(),
  format: exportFormat,
  filters: jsonRecord,
  timecode_base: z.enum(["source", "record_run"]),
  status: z.string(),
  error: z.string().nullable(),
  created_at: timestamp,
  finished_at: timestamp.nullable(),
  requested_by: z.string(),
});

const upload = z.object({
  id: z.string(),
  project_id: z.string(),
  client_filename: z.string(),
  relative_path: z.string(),
  size: z.number().int(),
  checksum_crc32c: z.string().nullable(),
  status: z.enum([
    "pending",
    "uploading",
    "completed",
    "quarantined",
    "aborted",
  ]),
  created_at: timestamp,
  completed_at: timestamp.nullable(),
});

const asset = z.object({
  id: z.string(),
  project_id: z.string(),
  folder_id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["video", "audio", "image", "pdf", "file"]),
  current_version_id: z.string().nullable(),
  status: approvalStatus,
  description: z.string(),
  tags: z.array(z.string()),
  deleted_at: timestamp.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

const version = z.object({
  id: z.string(),
  asset_id: z.string(),
  version_no: z.number().int(),
  original_filename: z.string(),
  size: z.number().int(),
  checksum_crc32c: z.string(),
  uploaded_by: z.string(),
  media_info: jsonRecord,
  source_timecode_start: z.string().nullable(),
  source_start_frame: z.number().int().nullable(),
  frame_rate_num: z.number().int().nullable(),
  frame_rate_den: z.number().int().nullable(),
  drop_frame: z.boolean(),
  duration_frames: z.number().int().nullable(),
  color: jsonRecord,
  transcode_status: z.enum([
    "pending",
    "processing",
    "ready",
    "failed",
    "skipped",
  ]),
  created_at: timestamp,
});

const renditionItem = z.object({
  id: z.string(),
  version_id: z.string(),
  kind: z.string(),
  blob_key: z.string(),
  meta: jsonRecord,
  size: z.number().int(),
  created_at: timestamp,
  url: z.string().nullable(),
  vtt_url: z.string().nullable(),
});

const job = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["queued", "processing", "complete", "failed", "dead"]),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  run_after: timestamp,
  created_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  error: z.string().nullable(),
  payload: jsonRecord,
});

const auditEntry = z.object({
  id: z.string(),
  actor_user_id: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  meta: jsonRecord,
  at: timestamp,
});

const processing = z.object({ status: z.literal("processing") });

/* Public share projections. GET /s/:slug intentionally serializes raw rows
   (the web share page normalizes both shapes), so the shell is documented
   loosely. */
const publicShareShell = z.object({
  share: jsonRecord,
  viewer: jsonRecord.nullable(),
  assets: z.array(jsonRecord),
});

const publicShareAsset = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  status: approvalStatus,
  current_version_id: z.string().nullable(),
  sort_order: z.number().int(),
});

const shareSource = z.object({
  kind: z.string(),
  url: z.string(),
  size: z.number().int(),
  height: z.number().int().nullable(),
});

const shareSidecars = z.object({
  sprite: z
    .object({ url: z.string(), vtt_url: z.string().nullable() })
    .nullable(),
  peaks: z.object({ url: z.string() }).nullable(),
});

const publicShareVersion = z.object({
  id: z.string(),
  version_no: z.number().int(),
  media_info: jsonRecord,
  transcode_status: z.string(),
  renditions: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      meta: jsonRecord,
      size: z.number().int(),
    }),
  ),
  /* Playable ladder, watermark-aware: watermarked shares expose only the
     burned rendition for the current spec hash; unwatermarked shares expose
     the proxy ladder (540/1080/2160) that exists. */
  sources: z.array(shareSource),
  sidecars: shareSidecars,
  /* "processing" while a watermarked share waits for its burned rendition;
     null when the share has no watermark spec. */
  watermark: z.enum(["ready", "processing"]).nullable(),
});

const publicShareAssetDetail = z.object({
  asset: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    status: approvalStatus,
  }),
  versions: z.array(publicShareVersion),
});

export const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const wire = {
  user,
  workspace,
  project,
  asset,
  version,
  comment,
  share,
  notification,
  searchHit,
  upload,
  signedUrl,
  processing,
  publicShareAssetDetail,
};

/* OpenAPI route registry. Keys are "METHOD /hono/path" exactly as the routes
   are registered on the /api/v1 sub-app. */

export interface ResponseDoc {
  schema?: z.ZodTypeAny;
  /** Non-JSON payloads (binary media, SSE streams). */
  contentType?: string;
  description: string;
}

export interface RouteDoc {
  summary?: string;
  /** JSON request body schema; the same object the route passes jsonBody. */
  request?: z.ZodTypeAny;
  /** Non-JSON request bodies (raw part bytes, multipart uploads). */
  requestContentType?: string;
  /** Documented query parameters. */
  query?: Record<string, { description: string; required?: boolean }>;
  responses: Record<string, ResponseDoc>;
}

const ok = (schema: z.ZodTypeAny, description = "Success"): ResponseDoc => ({
  schema,
  description,
});
const created = (schema: z.ZodTypeAny): ResponseDoc => ({
  schema,
  description: "Created",
});
const noContent: ResponseDoc = { description: "No content" };
const redirect: ResponseDoc = { description: "Redirect" };
const binary = (contentType: string): ResponseDoc => ({
  contentType,
  description: "Binary payload",
});

const paging = {
  limit: { description: "Page size, 1 to 200 (default 50)." },
  cursor: { description: "Opaque keyset cursor from next_cursor." },
};

export const routeDocs: Record<string, RouteDoc> = {
  "GET /healthz": {
    responses: {
      "200": ok(z.object({ status: z.string(), version: z.string() })),
    },
  },
  "GET /bootstrap": {
    summary:
      "Public pre-auth bootstrap: OIDC availability, setup state, and the workspace name (null before setup).",
    responses: {
      "200": ok(
        z.object({
          oidc_enabled: z.boolean(),
          setup_required: z.boolean(),
          workspace_name: z.string().nullable(),
        }),
      ),
    },
  },
  "POST /setup": {
    request: bodies.setup,
    responses: { "201": created(z.object({ user })) },
  },
  "POST /auth/login": {
    request: bodies.login,
    responses: { "200": ok(z.object({ user })) },
  },
  "POST /auth/logout": { responses: { "204": noContent } },
  "GET /auth/session": {
    responses: {
      "200": ok(z.object({ user, auth: z.enum(["session", "token"]) })),
    },
  },
  "GET /auth/oidc/start": { responses: { "302": redirect } },
  "GET /auth/oidc/callback": { responses: { "302": redirect } },
  "GET /workspace": { responses: { "200": ok(workspace) } },
  "PATCH /workspace": {
    request: bodies.workspacePatch,
    responses: { "200": ok(workspace) },
  },
  "GET /users": { query: paging, responses: { "200": ok(page(user)) } },
  "GET /users/me": { responses: { "200": ok(user) } },
  "PATCH /users/me": {
    request: bodies.usersMePatch,
    responses: { "200": ok(user) },
  },
  "PATCH /users/:id": {
    request: bodies.userPatch,
    responses: { "200": ok(user) },
  },
  "DELETE /users/:id": { responses: { "204": noContent } },
  "POST /invites": {
    request: bodies.inviteCreate,
    responses: {
      "201": created(z.object({ invite: inviteItem, accept_url: z.string() })),
    },
  },
  "GET /invites": { query: paging, responses: { "200": ok(page(inviteItem)) } },
  "DELETE /invites/:id": { responses: { "204": noContent } },
  "POST /invites/lookup": {
    request: bodies.inviteLookup,
    responses: {
      "200": ok(z.object({ email: z.string(), workspace_name: z.string() })),
    },
  },
  "POST /invites/accept": {
    request: bodies.inviteAccept,
    responses: { "201": created(z.object({ user })) },
  },
  "GET /tokens": { responses: { "200": ok(list(tokenItem)) } },
  "POST /tokens": {
    request: bodies.tokenCreate,
    responses: { "201": created(tokenItem.extend({ token: z.string() })) },
  },
  "DELETE /tokens/:id": { responses: { "204": noContent } },
  "GET /projects": {
    query: {
      ...paging,
      status: { description: "active (default) or archived." },
    },
    responses: { "200": ok(page(project)) },
  },
  "POST /projects": {
    request: bodies.projectCreate,
    responses: { "201": created(project) },
  },
  "GET /projects/:id": { responses: { "200": ok(project) } },
  "PATCH /projects/:id": {
    request: bodies.projectPatch,
    responses: { "200": ok(project) },
  },
  "DELETE /projects/:id": { responses: { "204": noContent } },
  "GET /projects/:id/events": {
    responses: {
      "200": {
        contentType: "text/event-stream",
        description: "Project event stream (SSE, Last-Event-ID replay).",
      },
    },
  },
  "GET /projects/:id/members": {
    responses: { "200": ok(list(z.object({ user, role: projectRole }))) },
  },
  "PUT /projects/:id/members/:userId": {
    request: bodies.memberPut,
    responses: { "200": ok(z.object({ user, role: projectRole })) },
  },
  "DELETE /projects/:id/members/:userId": { responses: { "204": noContent } },
  "GET /projects/:id/folders": {
    query: { parent_id: { description: "List children of this folder." } },
    responses: { "200": ok(list(folder)) },
  },
  "POST /projects/:id/folders": {
    request: bodies.folderCreate,
    responses: { "201": created(folder) },
  },
  "PATCH /folders/:id": {
    request: bodies.folderPatch,
    responses: { "200": ok(folder) },
  },
  "DELETE /folders/:id": { responses: { "204": noContent } },
  "GET /versions/:id/comments": {
    query: paging,
    responses: { "200": ok(page(comment)) },
  },
  "POST /versions/:id/comments": {
    request: bodies.commentCreate,
    responses: { "201": created(comment) },
  },
  "PATCH /comments/:id": {
    request: bodies.commentPatch,
    responses: { "200": ok(comment) },
  },
  "DELETE /comments/:id": { responses: { "204": noContent } },
  "POST /comments/:id/replies": {
    request: bodies.replyCreate,
    responses: { "201": created(comment) },
  },
  "POST /comments/:id/complete": { responses: { "200": ok(comment) } },
  "POST /comments/:id/reactions": {
    request: bodies.reactionCreate,
    responses: { "204": noContent },
  },
  "DELETE /comments/:id/reactions/:code": { responses: { "204": noContent } },
  "POST /comments/:id/attachments": {
    requestContentType: "multipart/form-data",
    responses: {
      "201": created(
        z.object({
          id: z.string(),
          comment_id: z.string(),
          filename: z.string(),
          size: z.number().int(),
        }),
      ),
    },
  },
  "GET /comments/:id/attachments/:attachmentId": {
    responses: { "200": ok(signedUrl) },
  },
  "DELETE /comments/:id/attachments/:attachmentId": {
    responses: { "204": noContent },
  },
  "POST /versions/:id/carry-forward": {
    request: bodies.carryForward,
    responses: { "200": ok(z.object({ items: z.array(z.string()) })) },
  },
  "PATCH /assets/:id/approval": {
    request: bodies.approvalPatch,
    responses: { "200": ok(asset) },
  },
  "GET /notifications": {
    query: paging,
    responses: { "200": ok(page(notification)) },
  },
  "POST /notifications/read": {
    request: bodies.notificationsRead,
    responses: { "204": noContent },
  },
  "GET /notifications/preferences": {
    responses: { "200": ok(notificationPreferences) },
  },
  "PATCH /notifications/preferences": {
    request: bodies.notificationPreferencesPatch,
    responses: { "200": ok(notificationPreferences) },
  },
  "GET /sessions": { responses: { "200": ok(list(sessionItem)) } },
  "DELETE /sessions/:id": { responses: { "204": noContent } },
  "GET /search": {
    query: {
      q: {
        description: "Query text, at least two characters.",
        required: true,
      },
      scope: { description: "assets, comments, or all (default all)." },
      ...paging,
    },
    responses: { "200": ok(page(searchHit)) },
  },
  "POST /shares": {
    request: bodies.shareCreate,
    responses: { "201": created(z.object({ share, url: z.string() })) },
  },
  "GET /shares": {
    query: { project_id: { description: "Filter to one project." } },
    responses: { "200": ok(list(share)) },
  },
  "GET /shares/:id": {
    responses: {
      "200": ok(share.extend({ assets: z.array(jsonRecord) })),
    },
  },
  "PATCH /shares/:id": {
    request: bodies.sharePatch,
    responses: { "200": ok(share) },
  },
  "DELETE /shares/:id": { responses: { "204": noContent } },
  "POST /webhooks": {
    request: bodies.webhookCreate,
    responses: {
      "201": created(
        z.object({
          id: z.string(),
          url: z.string(),
          events: z.array(z.string()),
          secret: z.string(),
        }),
      ),
    },
  },
  "GET /webhooks": { responses: { "200": ok(list(webhookItem)) } },
  "DELETE /webhooks/:id": { responses: { "204": noContent } },
  "POST /shares/:id/export": {
    request: bodies.exportCreate,
    responses: {
      "202": {
        schema: z.object({ id: z.string(), status: z.literal("queued") }),
        description: "Export job accepted",
      },
    },
  },
  "GET /exports/:id": { responses: { "200": ok(exportJob) } },
  "GET /exports/:id/download": { responses: { "200": ok(signedUrl) } },
  "POST /s/:slug/access": {
    request: bodies.shareAccess,
    responses: {
      "200": ok(z.object({ share, viewer_key: z.string() })),
    },
  },
  "GET /s/:slug": { responses: { "200": ok(publicShareShell) } },
  "GET /s/:slug/assets": {
    responses: { "200": ok(list(publicShareAsset)) },
  },
  "GET /s/:slug/assets/:assetId": {
    responses: { "200": ok(publicShareAssetDetail) },
  },
  "GET /s/:slug/assets/:assetId/comments": {
    responses: { "200": ok(list(comment)) },
  },
  "POST /s/:slug/assets/:assetId/comments": {
    request: bodies.shareCommentCreate,
    responses: { "201": created(comment) },
  },
  "PATCH /s/:slug/comments/:commentId": {
    request: bodies.shareCommentPatch,
    responses: { "200": ok(comment) },
  },
  "DELETE /s/:slug/comments/:commentId": { responses: { "204": noContent } },
  "POST /s/:slug/comments/:commentId/replies": {
    request: bodies.shareReplyCreate,
    responses: { "201": created(comment) },
  },
  "PATCH /s/:slug/approval": {
    request: bodies.shareApprovalPatch,
    responses: {
      "200": ok(z.object({ asset_id: z.string(), status: approvalStatus })),
    },
  },
  "GET /s/:slug/assets/:assetId/media": {
    responses: {
      "200": ok(signedUrl, "Signed URL for the playable rendition"),
      "202": {
        schema: processing,
        description:
          "The share is watermarked and the burned rendition for the current spec is not registered yet; poll until 200. The clean proxy is never served.",
      },
    },
  },
  "GET /s/:slug/assets/:assetId/media/file": {
    query: { token: { description: "Signed media token.", required: true } },
    responses: { "200": binary("application/octet-stream") },
  },
  "GET /s/:slug/assets/:assetId/download": {
    summary:
      "Share download, gated by allow_download: none is 403, proxy signs the 1080p proxy (or the burned watermarked rendition; the clean file is never handed to a watermarked share), original signs the original blob with an attachment disposition.",
    responses: {
      "200": ok(
        signedUrl,
        "Signed download URL (content-disposition: attachment)",
      ),
      "202": {
        schema: processing,
        description:
          "The watermarked rendition is still being prepared; poll until 200.",
      },
    },
  },
  "POST /uploads": {
    request: bodies.uploadCreate,
    responses: {
      "200": ok(
        z.object({ upload, upload_url: z.string() }),
        "Idempotency-Key replay: the original still-open session",
      ),
      "201": created(z.object({ upload, upload_url: z.string() })),
    },
  },
  "POST /uploads/:id/multipart": {
    responses: {
      "200": ok(
        z.object({
          upload,
          upload_id: z.string().optional(),
          part_size: z.number().int().optional(),
        }),
      ),
    },
  },
  "GET /uploads/:id/parts": {
    responses: {
      "200": ok(
        list(
          z.object({
            part_no: z.number().int(),
            etag: z.string().nullable(),
            size: z.number().int().nullable(),
            completed_at: timestamp.nullable(),
          }),
        ),
      ),
    },
  },
  "GET /uploads/:id/parts/:partNo/url": {
    responses: { "200": ok(z.object({ url: z.string() })) },
  },
  "PUT /uploads/:id/parts/:partNo": {
    requestContentType: "application/octet-stream",
    responses: { "204": noContent },
  },
  "POST /uploads/:id/complete": {
    request: bodies.uploadComplete,
    responses: {
      "202": { schema: z.object({ upload }), description: "Accepted" },
    },
  },
  "DELETE /uploads/:id": { responses: { "204": noContent } },
  "POST /uploads/:id/abort": { responses: { "204": noContent } },
  "GET /projects/:id/assets": {
    query: { ...paging, folder_id: { description: "Filter by folder." } },
    responses: { "200": ok(page(asset)) },
  },
  "POST /projects/:id/assets": {
    request: bodies.assetCreate,
    responses: {
      "201": created(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          status: approvalStatus,
          current_version_id: z.string(),
          version_id: z.string(),
          job_id: z.string(),
          created_at: timestamp,
          updated_at: timestamp,
        }),
      ),
    },
  },
  "GET /assets/:id": { responses: { "200": ok(asset) } },
  "PATCH /assets/:id": {
    request: bodies.assetPatch,
    responses: { "200": ok(asset) },
  },
  "DELETE /assets/:id": { responses: { "204": noContent } },
  "GET /assets/:id/versions": { responses: { "200": ok(list(version)) } },
  "POST /assets/:id/trash": { responses: { "204": noContent } },
  "POST /assets/:id/restore": { responses: { "200": ok(asset) } },
  "GET /versions/:id": { responses: { "200": ok(version) } },
  "GET /versions/:id/renditions": {
    responses: { "200": ok(list(renditionItem)) },
  },
  "PATCH /versions/:id/stack": {
    request: bodies.stackPatch,
    responses: {
      "200": ok(
        z.object({
          items: z.array(version),
          current_version_id: z.string(),
        }),
      ),
    },
  },
  "GET /jobs/:id": { responses: { "200": ok(job) } },
  "GET /admin/jobs": {
    query: { ...paging, status: { description: "Filter by job status." } },
    responses: { "200": ok(page(job)) },
  },
  "GET /media/*": {
    query: { token: { description: "Signed media token.", required: true } },
    responses: { "200": binary("application/octet-stream") },
  },
  "GET /audit": {
    query: { ...paging, action: { description: "Filter by action." } },
    responses: { "200": ok(page(auditEntry)) },
  },
};
