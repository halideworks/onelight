/* Server configuration, validated once at startup.
 *
 * The variables themselves are declared in config-manifest.ts, which is also
 * what generates .env.example, the compose environment lists, and the docs.
 * This file owns two things the manifest cannot express: the typed shape the
 * rest of the code reads, and the handful of values that are derived rather
 * than read (secure cookies follow PUBLIC_URL's scheme, the allowed-origin set
 * always contains PUBLIC_URL's own origin).
 */

import {
  effectiveConfig,
  parseScope,
  type ConfigIssue,
  type EffectiveConfig,
  type RawEnv,
} from "./config-report.js";
import { CONFIG_VARS } from "./config-manifest.js";

export interface AppConfig {
  PUBLIC_URL: string;
  PORT: number;
  HOST: string;
  DATABASE_PATH: string;
  BLOB_ROOT?: string;
  SECRET_KEY: string;
  ONELIGHT_ADMIN_EMAIL?: string;
  ONELIGHT_ADMIN_PASSWORD?: string;
  ONELIGHT_WORKSPACE_NAME: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_AUTO_PROVISION: boolean;
  OIDC_ALLOWED_DOMAINS?: string;
  COOKIE_SECURE?: boolean;
  TRUST_PROXY: boolean;
  ONELIGHT_ALLOWED_ORIGINS?: string;
  WORKER_URL?: string;
  WORKER_SECRET?: string;

  cookieSecure: boolean;
  oidcAllowedDomains: string[];
  /* Every origin the CSRF check accepts: PUBLIC_URL's own, plus any extras. */
  allowedOrigins: string[];

  /* Media queue and worker pacing. Read here rather than from process.env at
     the call site so a malformed value fails at startup instead of quietly
     becoming the default six hours later. */
  workerJobTimeoutMs: number;
  mediaConcurrency?: number;
  watermarkSweepLimit: number;

  /* Retention and cleanup. */
  uploadReapAfterMs: number;
  trashPurgeAfterMs: number;
  gcIntervalMs: number;
  gcDelete: boolean;

  /* Backups, off unless a directory is set. */
  backupDir?: string;
  backupIntervalMs: number;
  backupKeep: number;
}

const splitList = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

const fail = (issues: ConfigIssue[]): never => {
  const lines = issues.map((issue) => `  - ${issue.message}`).join("\n");
  throw new Error(`Invalid configuration:\n${lines}`);
};

const numberOf = (
  values: Record<string, unknown>,
  name: string,
  fallback: number,
): number => {
  const value = values[name];
  return typeof value === "number" ? value : fallback;
};

const boolOf = (values: Record<string, unknown>, name: string): boolean =>
  values[name] === true;

const stringOf = (
  values: Record<string, unknown>,
  name: string,
): string | undefined => {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
};

const defaultOf = (name: string): string => {
  const entry = CONFIG_VARS.find((item) => item.name === name);
  if (entry?.default === undefined)
    throw new Error(`${name} has no manifest default.`);
  return entry.default;
};

