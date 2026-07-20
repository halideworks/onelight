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
const workspaceRole = z.enum(["admin", "member", "guest"]);
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

/* The share room's design, chosen by whoever made the share: one library
   palette or two custom hexes for the wash, and which player the viewer
   gets. Design doc section 11 promises palette-or-hexes plus a logo; the
   logo needs an upload path and is not built yet. */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const shareBrand = z.object({
  palette: z.enum(PALETTES).optional(),
  colors: z.tuple([hexColor, hexColor]).optional(),
  player: z.enum(["full", "simple"]).optional(),
});

const commentBody = z.object({
  body_text: commentText,
  annotation: z.unknown().optional(),
});

/* Mentioned user ids; authed comment routes only. The server drops ids that
   cannot see the project silently instead of rejecting the comment. */
const mentionList = z.array(z.string()).max(20).optional();

export const bodies = {
  setup: z.object({
    workspace_name: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    email: z.string().email(),
    password: z.string(),
  }),
  login: z.object({ email: z.string().email(), password: z.string() }),
  loginTotp: z.object({
    mfa_token: z.string().min(1),
    code: z.string().min(1).max(64),
  }),
  totpCode: z.object({ code: z.string().min(1).max(64) }),
  resetRequest: z.object({ email: z.string().email() }),
  resetComplete: z.object({
    token: z.string().min(1),
    password: z.string(),
  }),
  workspacePatch: z.object({
    name: z.string().min(1).max(200).optional(),
    settings: z.record(z.unknown()).optional(),
  }),
  /* Full-replace semantics except `pass`: omitted keeps the stored secret,
     explicit null clears it. The response never carries the password. */
  mailSettingsPut: z
    .object({
      smtp_url: z.string().trim().max(500).nullable().optional(),
      host: z.string().trim().max(255).nullable().optional(),
      port: z.number().int().min(1).max(65535).nullable().optional(),
      user: z.string().max(255).nullable().optional(),
      pass: z.string().max(500).nullable().optional(),
      secure: z.boolean().nullable().optional(),
      mail_from: z.string().trim().max(320).nullable().optional(),
      /* What the instance sends when email works. Password resets have no
         switch: a reset that cannot arrive is a lockout. */
      policy: z
        .object({
          invites: z.boolean().optional(),
          digests: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  usersMePatch: z.object({
    name: z.string().min(1).max(200).optional(),
    password: z.object({ current: z.string(), new: z.string() }).optional(),
    /* Changing the address that signs you in takes the current password. */
    email: z
      .object({ value: z.string().email(), password: z.string() })
      .optional(),
  }),
  /* Deactivating an account takes the password, plus a TOTP or backup code
     when two-factor is on. */
  usersMeDelete: z.object({
    password: z.string(),
    code: z.string().min(1).max(64).optional(),
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
    /* An asset id in this project, or null to fall back to the generated
       palette cover. */
    cover_asset_id: z.string().nullable().optional(),
    /* A picture already uploaded to this project (GET /projects/:id/covers).
       Mutually exclusive with cover_asset_id. */
    cover_upload_id: z.string().optional(),
  }),
  memberPut: z.object({ role: projectRole }),
  folderCreate: z.object({
    name: z.string().min(1).max(200),
    parent_id: z.string().nullable().optional(),
    /* Ignored when parent_id is given: a child inherits its parent's tree. */
    kind: z.enum(["assets", "shares"]).optional(),
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
    mentions: mentionList,
  }),
  commentPatch: z.object({
    frame_in: z.number().int().nonnegative().optional(),
    frame_out: z.number().int().nonnegative().optional(),
    body_text: commentText.optional(),
    annotation: z.unknown().optional(),
    pin_xy: z.unknown().optional(),
  }),
  replyCreate: commentBody.extend({ mentions: mentionList }),
  reactionCreate: z.object({ code: z.string().regex(/^[a-z0-9_]{1,32}$/) }),
  carryForward: z.object({ from_version_id: z.string() }),
  approvalPatch: z.object({ status: approvalStatus }),
  notificationsRead: z.object({ ids: z.array(z.string()).min(1).max(500) }),
  notificationPreferencesPatch: z.object({
    mode: z.enum(["instant", "hourly", "daily"]),
    muted_projects: z.array(z.string()).max(1000).default([]),
  }),
  shareCreate: z.object({
    project_id: z.string(),
    folder_id: z.string().nullable().optional(),
    kind: shareKind.default("review"),
    title: z.string().min(1).max(200),
    layout: shareLayout.default("grid"),
    passphrase: z.string().min(1).optional(),
    expires_at: z.number().int().positive().nullable().optional(),
    allow_download: allowDownload.default("none"),
    allow_comments: z.boolean().default(true),
    /* Absent, the kind decides: review true, presentation false. */
    allow_approvals: z.boolean().optional(),
    show_all_versions: z.boolean().default(false),
    watermark_spec: z.record(z.unknown()).nullable().optional(),
    brand: shareBrand.nullable().optional(),
    asset_ids: z.array(z.string()).min(1).max(1000),
  }),
  sharePatch: z.object({
    title: z.string().min(1).max(200).optional(),
    layout: shareLayout.optional(),
    /* A 'shares' folder in the same project, or null for the Shares root. */
    folder_id: z.string().nullable().optional(),
    passphrase: z.string().min(1).nullable().optional(),
    expires_at: z.number().int().positive().nullable().optional(),
    allow_download: allowDownload.optional(),
    allow_comments: z.boolean().optional(),
    allow_approvals: z.boolean().optional(),
    show_all_versions: z.boolean().optional(),
    watermark_spec: z.record(z.unknown()).nullable().optional(),
    brand: shareBrand.nullable().optional(),
    revoked: z.boolean().optional(),
  }),
  projectCoverPut: z.object({
    upload_id: z.string(),
  }),
  shareAssetsAdd: z.object({
    asset_ids: z.array(z.string()).min(1).max(1000),
  }),
  /* Every asset in the share, exactly once, in the order wanted. */
  shareAssetsReorder: z.object({
    asset_ids: z.array(z.string()).min(1).max(1000),
  }),
  webhookCreate: z.object({
    url: z.string().url(),
    secret: z.string().min(16).optional(),
    events: z.array(z.string()).min(1).max(50),
  }),
  exportCreate: z.object({
    format: exportFormat,
    filters: z.record(z.unknown()).default({}),
    timecode_base: z.enum(["source", "record_run"]).default("source"),
  }),
  /* A marker file pasted or uploaded back in: the two formats NLEs round-trip
     losslessly. Timecodes resolve against the version's own rate and start. */
  commentsImport: z.object({
    format: z.enum(["resolve_edl", "csv"]),
    content: z.string().min(1).max(2_000_000),
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
  transferCreate: z.object({
    project_id: z.string(),
    kind: z.enum(["package", "request"]),
    title: z.string().min(1).max(200),
    message: z.string().max(2000).default(""),
    passphrase: z.string().min(1).optional(),
    expires_at: z.number().int().positive().nullable().optional(),
    byte_cap: z.number().int().positive().nullable().optional(),
    folder_id: z.string().nullable().optional(),
    asset_ids: z.array(z.string()).max(1000).default([]),
  }),
  transferPatch: z.object({
    title: z.string().min(1).max(200).optional(),
    message: z.string().max(2000).optional(),
    passphrase: z.string().min(1).nullable().optional(),
    expires_at: z.number().int().positive().nullable().optional(),
    byte_cap: z.number().int().positive().nullable().optional(),
    folder_id: z.string().nullable().optional(),
    revoked: z.boolean().optional(),
  }),
  transferItemsAdd: z.object({
    asset_ids: z.array(z.string()).min(1).max(1000),
  }),
  transferAccess: z.object({
    name: z.string().min(1).max(200),
    passphrase: z.string().optional(),
  }),
  transferUploadCreate: z.object({
    filename: z.string().min(1).max(500),
    relative_path: z.string().max(2000).default(""),
    size: z.number().int().positive(),
    checksum_crc32c: z
      .string()
      .regex(/^[A-Za-z0-9+/=_-]+$/)
      .optional(),
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
      .min(1)
      .max(10000),
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
  versionCreate: z.object({
    upload_id: z.string(),
    name: z.string().min(1).max(500).optional(),
    carry_forward: z.boolean().default(false),
  }),
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
  /* Same-origin path to the user's picture, cache-busted by update time;
     null means the generated avatar. */
  avatar_url: z.string().nullable(),
  disabled_at: timestamp.nullable(),
  created_at: timestamp,
  totp_enabled: z.boolean(),
});

const workspace = z.object({
  id: z.string(),
  name: z.string(),
  settings: jsonRecord,
  oidc_enabled: z.boolean(),
});

/* Storage totals, from the sizes the database tracks. Originals include
   trashed assets until the purge removes them; asset_count is live assets
   only. */
const usageCounters = z.object({
  originals_bytes: z.number().int(),
  renditions_bytes: z.number().int(),
  asset_count: z.number().int(),
  version_count: z.number().int(),
});
const workspaceUsage = z.object({
  totals: usageCounters,
  /* The blob volume's capacity where the host can know it (the Node server's
     filesystem); null on object storage. */
  disk: z
    .object({ total_bytes: z.number().int(), free_bytes: z.number().int() })
    .nullable(),
  projects: z.array(usageCounters.extend({ id: z.string(), name: z.string() })),
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
  /* Short random identity for URLs; id stays canonical for API calls. */
  public_id: z.string(),
  name: z.string(),
  status: z.enum(["active", "archived"]),
  palette: z.string(),
  cover_asset_id: z.string().nullable(),
  cover_kind: z.enum(["upload", "asset", "generated"]),
  /* Null when the project has no cover, or when its cover asset has been
     deleted or has not finished producing a poster: the client falls back to
     the generated palette cover in all three cases. */
  cover_url: z.string().nullable(),
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
  kind: z.enum(["assets", "shares"]),
  name: z.string(),
  created_at: timestamp,
});

const commentAttachment = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number().int(),
  content_type: z.string(),
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
  /* Derived from body_text (#[a-z0-9_]+, lowercased), never stored. */
  tags: z.array(z.string()),
  /* Present on list reads; single-comment writes return the row alone. */
  attachments: z.array(commentAttachment).optional(),
  /* Share comment lists only: whether the requesting viewer wrote it. */
  mine: z.boolean().optional(),
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
  public_id: z.string(),
  name: z.string(),
  project_id: z.string(),
  /* Lets a result draw its poster without a request per hit. */
  current_version_id: z.string().nullable(),
  updated_at: timestamp,
});

const searchCommentHit = z.object({
  type: z.literal("comment"),
  id: z.string(),
  body_text: z.string(),
  asset_id: z.string(),
  version_id: z.string(),
  project_id: z.string(),
  /* Anchor frame for ?f= deep links; null for unanchored comments. */
  frame_in: z.number().int().nullable(),
  updated_at: timestamp,
});

const searchProjectHit = z.object({
  type: z.literal("project"),
  id: z.string(),
  public_id: z.string(),
  name: z.string(),
  palette: z.string(),
  cover_url: z.string().nullable(),
  updated_at: timestamp,
});

const searchPersonHit = z.object({
  type: z.literal("person"),
  id: z.string(),
  name: z.string(),
  email: z.string(),
  updated_at: timestamp,
});

const searchShareHit = z.object({
  type: z.literal("share"),
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  project_id: z.string(),
  updated_at: timestamp,
});

const searchHit = z.discriminatedUnion("type", [
  searchAssetHit,
  searchCommentHit,
  searchProjectHit,
  searchPersonHit,
  searchShareHit,
]);

const share = z.object({
  id: z.string(),
  /* Short random identity for the settings page URL. */
  public_id: z.string(),
  project_id: z.string(),
  folder_id: z.string().nullable(),
  slug: z.string(),
  kind: shareKind,
  title: z.string(),
  layout: shareLayout,
  expires_at: timestamp.nullable(),
  allow_download: allowDownload,
  allow_comments: z.boolean(),
  allow_approvals: z.boolean(),
  show_all_versions: z.boolean(),
  watermark_spec: jsonRecord.nullable(),
  brand: jsonRecord.nullable(),
  /* Public path to the share's logo; null without one. */
  logo_url: z.string().nullable(),
  created_by: z.string(),
  revoked_at: timestamp.nullable(),
  created_at: timestamp,
});

/* Share viewer roster; the signed viewer_key never leaves the server. */
const shareViewerItem = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  first_seen_at: timestamp,
  last_seen_at: timestamp,
  user_agent: z.string().nullable(),
});

const transferKind = z.enum(["package", "request"]);

const transfer = z.object({
  id: z.string(),
  project_id: z.string(),
  kind: transferKind,
  slug: z.string(),
  title: z.string(),
  message: z.string(),
  has_passphrase: z.boolean(),
  expires_at: timestamp.nullable(),
  byte_cap: z.number().int().nullable(),
  folder_id: z.string().nullable(),
  created_by: z.string(),
  revoked_at: timestamp.nullable(),
  created_at: timestamp,
  item_count: z.number().int(),
  received_count: z.number().int(),
  received_bytes: z.number().int(),
});

const transferItem = z.object({
  asset_id: z.string(),
  name: z.string(),
  kind: z.enum(["video", "audio", "image", "pdf", "file"]),
  size: z.number().int().nullable(),
  sort_order: z.number().int(),
});

const transferReceiptItem = z.object({
  id: z.string(),
  sender_name: z.string(),
  filename: z.string(),
  size: z.number().int(),
  status: z.enum([
    "pending",
    "uploading",
    "completed",
    "quarantined",
    "aborted",
  ]),
  asset_id: z.string().nullable(),
  created_at: timestamp,
});

/* The public projection never carries the project, the folder, the creator,
   or the passphrase hash: a transfer link knows only what it moves. */
const publicTransfer = z.object({
  slug: z.string(),
  kind: transferKind,
  title: z.string(),
  message: z.string(),
  requires_passphrase: z.boolean(),
  expires_at: timestamp.nullable(),
  byte_cap: z.number().int().nullable(),
  received_bytes: z.number().int(),
});

const publicTransferFile = z.object({
  asset_id: z.string(),
  name: z.string(),
  kind: z.enum(["video", "audio", "image", "pdf", "file"]),
  size: z.number().int().nullable(),
  checksum_crc32c: z.string().nullable(),
});

const publicTransferShell = z.object({
  transfer: publicTransfer,
  authorized: z.boolean(),
  files: z.array(publicTransferFile),
});

/* A request link's upload session, without the project id the member wire
   carries: the sender knows the link, not the room behind it. */
const transferUpload = z.object({
  id: z.string(),
  filename: z.string(),
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
  /* Short random identity for URLs; id stays canonical for API calls. */
  public_id: z.string(),
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

/* Public share projections for unauthenticated share clients: client-safe
   fields only (never passphrase_hash, watermark_spec_hash, created_by, or
   camelCase). Watermarking is exposed as a boolean presence flag. */
const publicShareAsset = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  status: approvalStatus,
  current_version_id: z.string().nullable(),
  /* Signed poster URL, so a share draws its thumbnails without a request per
     asset. Null while the poster is still transcoding, when the asset has no
     current version, and where no blob store is configured: the client falls
     back to a text tile in all three cases. */
  poster_url: z.string().nullable(),
  /* Sprite sheet and its VTT for hover scrub on the landing, same sidecar
     policy as the poster; null when the sprite or its VTT is missing. */
  sprite_url: z.string().nullable(),
  sprite_vtt_url: z.string().nullable(),
  /* Running time from the current version's probe; null until probed or for
     stills. */
  duration_seconds: z.number().nullable(),
  sort_order: z.number().int(),
});

const publicShare = z.object({
  id: z.string(),
  slug: z.string(),
  kind: shareKind,
  title: z.string(),
  layout: shareLayout,
  allow_download: allowDownload,
  allow_comments: z.boolean(),
  allow_approvals: z.boolean(),
  show_all_versions: z.boolean(),
  expires_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  watermark: z.boolean(),
  brand: jsonRecord.nullable(),
  logo_url: z.string().nullable(),
});

const publicViewer = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

const publicShareShell = z.object({
  share: publicShare,
  viewer: publicViewer.nullable(),
  assets: z.array(publicShareAsset),
});

/* Share comments never expose the registered author's user id or email. */
const publicComment = comment.omit({
  author_user_id: true,
  author_email: true,
});

const shareSource = z.object({
  kind: z.string(),
  url: z.string(),
  size: z.number().int(),
  height: z.number().int().nullable(),
});

const captionTrack = z.object({
  language: z.string(),
  label: z.string(),
  url: z.string().nullable(),
});

const shareSidecars = z.object({
  sprite: z
    .object({ url: z.string(), vtt_url: z.string().nullable() })
    .nullable(),
  peaks: z.object({ url: z.string() }).nullable(),
  captions: z.array(captionTrack),
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

const mailSettingsView = z.object({
  stored: z
    .object({
      smtp_url: z.string().nullable(),
      host: z.string().nullable(),
      port: z.number().nullable(),
      user: z.string().nullable(),
      has_pass: z.boolean(),
      secure: z.boolean().nullable(),
      mail_from: z.string().nullable(),
    })
    .nullable(),
  active: z.object({
    state: z.enum(["ready", "disabled", "error"]),
    detail: z.string().nullable(),
    source: z.enum(["settings", "env", "none"]),
  }),
  policy: z.object({
    invites: z.boolean(),
    digests: z.boolean(),
  }),
});
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
    summary:
      "Password login. With two-factor on, the password earns a five-minute mfa_token instead of a session; finish at /auth/login/totp.",
    request: bodies.login,
    responses: {
      "200": ok(
        z.union([
          z.object({ user }),
          z.object({
            mfa_required: z.literal(true),
            mfa_token: z.string(),
          }),
        ]),
      ),
    },
  },
  "POST /auth/login/totp": {
    request: bodies.loginTotp,
    responses: { "200": ok(z.object({ user })) },
  },
  "POST /users/me/totp": {
    summary:
      "Begin TOTP enrolment (session auth only). Inactive until a code is verified.",
    responses: {
      "201": created(z.object({ secret: z.string(), otpauth_url: z.string() })),
    },
  },
  "POST /users/me/totp/verify": {
    request: bodies.totpCode,
    responses: {
      "200": ok(z.object({ backup_codes: z.array(z.string()) })),
    },
  },
  "DELETE /users/me/totp": {
    request: bodies.totpCode,
    responses: { "204": noContent },
  },
  "POST /auth/logout": { responses: { "204": noContent } },
  "POST /auth/reset-request": {
    summary:
      "Request a password reset link. Always 204 so account existence never leaks; rate limited per email and per IP.",
    request: bodies.resetRequest,
    responses: { "204": noContent },
  },
  "POST /auth/reset": {
    summary:
      "Complete a password reset with a token from the reset email. Revokes every session of the user.",
    request: bodies.resetComplete,
    responses: { "204": noContent },
  },
  "GET /auth/session": {
    responses: {
      "200": ok(z.object({ user, auth: z.enum(["session", "token"]) })),
    },
  },
  "GET /auth/oidc/start": { responses: { "302": redirect } },
  "GET /auth/oidc/callback": { responses: { "302": redirect } },
  "GET /workspace": { responses: { "200": ok(workspace) } },
  "GET /workspace/usage": { responses: { "200": ok(workspaceUsage) } },
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
  "DELETE /users/me": {
    summary:
      "Deactivate your own account (password-confirmed, plus a code when two-factor is on). Sessions and API tokens die; an admin can re-enable it. The last active admin cannot deactivate.",
    request: bodies.usersMeDelete,
    responses: { "204": noContent },
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
  "POST /projects/:id/cover": {
    summary:
      "Set a completed image upload as the project cover. The picture is not registered as an asset.",
    request: bodies.projectCoverPut,
    responses: { "200": ok(project) },
  },
  "GET /projects/:id/covers": {
    summary: "Pictures uploaded as covers for this project.",
    responses: {
      "200": ok(
        list(
          z.object({
            id: z.string(),
            filename: z.string(),
            url: z.string(),
            current: z.boolean(),
            created_at: timestamp,
          }),
        ),
      ),
    },
  },
  "DELETE /projects/:id/covers/:uploadId": {
    summary: "Forget an uploaded cover.",
    responses: { "204": noContent },
  },
  "DELETE /projects/:id": { responses: { "204": noContent } },
  "GET /projects/:id/events": {
    responses: {
      "200": {
        contentType: "text/event-stream",
        description:
          "Project event stream (SSE). A connection without Last-Event-ID is a new subscriber: it receives a single stream.cursor event naming the newest event id and no history. Send that id back as Last-Event-ID to receive everything after it.",
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
  "DELETE /comments/:id/complete": { responses: { "200": ok(comment) } },
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
      scope: {
        description:
          "all (default), assets, comments, projects, people, or shares.",
      },
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
      "200": ok(
        share.extend({
          assets: z.array(
            z.object({
              share_id: z.string(),
              asset_id: z.string(),
              sort_order: z.number().int(),
            }),
          ),
        }),
      ),
    },
  },
  "PATCH /shares/:id": {
    request: bodies.sharePatch,
    responses: { "200": ok(share) },
  },
  "PATCH /shares/:id/assets": {
    request: bodies.shareAssetsReorder,
    responses: {
      "200": ok(
        list(z.object({ asset_id: z.string(), sort_order: z.number().int() })),
      ),
    },
  },
  "DELETE /shares/:id/assets/:assetId": { responses: { "204": noContent } },
  "PUT /shares/:id/logo": {
    requestContentType: "image/png",
    responses: { "200": ok(z.object({ logo_url: z.string() })) },
  },
  "DELETE /shares/:id/logo": { responses: { "204": noContent } },
  "GET /s/:slug/logo": {
    query: { v: { description: "Cache-busting key.", required: false } },
    responses: { "200": binary("image/png") },
  },
  "GET /s/:slug/unfurl.png": { responses: { "200": binary("image/png") } },
  "POST /shares/:id/assets": {
    summary:
      "Add assets to an existing share. Assets already in it are skipped.",
    request: bodies.shareAssetsAdd,
    responses: {
      "200": ok(z.object({ share, added: z.number().int() })),
    },
  },
  "DELETE /shares/:id": { responses: { "204": noContent } },
  "GET /shares/:id/viewers": {
    summary:
      "Share viewer roster (share owner or project manager). The viewer_key is never on the wire.",
    responses: { "200": ok(list(shareViewerItem)) },
  },
  "GET /versions/:id/download": {
    summary:
      "Signed download for a version: kind=original (editor) or kind=proxy (viewer).",
    query: {
      kind: { description: "original (default) or proxy." },
    },
    responses: { "200": ok(signedUrl) },
  },
  "GET /projects/:id/zip": {
    summary:
      "A folder, a selection, or the whole project as one streamed zip of originals (editor).",
    query: {
      folder_id: { description: "Limit to one folder and its subfolders." },
      asset_ids: { description: "Comma-separated asset ids to include." },
    },
    responses: { "200": binary("application/zip") },
  },
  "GET /s/:slug/zip": {
    summary:
      "The whole share as one streamed zip, under the share's download policy. Watermarked shares refuse.",
    responses: { "200": binary("application/zip") },
  },
  "POST /transfers": {
    summary:
      "Create a transfer link: a package sends existing assets, a request receives files into a folder.",
    request: bodies.transferCreate,
    responses: { "201": created(z.object({ transfer, url: z.string() })) },
  },
  "GET /transfers": {
    query: { project_id: { description: "Filter to one project." } },
    responses: { "200": ok(list(transfer)) },
  },
  "GET /transfers/:id": {
    responses: {
      "200": ok(
        transfer.extend({
          items: z.array(transferItem),
          receipts: z.array(transferReceiptItem),
        }),
      ),
    },
  },
  "PATCH /transfers/:id": {
    request: bodies.transferPatch,
    responses: { "200": ok(transfer) },
  },
  "DELETE /transfers/:id": { responses: { "204": noContent } },
  "POST /transfers/:id/items": {
    request: bodies.transferItemsAdd,
    responses: { "200": ok(z.object({ transfer, added: z.number().int() })) },
  },
  "DELETE /transfers/:id/items/:assetId": { responses: { "204": noContent } },
  "GET /t/:slug": { responses: { "200": ok(publicTransferShell) } },
  "POST /t/:slug/access": {
    request: bodies.transferAccess,
    responses: { "200": ok(publicTransferShell) },
  },
  "POST /t/:slug/files/:assetId/download": {
    summary: "Signed download for one package file, original bytes.",
    responses: { "200": ok(signedUrl) },
  },
  "GET /t/:slug/file": {
    query: { token: { description: "Signed file token.", required: true } },
    responses: { "200": binary("application/octet-stream") },
  },
  "GET /t/:slug/zip": {
    summary:
      "The whole package as one streamed zip (store method, exact length known upfront).",
    responses: { "200": binary("application/zip") },
  },
  "POST /t/:slug/uploads": {
    request: bodies.transferUploadCreate,
    responses: {
      "201": created(z.object({ upload: transferUpload })),
    },
  },
  "POST /t/:slug/uploads/:id/multipart": {
    responses: {
      "200": ok(
        z.object({
          upload: transferUpload,
          upload_id: z.string().optional(),
          part_size: z.number().int().optional(),
        }),
      ),
    },
  },
  "GET /t/:slug/uploads/:id/parts": {
    responses: {
      "200": ok(
        list(
          z.object({
            part_no: z.number().int(),
            etag: z.string(),
            size: z.number().int(),
            completed_at: timestamp.nullable(),
          }),
        ),
      ),
    },
  },
  "PUT /t/:slug/uploads/:id/parts/:partNo": {
    requestContentType: "application/octet-stream",
    responses: { "204": noContent },
  },
  "POST /t/:slug/uploads/:id/complete": {
    summary:
      "Verify and land a received upload: the file becomes an asset in the request's folder.",
    request: bodies.uploadComplete,
    responses: {
      "202": {
        schema: z.object({
          upload: transferUpload,
          asset_id: z.string().nullable(),
        }),
        description: "Upload verified and landed",
      },
    },
  },
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
  "POST /projects/:id/export": {
    request: bodies.exportCreate,
    responses: {
      "202": {
        schema: z.object({ id: z.string(), status: z.literal("queued") }),
        description: "Export job accepted",
      },
    },
  },
  "POST /versions/:id/comments/import": {
    request: bodies.commentsImport,
    responses: {
      "201": created(
        z.object({
          imported: z.number().int(),
          skipped: z.number().int(),
        }),
      ),
    },
  },
  "GET /exports/:id": { responses: { "200": ok(exportJob) } },
  "GET /exports/:id/download": { responses: { "200": ok(signedUrl) } },
  "POST /s/:slug/access": {
    request: bodies.shareAccess,
    responses: {
      "200": ok(z.object({ share: publicShare, viewer_key: z.string() })),
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
    responses: { "200": ok(list(publicComment)) },
  },
  "POST /s/:slug/assets/:assetId/comments": {
    request: bodies.shareCommentCreate,
    responses: { "201": created(publicComment) },
  },
  "PATCH /s/:slug/comments/:commentId": {
    request: bodies.shareCommentPatch,
    responses: { "200": ok(publicComment) },
  },
  "DELETE /s/:slug/comments/:commentId": { responses: { "204": noContent } },
  "POST /s/:slug/comments/:commentId/attachments": {
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
  "GET /s/:slug/comments/:commentId/attachments/:attachmentId": {
    responses: { "200": ok(signedUrl) },
  },
  "POST /s/:slug/comments/:commentId/replies": {
    request: bodies.shareReplyCreate,
    responses: { "201": created(publicComment) },
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
    query: {
      ...paging,
      folder_id: { description: "Filter by folder." },
      share_id: {
        description: "Filter to the assets in one of this project's shares.",
      },
    },
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
  "POST /assets/:id/versions": {
    summary:
      "Attach a completed upload as the next version of an asset. The new version becomes current; carry_forward copies unresolved comments from the previous current version.",
    request: bodies.versionCreate,
    responses: {
      "201": created(z.object({ asset, version, job_id: z.string() })),
    },
  },
  "POST /assets/:id/trash": { responses: { "204": noContent } },
  "POST /assets/:id/restore": { responses: { "200": ok(asset) } },
  "GET /versions/:id": { responses: { "200": ok(version) } },
  "GET /versions/:id/renditions": {
    responses: {
      "200": ok(
        z.object({
          items: z.array(renditionItem),
          captions: z.array(captionTrack),
        }),
      ),
    },
  },
  "PUT /versions/:id/captions": {
    summary:
      "Upload a WebVTT caption track (editor+), one per language, replace on re-put. Raw text/vtt body; ?language=<BCP 47>&label=<name>. This is the deployment captioning hook: a curl away.",
    requestContentType: "text/vtt",
    query: {
      language: {
        description: "BCP 47 tag like en or pt-br. Defaults to en.",
        required: false,
      },
      label: {
        description: "Menu label. Defaults to the language tag.",
        required: false,
      },
    },
    responses: { "201": created(captionTrack) },
  },
  "DELETE /versions/:id/captions/:language": {
    responses: { "204": noContent },
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
  "GET /admin/system": {
    summary:
      "Operational status (admin): version, uptime, database size and backup snapshots where the host can know them, blob capacity, and queue depths by status.",
    responses: {
      "200": ok(
        z.object({
          version: z.string(),
          started_at: z.number().nullable(),
          db_size_bytes: z.number().nullable(),
          backups: z
            .object({
              count: z.number(),
              newest_at: z.number().nullable(),
            })
            .nullable(),
          disk: z
            .object({
              total_bytes: z.number(),
              free_bytes: z.number(),
            })
            .nullable(),
          mail: z.object({
            state: z.enum(["ready", "disabled", "error"]),
            detail: z.string().nullable(),
            source: z.enum(["settings", "env", "none"]),
          }),
          media_jobs: z.record(z.number()),
          export_jobs: z.record(z.number()),
          webhook_deliveries: z.record(z.number()),
        }),
      ),
    },
  },
  "POST /admin/system/test-email": {
    summary:
      "Send a test email to the calling administrator's own address, proving the configured mail transport end to end. 409 when email is not configured or the transport refuses the message.",
    responses: {
      "200": ok(z.object({ sent: z.literal(true), to: z.string() })),
    },
  },
  "GET /admin/settings/mail": {
    summary:
      "The stored SMTP settings (password masked) and the active mail posture with its source: admin settings, the environment, or none.",
    responses: { "200": ok(mailSettingsView) },
  },
  "PUT /admin/settings/mail": {
    summary:
      "Replace the stored SMTP settings (admin, session auth only). An omitted pass keeps the stored secret. Stored settings take precedence over the environment.",
    request: bodies.mailSettingsPut,
    responses: { "200": ok(mailSettingsView) },
  },
  "DELETE /admin/settings/mail": {
    summary:
      "Remove the stored SMTP settings and fall back to the environment (admin, session auth only).",
    responses: { "204": noContent },
  },
  "PUT /users/me/avatar": {
    requestContentType: "image/png",
    responses: { "200": ok(z.object({ avatar_url: z.string() })) },
  },
  "DELETE /users/me/avatar": { responses: { "204": noContent } },
  "GET /users/:id/avatar": {
    query: {
      v: { description: "Cache-busting update stamp.", required: false },
    },
    responses: { "200": binary("image/png") },
  },
  "GET /media/*": {
    query: { token: { description: "Signed media token.", required: true } },
    responses: { "200": binary("application/octet-stream") },
  },
  "GET /trash": {
    responses: {
      "200": ok(
        list(
          z.object({
            id: z.string(),
            name: z.string(),
            kind: z.string(),
            project_id: z.string(),
            project_name: z.string(),
            deleted_at: timestamp.nullable(),
          }),
        ),
      ),
    },
  },
  "GET /audit": {
    query: { ...paging, action: { description: "Filter by action." } },
    responses: { "200": ok(page(auditEntry)) },
  },
};
