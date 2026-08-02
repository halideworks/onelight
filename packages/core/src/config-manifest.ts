/* The one place a configuration setting is declared.
 *
 * Every environment variable the server or the worker reads is described here
 * once, and everything else is derived: the zod schema config.ts validates
 * against, .env.example, the environment lists in deploy/docker-compose.yml,
 * docs/CONFIGURATION.md, and the redacted effective-configuration report the
 * admin system page shows.
 *
 * This exists because the alternative kept failing the same way. Compose does
 * not pass a container's environment through: it passes exactly the keys named
 * under `environment:`. A setting documented in .env.example but missing from
 * that list can be set by an operator, read back from their own .env, and do
 * nothing at all, with no error anywhere. It happened to SMTP (silently
 * ignored until 2026-07-17), then to ONELIGHT_GC_DELETE, and an audit found
 * OIDC, the headless admin, backups, and every retention knob in the same
 * state. Documentation and the compose file cannot drift from each other if
 * neither one is written by hand.
 *
 * The second failure this closes is the silent fallback. Reading a number with
 * `Number(env.X)` and falling back on NaN means TRASH_PURGE_AFTER_MS=6weeks
 * purges at 30 days and says nothing. Every value here is parsed strictly: a
 * malformed setting fails at startup, where somebody is watching.
 */

/** Which container has to receive the variable. */
export type ConfigScope = "server" | "worker";

export type ConfigKind =
  | "string"
  | "number"
  | "duration_ms"
  | "boolean"
  | "url"
  | "email"
  | "path"
  | "list"
  | "enum";

/** Groups a variable under a subsystem in the docs and the admin report. */
export type ConfigSubsystem =
  | "core"
  | "network"
  | "admin"
  | "oidc"
  | "worker"
  | "hwaccel"
  | "mail"
  | "backups"
  | "maintenance"
  | "media"
  | "tools";

export interface ConfigVar {
  name: string;
  scope: ConfigScope[];
  subsystem: ConfigSubsystem;
  kind: ConfigKind;
  /** One line. Heads the block in .env.example and the row in the docs. */
  summary: string;
  /** The longer prose that earns a comment block in .env.example. */
  doc?: string;
  required?: boolean;
  /**
   * The default the parser applies when the variable is unset, written as it
   * would appear in the environment. Machine readable on purpose: it is both
   * the documented default and the one the code actually uses, so the two
   * cannot disagree.
   */
  default?: string;
  /**
   * Prose for a default that is derived rather than fixed (COOKIE_SECURE
   * follows PUBLIC_URL's scheme, MEDIA_CONCURRENCY follows the core count).
   * Documentation only.
   */
  defaultNote?: string;
  /** Shown in .env.example when the variable ships commented out. */
  example?: string;
  /** Credential-equivalent: never rendered in the effective-config report. */
  secret?: boolean;
  /** Ships commented out in .env.example (optional, no useful default value). */
  commented?: boolean;
  /** Permitted values for kind: "enum". */
  values?: readonly string[];
  min?: number;
  max?: number;
  /**
   * How compose should pass it. "interpolate" writes ${NAME:-default},
   * "required" writes ${NAME:?message}, "literal" pins a container path that
   * must not follow the host's .env, and "omit" keeps a variable out of the
   * compose file on purpose (with a reason).
   */
  compose: "interpolate" | "required" | "literal" | "omit";
  /** The value for compose: "literal". */
  composeValue?: string;
  /** Per-container override of composeValue, where one name means two things. */
  composeValueByScope?: Partial<Record<ConfigScope, string>>;
  /** What compose interpolates when the operator's .env leaves it unset. */
  composeDefault?: string;
  /** Why a variable is deliberately absent from compose. */
  composeNote?: string;
}

/**
 * Settings that are only meaningful together. A partially present group fails
 * startup rather than half-enabling a subsystem: OIDC with no client secret is
 * not "OIDC with a default", it is a login page that cannot work.
 */