export const loadConfig = (input: NodeJS.ProcessEnv | RawEnv): AppConfig => {
  const env: RawEnv = input;
  const { values, issues } = parseScope(env, "server");

  /* Origins get their own message because a typo here is otherwise only ever
     discovered by somebody who cannot log in. */
  const extraOrigins: string[] = [];
  for (const origin of splitList(env.ONELIGHT_ALLOWED_ORIGINS)) {
    try {
      extraOrigins.push(new URL(origin).origin);
    } catch {
      issues.push({
        name: "ONELIGHT_ALLOWED_ORIGINS",
        message: `"${origin}" is not a valid origin. Use a full scheme and host, e.g. https://review.example.com or http://192.168.1.52:3000.`,
      });
    }
  }

  if (issues.length > 0) fail(issues);

  const publicUrl = values.PUBLIC_URL as string;
  const cookieSecureRaw = values.COOKIE_SECURE;
  const allowedDomains = values.OIDC_ALLOWED_DOMAINS;

  /* Read into locals so the optional-property spreads below narrow under
     exactOptionalPropertyTypes: an inline call returns string | undefined and
     the compiler cannot see the guard. */
  const blobRoot = stringOf(values, "BLOB_ROOT");
  const adminEmail = stringOf(values, "ONELIGHT_ADMIN_EMAIL");
  const adminPassword = stringOf(values, "ONELIGHT_ADMIN_PASSWORD");
  const oidcIssuer = stringOf(values, "OIDC_ISSUER");
  const oidcClientId = stringOf(values, "OIDC_CLIENT_ID");
  const oidcClientSecret = stringOf(values, "OIDC_CLIENT_SECRET");
  const workerUrl = stringOf(values, "WORKER_URL");
  const workerSecret = stringOf(values, "WORKER_SECRET");
  const backupDir = stringOf(values, "BACKUP_DIR");
  const allowedOriginsRaw = env.ONELIGHT_ALLOWED_ORIGINS;
  const mediaConcurrency = values.MEDIA_CONCURRENCY;

  return {
    PUBLIC_URL: publicUrl,
    PORT: numberOf(values, "PORT", Number(defaultOf("PORT"))),
    HOST: stringOf(values, "HOST") ?? defaultOf("HOST"),
    DATABASE_PATH:
      stringOf(values, "DATABASE_PATH") ?? defaultOf("DATABASE_PATH"),
    ...(blobRoot !== undefined ? { BLOB_ROOT: blobRoot } : {}),
    SECRET_KEY: values.SECRET_KEY as string,
    ...(adminEmail !== undefined ? { ONELIGHT_ADMIN_EMAIL: adminEmail } : {}),
    ...(adminPassword !== undefined
      ? { ONELIGHT_ADMIN_PASSWORD: adminPassword }
      : {}),
    ONELIGHT_WORKSPACE_NAME:
      stringOf(values, "ONELIGHT_WORKSPACE_NAME") ??
      defaultOf("ONELIGHT_WORKSPACE_NAME"),
    ...(oidcIssuer !== undefined ? { OIDC_ISSUER: oidcIssuer } : {}),
    ...(oidcClientId !== undefined ? { OIDC_CLIENT_ID: oidcClientId } : {}),
    ...(oidcClientSecret !== undefined
      ? { OIDC_CLIENT_SECRET: oidcClientSecret }
      : {}),
    OIDC_AUTO_PROVISION: boolOf(values, "OIDC_AUTO_PROVISION"),
    ...(Array.isArray(allowedDomains) && allowedDomains.length > 0
      ? { OIDC_ALLOWED_DOMAINS: allowedDomains.join(",") }
      : {}),
    ...(typeof cookieSecureRaw === "boolean"
      ? { COOKIE_SECURE: cookieSecureRaw }
      : {}),
    TRUST_PROXY: boolOf(values, "TRUST_PROXY"),
    ...(allowedOriginsRaw !== undefined
      ? { ONELIGHT_ALLOWED_ORIGINS: allowedOriginsRaw }
      : {}),
    ...(workerUrl !== undefined ? { WORKER_URL: workerUrl } : {}),
    ...(workerSecret !== undefined ? { WORKER_SECRET: workerSecret } : {}),

    cookieSecure:
      typeof cookieSecureRaw === "boolean"
        ? cookieSecureRaw
        : new URL(publicUrl).protocol === "https:",
    oidcAllowedDomains: Array.isArray(allowedDomains)
      ? allowedDomains.map((domain) => domain.toLowerCase())
      : [],
    /* Normalised through URL so "https://x.com/" and "https://x.com" are the
       same entry, and so comparison is against an origin rather than a string
       the operator happened to type. */
    allowedOrigins: [new URL(publicUrl).origin, ...extraOrigins],

    workerJobTimeoutMs: numberOf(
      values,
      "WORKER_JOB_TIMEOUT_MS",
      Number(defaultOf("WORKER_JOB_TIMEOUT_MS")),
    ),
    ...(typeof mediaConcurrency === "number" ? { mediaConcurrency } : {}),
    watermarkSweepLimit: numberOf(
      values,
      "WATERMARK_SWEEP_LIMIT",
      Number(defaultOf("WATERMARK_SWEEP_LIMIT")),
    ),

    uploadReapAfterMs: numberOf(
      values,
      "UPLOAD_REAP_AFTER_MS",
      Number(defaultOf("UPLOAD_REAP_AFTER_MS")),
    ),
    trashPurgeAfterMs: numberOf(
      values,
      "TRASH_PURGE_AFTER_MS",
      Number(defaultOf("TRASH_PURGE_AFTER_MS")),
    ),
    gcIntervalMs: numberOf(
      values,
      "GC_INTERVAL_MS",
      Number(defaultOf("GC_INTERVAL_MS")),
    ),
    gcDelete: boolOf(values, "ONELIGHT_GC_DELETE"),

    ...(backupDir !== undefined ? { backupDir } : {}),
    backupIntervalMs: numberOf(
      values,
      "BACKUP_INTERVAL_MS",
      Number(defaultOf("BACKUP_INTERVAL_MS")),
    ),
    backupKeep: numberOf(
      values,
      "BACKUP_KEEP",
      Number(defaultOf("BACKUP_KEEP")),
    ),
  };
};

/** The redacted effective-configuration report for the admin system page. */
export const serverEffectiveConfig = (input: RawEnv): EffectiveConfig =>
  effectiveConfig(input, "server");