export interface ConfigGroup {
  name: string;
  subsystem: ConfigSubsystem;
  members: readonly string[];
  /** Members that satisfy the group on their own (SMTP_URL vs SMTP_HOST). */
  alternatives?: readonly (readonly string[])[];
  /** Set when the whole group is inert without this variable. */
  requires?: string;
  /**
   * "error" fails startup: the partial state is otherwise silent, and a
   * half-configured subsystem that says nothing is the defect this manifest
   * exists to kill. "report" only marks the subsystem misconfigured in the
   * effective-config view, for groups that already fail loudly elsewhere.
   * Mail is the one "report" case: a bad SMTP setting surfaces as an error on
   * the admin mail page and in the boot log, and taking the whole server down
   * over a typo in a notification transport is worse than the typo.
   */
  severity: "error" | "report";
  message: string;
}

const DAY_MS = 86_400_000;

export const CONFIG_VARS: readonly ConfigVar[] = [
  {
    name: "PUBLIC_URL",
    scope: ["server"],
    subsystem: "core",
    kind: "url",
    required: true,
    summary:
      "Public origin users reach the app at. Drives absolute URLs and the COOKIE_SECURE default.",
    example: "http://localhost:3000",
    compose: "interpolate",
    composeDefault: "http://localhost:3000",
  },
  {
    name: "SECRET_KEY",
    scope: ["server"],
    subsystem: "core",
    kind: "string",
    required: true,
    secret: true,
    min: 32,
    summary: "Session and signing key. At least 32 random characters.",
    example: "replace-this-with-at-least-32-random-characters",
    compose: "required",
  },
  {
    name: "PORT",
    scope: ["server", "worker"],
    subsystem: "network",
    kind: "number",
    min: 1,
    max: 65535,
    default: "3000",
    summary: "Listen port. The worker defaults to 8080.",
    // Pinned per container: the published port is the host's business, and a
    // .env PORT that moved the listener without moving the port mapping would
    // only break the healthcheck.
    compose: "literal",
    composeValue: "3000",
    composeValueByScope: { server: "3000", worker: "8080" },
  },
  {
    name: "HOST",
    scope: ["server"],
    subsystem: "network",
    kind: "string",
    default: "0.0.0.0",
    summary: "Listen address.",
    compose: "omit",
    composeNote:
      "the container must listen on all interfaces; binding it elsewhere only makes the service unreachable from the port mapping",
  },
  {
    name: "DATABASE_PATH",
    scope: ["server"],
    subsystem: "core",
    kind: "path",
    default: "/data/onelight.db",
    summary: "SQLite database file. Absolute in production.",
    doc: "Relative paths resolve against the working directory and move when it does. In docker this must live on the volume the worker also mounts.",
    compose: "literal",
    composeValue: "/data/onelight.db",
  },
  {
    name: "BLOB_ROOT",
    scope: ["server"],
    subsystem: "core",
    kind: "path",
    defaultNote: 'a "blobs" directory beside DATABASE_PATH',
    summary: "Blob storage root for originals, renditions, and exports.",
    doc: "DATABASE_PATH and BLOB_ROOT must resolve to the same filesystem the worker mounts, or the worker cannot read sources and write renditions.",
    compose: "literal",
    composeValue: "/data/blobs",
  },
  {
    name: "COOKIE_SECURE",
    scope: ["server"],
    subsystem: "network",
    kind: "boolean",
    defaultNote: "true when PUBLIC_URL is https, false otherwise",
    summary: "Force the secure flag on session cookies.",
    compose: "interpolate",
  },
  {
    name: "TRUST_PROXY",
    scope: ["server"],
    subsystem: "network",
    kind: "boolean",
    default: "false",
    summary:
      "Take client IPs from X-Forwarded-For. Set this behind a reverse proxy.",
    doc: "With this off, every request behind a proxy carries the proxy's address, so per-IP rate limits collapse into one bucket for the whole internet.",
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_ALLOWED_ORIGINS",
    scope: ["server"],
    subsystem: "network",
    kind: "list",
    summary:
      "Extra origins the CSRF check accepts, comma separated. PUBLIC_URL's own origin is always allowed.",
    doc: [
      'Cookie-carried mutations (login included) are rejected unless the request\'s Origin matches, so reaching a deployment by any name PUBLIC_URL does not carry -- the LAN address while public DNS is still pending, a tailnet host, a second domain -- fails with "The request origin is not allowed." and looks like a broken login rather than a configuration problem.',
      "This widens the CSRF rule and nothing else: list exact origins you trust, never a wildcard. An unparseable entry fails at startup, not at request time.",
    ].join("\n\n"),
    example: "http://192.168.1.52:3000,https://review.internal.example.com",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_WORKSPACE_NAME",
    scope: ["server"],
    subsystem: "admin",
    kind: "string",
    default: "Onelight",
    summary: "Name given to the workspace created on first run.",
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_ADMIN_EMAIL",
    scope: ["server"],
    subsystem: "admin",
    kind: "email",
    summary: "Headless first-run admin address.",
    doc: "When this and ONELIGHT_ADMIN_PASSWORD are both set and the database has no users, this admin account and workspace are created at startup. On Workers, /setup is the only path.",
    example: "admin@example.com",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_ADMIN_PASSWORD",
    scope: ["server"],
    subsystem: "admin",
    kind: "string",
    secret: true,
    min: 10,
    summary: "Headless first-run admin password. Never printed.",
    example: "change-me-please",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "OIDC_ISSUER",
    scope: ["server"],
    subsystem: "oidc",
    kind: "url",
    summary: "OIDC provider issuer URL.",
    example: "https://accounts.example.com",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "OIDC_CLIENT_ID",
    scope: ["server"],
    subsystem: "oidc",
    kind: "string",
    summary: "OIDC client id.",
    example: "onelight",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "OIDC_CLIENT_SECRET",
    scope: ["server"],
    subsystem: "oidc",
    kind: "string",
    secret: true,
    summary: "OIDC client secret.",
    example: "replace-me",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "OIDC_AUTO_PROVISION",
    scope: ["server"],
    subsystem: "oidc",
    kind: "boolean",
    default: "false",
    summary: "Create users on their first OIDC login.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "OIDC_ALLOWED_DOMAINS",
    scope: ["server"],
    subsystem: "oidc",
    kind: "list",
    summary:
      "Email domains permitted to provision, comma separated. Empty means any.",
    example: "example.com",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "WORKER_URL",
    scope: ["server"],
    subsystem: "worker",
    kind: "url",
    defaultNote: "unset, which disables media processing",
    summary: "Where the media worker listens.",
    doc: "This and WORKER_SECRET must both be set or media processing is disabled and probe/transcode jobs stay queued.",
    example: "http://localhost:8080",
    compose: "interpolate",
    composeDefault: "http://onelight-worker:8080",
  },
  {
    name: "WORKER_SECRET",
    scope: ["server", "worker"],
    subsystem: "worker",
    kind: "string",
    secret: true,
    summary: "Signs the job protocol in both directions.",
    example: "replace-this-with-a-worker-secret",
    compose: "required",
  },
  {
    name: "WORKER_JOB_TIMEOUT_MS",
    scope: ["server"],
    subsystem: "worker",
    kind: "duration_ms",
    default: String(6 * 60 * 60_000),
    summary: "Ceiling for one worker job (probe or transcode).",
    doc: "The pump heartbeats the job lease while it waits, so long encodes do not expire mid-run.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "MEDIA_CONCURRENCY",
    scope: ["server"],
    subsystem: "media",
    kind: "number",
    min: 1,
    defaultNote: "the CPU count minus 2, at least 1",
    summary: "How many media jobs the pump runs at once.",
    doc: "Encodes are the heaviest thing the box does and the site shares its cores, so the default leaves two alone. A dedicated worker box can raise it; 1 restores serial behaviour.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "WATERMARK_SWEEP_LIMIT",
    scope: ["server"],
    subsystem: "media",
    kind: "number",
    min: 1,
    default: "8",
    summary: "Burned-watermark jobs enqueued per reconciliation sweep.",
    doc: "The pump scans every 30 seconds for shares whose watermark spec lacks a rendition. The sweep is bounded so a large backlog drains across passes instead of stalling the queue.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "SMTP_URL",
    scope: ["server"],
    subsystem: "mail",
    kind: "string",
    secret: true,
    summary:
      "Single-string SMTP connection, the alternative to the discrete settings.",
    doc: "Email is disabled unless SMTP_URL or SMTP_HOST is set together with MAIL_FROM. Admin mail settings, where present, take precedence over all of these.",
    example: "smtp://user:pass@mail.example.com:587",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "SMTP_HOST",
    scope: ["server"],
    subsystem: "mail",
    kind: "string",
    summary: "SMTP server hostname.",
    example: "mail.example.com",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "SMTP_PORT",
    scope: ["server"],
    subsystem: "mail",
    kind: "number",
    min: 1,
    max: 65535,
    default: "587",
    summary: "SMTP server port.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "SMTP_USER",
    scope: ["server"],
    subsystem: "mail",
    kind: "string",
    summary: "SMTP username.",
    example: "onelight",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "SMTP_PASS",
    scope: ["server"],
    subsystem: "mail",
    kind: "string",
    secret: true,
    summary: "SMTP password.",
    example: "replace-me",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "SMTP_SECURE",
    scope: ["server"],
    subsystem: "mail",
    kind: "boolean",
    defaultNote: "true on port 465, false otherwise",
    summary: "Connect with implicit TLS.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "MAIL_FROM",
    scope: ["server"],
    subsystem: "mail",
    kind: "string",
    summary: "From address on outgoing mail.",
    example: "Onelight <onelight@example.com>",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "BACKUP_DIR",
    scope: ["server"],
    subsystem: "backups",
    kind: "path",
    summary:
      "Where periodic database snapshots are written. Backups are off when unset.",
    doc: "A filesystem copy of a live SQLite file can catch a write mid-flight; the engine's online backup API cannot. Each snapshot carries a manifest of the blob keys it references, which is also what stops the blob GC deleting a blob a retained snapshot still needs. See docs/BACKUPS.md for restore.",
    example: "/data/backups",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "BACKUP_INTERVAL_MS",
    scope: ["server"],
    subsystem: "backups",
    kind: "duration_ms",
    default: String(6 * 60 * 60_000),
    summary: "How often a snapshot is taken.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "BACKUP_KEEP",
    scope: ["server"],
    subsystem: "backups",
    kind: "number",
    min: 1,
    default: "28",
    summary: "Snapshots retained before the oldest is pruned.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "UPLOAD_REAP_AFTER_MS",
    scope: ["server"],
    subsystem: "maintenance",
    kind: "duration_ms",
    default: String(7 * DAY_MS),
    summary: "Age at which a stale upload session is reaped.",
    doc: "Pending, uploading, quarantined and aborted sessions age from creation; completed sessions age from completion. Multipart state is aborted, part rows and the session are deleted, and partial blobs are removed.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "TRASH_PURGE_AFTER_MS",
    scope: ["server"],
    subsystem: "maintenance",
    kind: "duration_ms",
    default: String(30 * DAY_MS),
    summary:
      "Age at which soft-deleted assets and versions are purged for good.",
    doc: "Blobs deleted, rows removed, one audit row per purge.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_GC_DELETE",
    scope: ["server"],
    subsystem: "maintenance",
    kind: "boolean",
    default: "false",
    summary: "Let the blob GC delete orphans instead of only reporting them.",
    doc: "Without this the server only ever REPORTS orphaned objects: every thumbnail, proxy and watermarked render belonging to a deleted asset, share or project stays on disk forever. Even with it on, only orphans older than 24 hours are deleted.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "GC_INTERVAL_MS",
    scope: ["server"],
    subsystem: "maintenance",
    kind: "duration_ms",
    default: String(DAY_MS),
    summary: "Minimum time between blob GC reconciliation passes.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "WORK_ROOT",
    scope: ["worker"],
    subsystem: "worker",
    kind: "path",
    default: "/data/work",
    summary: "Scratch directory for in-flight jobs.",
    compose: "omit",
    composeNote:
      "the image pins its own scratch directory; P0-5 moves this to a bounded tmpfs",
  },
  {
    name: "ONELIGHT_HWACCEL",
    scope: ["worker"],
    subsystem: "hwaccel",
    kind: "enum",
    values: ["auto", "vaapi", "nvenc", "amf", "software"],
    default: "auto",
    summary: "Hardware encoding backend.",
    doc: [
      "auto probes usable backends and falls back to libx264. vaapi covers Intel Quick Sync, Intel Arc, and AMD on Linux; nvenc covers NVIDIA; amf covers AMD on Windows; software is libx264.",
      "Explicit GPU modes are strict. The worker performs a real one-frame encode before listening and refuses to start if the requested device, driver, or rate-control mode is unusable, so production cannot silently fall to CPU.",
    ].join("\n\n"),
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_VAAPI_DEVICE",
    scope: ["worker"],
    subsystem: "hwaccel",
    kind: "path",
    summary: "VAAPI render node.",
    example: "/dev/dri/renderD128",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_VAAPI_LOW_POWER",
    scope: ["worker"],
    subsystem: "hwaccel",
    kind: "boolean",
    default: "true",
    summary: "Use the VAAPI low-power encode path.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_NVENC_DEVICE",
    scope: ["worker"],
    subsystem: "hwaccel",
    kind: "number",
    min: 0,
    default: "0",
    summary: "NVENC device index.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "ONELIGHT_SOFTWARE_AV1",
    scope: ["worker"],
    subsystem: "hwaccel",
    kind: "boolean",
    default: "true",
    summary: "Encode the AV1 HDR rendition in software where the GPU cannot.",
    doc: "It runs at the lowest priority so it yields to anything the site is doing. Turning it off trades cores for a feature: AV1 is the only HDR codec Chrome decodes in software, and only a software decoder returns frames the reference renderer can read, so without this rendition reference HDR is unavailable in Chrome no matter what else is present.",
    commented: true,
    compose: "interpolate",
  },
  {
    name: "FFMPEG_PATH",
    scope: ["worker"],
    subsystem: "tools",
    kind: "path",
    default: "ffmpeg",
    summary: "ffmpeg binary.",
    commented: true,
    compose: "omit",
    composeNote: "the image ships its own toolchain on PATH",
  },
  {
    name: "FFPROBE_PATH",
    scope: ["worker"],
    subsystem: "tools",
    kind: "path",
    default: "ffprobe",
    summary: "ffprobe binary.",
    commented: true,
    compose: "omit",
    composeNote: "the image ships its own toolchain on PATH",
  },
  {
    name: "PDFTOPPM_PATH",
    scope: ["worker"],
    subsystem: "tools",
    kind: "path",
    default: "pdftoppm",
    summary: "Poppler pdftoppm binary, for PDF page rasterisation.",
    commented: true,
    compose: "omit",
    composeNote: "the image ships its own toolchain on PATH",
  },
  {
    name: "DCRAW_PATH",
    scope: ["worker"],
    subsystem: "tools",
    kind: "path",
    default: "dcraw_emu",
    summary: "LibRaw dcraw_emu binary, for camera raw stills.",
    commented: true,
    compose: "omit",
    composeNote: "the image ships its own toolchain on PATH",
  },
  {
    name: "HEIF_DEC_PATH",
    scope: ["worker"],
    subsystem: "tools",
    kind: "path",
    default: "heif-dec",
    summary: "libheif decoder binary, for HEIC/HEIF stills.",
    commented: true,
    compose: "omit",
    composeNote: "the image ships its own toolchain on PATH",
  },
  {
    name: "HEIF_ENC_PATH",
    scope: ["worker"],
    subsystem: "tools",
    kind: "path",
    default: "heif-enc",
    summary: "libheif encoder binary.",
    commented: true,
    compose: "omit",
    composeNote: "the image ships its own toolchain on PATH",
  },
];

export const CONFIG_GROUPS: readonly ConfigGroup[] = [
  {
    name: "oidc",
    subsystem: "oidc",
    members: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
    severity: "error",
    message:
      "OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must be set together.",
  },
  {
    name: "headless admin",
    subsystem: "admin",
    members: ["ONELIGHT_ADMIN_EMAIL", "ONELIGHT_ADMIN_PASSWORD"],
    severity: "error",
    message:
      "ONELIGHT_ADMIN_EMAIL and ONELIGHT_ADMIN_PASSWORD must be set together, or first-run setup creates no admin.",
  },
  {
    name: "media worker",
    subsystem: "worker",
    members: ["WORKER_URL", "WORKER_SECRET"],
    severity: "error",
    message:
      "WORKER_URL and WORKER_SECRET must be set together, or media processing stays disabled and probe/transcode jobs sit queued.",
  },
  {
    name: "mail",
    subsystem: "mail",
    members: ["SMTP_URL", "SMTP_HOST", "MAIL_FROM"],
    alternatives: [
      ["SMTP_URL", "MAIL_FROM"],
      ["SMTP_HOST", "MAIL_FROM"],
    ],
    severity: "report",
    message:
      "Set MAIL_FROM together with either SMTP_URL or SMTP_HOST, or email stays disabled.",
  },
  {
    name: "backups",
    subsystem: "backups",
    members: ["BACKUP_DIR", "BACKUP_INTERVAL_MS", "BACKUP_KEEP"],
    requires: "BACKUP_DIR",
    severity: "error",
    message:
      "BACKUP_INTERVAL_MS and BACKUP_KEEP do nothing without BACKUP_DIR: backups are off.",
  },
];

const byName = new Map(CONFIG_VARS.map((entry) => [entry.name, entry]));

export const configVar = (name: string): ConfigVar | undefined =>
  byName.get(name);

export const varsForScope = (scope: ConfigScope): readonly ConfigVar[] =>
  CONFIG_VARS.filter((entry) => entry.scope.includes(scope));

/** The order subsystems appear in generated files and the admin report. */
export const SUBSYSTEM_ORDER: readonly ConfigSubsystem[] = [
  "core",
  "network",
  "admin",
  "oidc",
  "worker",
  "media",
  "hwaccel",
  "mail",
  "backups",
  "maintenance",
  "tools",
];

export const SUBSYSTEM_TITLES: Record<ConfigSubsystem, string> = {
  core: "Core",
  network: "Network and proxying",
  admin: "First run",
  oidc: "Single sign-on",
  worker: "Media worker",
  media: "Media queue",
  hwaccel: "Hardware encoding",
  mail: "Outgoing email",
  backups: "Backups",
  maintenance: "Retention and cleanup",
  tools: "External tools",
};

/**
 * Subsystems that are off until configured, and what turns each one on. The
 * admin report answers "is this actually running?" from these, which is the
 * question an operator who set a variable and saw nothing happen is asking.
 */
export const SUBSYSTEM_ACTIVATION: Partial<
  Record<ConfigSubsystem, readonly string[]>
> = {
  oidc: ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"],
  worker: ["WORKER_URL", "WORKER_SECRET"],
  mail: ["MAIL_FROM"],
  backups: ["BACKUP_DIR"],
};
