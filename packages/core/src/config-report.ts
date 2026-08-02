/* Strict parsing of a manifest-declared environment, and the redacted report
   the admin system page renders from it.

   The parser is deliberately unforgiving. Every earlier reader in this
   codebase did `Number(env.X)` and fell back on NaN, which turns
   TRASH_PURGE_AFTER_MS=6weeks into a 30-day purge that reports nothing. A
   value that was typed but cannot be honoured is a failure, not a default. */

import {
  CONFIG_GROUPS,
  SUBSYSTEM_ACTIVATION,
  SUBSYSTEM_ORDER,
  SUBSYSTEM_TITLES,
  isStartupFatal,
  varsForScope,
  type ConfigScope,
  type ConfigSubsystem,
  type ConfigVar,
} from "./config-manifest.js";
import { isSmtpConfigError, parseSmtpConfig } from "./mail-config.js";

export type RawEnv = Record<string, string | undefined>;

export type ConfigValue = string | number | boolean | string[] | undefined;

export interface ConfigIssue {
  name: string;
  message: string;
}

const present = (env: RawEnv, name: string): boolean => {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
};

const BOOLEAN_TRUE = new Set(["true", "1"]);
const BOOLEAN_FALSE = new Set(["false", "0", ""]);

/**
 * Parse one variable's raw string. Returns the typed value, or an issue
 * describing what an operator has to change. `undefined` with no issue means
 * "not set and no default", which is how an optional setting reads.
 */
export const parseConfigValue = (
  entry: ConfigVar,
  raw: string | undefined,
): { value: ConfigValue } | { issue: string } => {
  const trimmed = raw?.trim();
  const source =
    trimmed === undefined || trimmed === "" ? entry.default : trimmed;
  if (source === undefined || source === "") {
    if (entry.required) return { issue: `${entry.name} is required.` };
    // A boolean with a documented default of false is false, not absent: the
    // report should say "off", not "unset", for something the code treats as
    // a decision.
    if (entry.kind === "boolean" && entry.default === undefined)
      return { value: undefined };
    return { value: undefined };
  }

  switch (entry.kind) {
    case "boolean": {
      const normalized = source.toLowerCase();
      if (BOOLEAN_TRUE.has(normalized)) return { value: true };
      if (BOOLEAN_FALSE.has(normalized)) return { value: false };
      return {
        issue: `${entry.name} accepts only "true", "1", "false", "0", or empty. Got "${source}".`,
      };
    }
    case "number":
    case "duration_ms": {
      const parsed = Number(source);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed))
        return {
          issue:
            entry.kind === "duration_ms"
              ? `${entry.name} must be a whole number of milliseconds. Got "${source}".`
              : `${entry.name} must be a whole number. Got "${source}".`,
        };
      const min = entry.min ?? (entry.kind === "duration_ms" ? 1 : undefined);
      if (min !== undefined && parsed < min)
        return {
          issue: `${entry.name} must be at least ${min}. Got ${parsed}.`,
        };
      if (entry.max !== undefined && parsed > entry.max)
        return {
          issue: `${entry.name} must be at most ${entry.max}. Got ${parsed}.`,
        };
      return { value: parsed };
    }
    case "url": {
      try {
        new URL(source);
      } catch {
        return {
          issue: `${entry.name} must be a full URL with a scheme and host. Got "${source}".`,
        };
      }
      return { value: source };
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(source))
        return { issue: `${entry.name} must be an email address.` };
      return { value: source };
    }
    case "enum": {
      const allowed = entry.values ?? [];
      if (!allowed.includes(source))
        return {
          issue: `${entry.name} accepts ${allowed.join(", ")}. Got "${source}".`,
        };
      return { value: source };
    }
    case "list": {
      const items = source
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return { value: items };
    }
    case "string":
    case "path": {
      if (entry.min !== undefined && source.length < entry.min)
        return {
          issue: `${entry.name} must be at least ${entry.min} characters.`,
        };
      /* Validate on the trimmed copy, hand back the bytes the operator set.
         A credential is whatever the provider issued, trailing space and all:
         trimming SECRET_KEY would invalidate every live session on upgrade,
         and trimming OIDC_CLIENT_SECRET would fail against a provider whose
         secret has not changed. */
      if (entry.secret && raw !== undefined && raw !== "")
        return { value: raw };
      return { value: source };
    }
  }
};

export interface ParsedConfig {
  values: Record<string, ConfigValue>;
  /** Startup-fatal: the server must not run with these. */
  issues: ConfigIssue[];
  /** Surfaced to the operator, but the process still starts. */
  reported: ConfigIssue[];
}

/**
 * Parse every variable in scope. Collects all issues rather than stopping, so
 * one boot prints every problem instead of one per restart.
 *
 * `issues` are startup-fatal; `reported` are the ones a subsystem handles on
 * its own (mail). Keeping them apart is the difference between "the mail port
 * is a typo" and "the server will not start".
 */
export const parseScope = (
  env: RawEnv,
  scope: ConfigScope,
  startup = true,
): ParsedConfig => {
  const values: Record<string, ConfigValue> = {};
  const issues: ConfigIssue[] = [];
  const reported: ConfigIssue[] = [];
  for (const entry of varsForScope(scope)) {
    const result = parseConfigValue(entry, env[entry.name]);
    if ("issue" in result)
      (isStartupFatal(entry) ? issues : reported).push({
        name: entry.name,
        message: result.issue,
      });
    else values[entry.name] = result.value;
  }
  issues.push(...groupIssues(env, scope, "error", startup));
  reported.push(...groupIssues(env, scope, "report", startup));
  return { values, issues, reported };
};

/**
 * Co-dependency violations. A group is satisfied when none of its members are
 * set, or when a full alternative is set. Anything between the two is a
 * subsystem that will not do what the operator believes it is doing.
 */
export const groupIssues = (
  env: RawEnv,
  scope: ConfigScope,
  severity: "error" | "report",
  startup = true,
): ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  const scoped = varsForScope(scope);
  for (const group of CONFIG_GROUPS) {
    if (group.severity !== severity) continue;
    if (group.startupOnly && !startup) continue;
    /* A group belongs to the scope that owns EVERY member, not any of them.
       WORKER_SECRET is read by both containers but WORKER_URL only by the
       server, so judging the pair in worker scope would fail a stock stack:
       the worker legitimately receives the secret and no URL. */
    const inScope = group.members.every((name) =>
      scoped.some((item) => item.name === name),
    );
    if (!inScope) continue;
    const set = group.members.filter((name) => present(env, name));
    if (set.length === 0) continue;

    if (group.requires && !present(env, group.requires)) {
      issues.push({ name: group.requires, message: group.message });
      continue;
    }
    if (group.alternatives) {
      const satisfied = group.alternatives.some((alternative) =>
        alternative.every((name) => present(env, name)),
      );
      if (!satisfied) issues.push({ name: group.name, message: group.message });
      continue;
    }
    if (group.requires) continue;
    if (set.length !== group.members.length)
      issues.push({ name: group.name, message: group.message });
  }
  return issues;
};

/* The wire shape of the effective-configuration view. Snake case because it
   crosses the public API boundary like everything else. */
export interface EffectiveConfigVar {
  name: string;
  /** Whether the environment carries a value for it at all. */
  set: boolean;
  source: "environment" | "default" | "unset";
  /** Rendered value, or null for a secret the caller may not read. */
  value: string | null;
  secret: boolean;
  summary: string;
  /** Set when the value cannot be honoured, with what to change. */
  issue?: string;
}

export interface EffectiveConfigSubsystem {
  name: ConfigSubsystem;
  title: string;
  /** null where a subsystem is always on and "active" means nothing. */
  active: boolean | null;
  /** Why it is inactive, or what is misconfigured. */
  detail: string | null;
  vars: EffectiveConfigVar[];
}

export interface EffectiveConfig {
  scope: ConfigScope;
  subsystems: EffectiveConfigSubsystem[];
  issues: ConfigIssue[];
}

const render = (value: ConfigValue): string | null => {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
};

/**
 * Build the redacted report. Secrets are reported as set or unset and never
 * rendered: the point of the view is "is this subsystem actually running and
 * why not", which never needs the value of a client secret.
 */
export const effectiveConfig = (
  env: RawEnv,
  scope: ConfigScope,
): EffectiveConfig => {
  const entries = varsForScope(scope);
  const issues: ConfigIssue[] = [
    ...groupIssues(env, scope, "error"),
    ...groupIssues(env, scope, "report"),
  ];
  const issueByName = new Map(
    issues.map((issue) => [issue.name, issue.message]),
  );

  const subsystems: EffectiveConfigSubsystem[] = [];
  for (const name of SUBSYSTEM_ORDER) {
    const owned = entries.filter((entry) => entry.subsystem === name);
    if (owned.length === 0) continue;
    const vars: EffectiveConfigVar[] = owned.map((entry) => {
      const isSet = present(env, entry.name);
      const parsed = parseConfigValue(entry, env[entry.name]);
      const value =
        "issue" in parsed
          ? isSet
            ? (env[entry.name] as string)
            : null
          : render(parsed.value);
      const single =
        "issue" in parsed ? parsed.issue : issueByName.get(entry.name);
      return {
        name: entry.name,
        set: isSet,
        source: isSet ? "environment" : value === null ? "unset" : "default",
        value: entry.secret ? null : value,
        secret: entry.secret === true,
        summary: entry.summary,
        ...(single ? { issue: single } : {}),
      };
    });

    const activation = SUBSYSTEM_ACTIVATION[name];
    let active: boolean | null = null;
    let detail: string | null = null;
    if (activation) {
      active = activation.every((varName) => present(env, varName));
      if (!active) {
        const missing = activation.filter((varName) => !present(env, varName));
        detail = `Inactive: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`;
      }
    }
    const groupIssue = CONFIG_GROUPS.filter(
      (group) => group.subsystem === name,
    ).find(
      (group) =>
        issueByName.has(group.name) || issueByName.has(group.requires ?? ""),
    );
    if (groupIssue) {
      active = false;
      detail = groupIssue.message;
    }
    /* A value that cannot be parsed turns the subsystem off no matter how
       complete the rest looks. SMTP_HOST and MAIL_FROM with SMTP_PORT=oops is
       a transport parseSmtpConfig refuses, and reporting it as active would
       tell an operator their mail works while nothing is being sent. */
    const brokenVar = vars.find((entry) => entry.issue !== undefined);
    if (brokenVar) {
      active = false;
      detail = brokenVar.issue ?? detail;
    }

    /* Mail's state comes from the transport parser itself, not from a second
       description of its rules. SMTP_USER without SMTP_PASS, or an SMTP_URL
       with the wrong scheme, satisfies every rule expressible here and is
       still refused by parseSmtpConfig. One parser, one answer. */
    if (name === "mail") {
      const parsed = parseSmtpConfig(env);
      if (parsed === null) {
        active = false;
        detail = detail ?? "Inactive: no SMTP transport is configured.";
      } else if (isSmtpConfigError(parsed)) {
        active = false;
        detail = parsed.error;
      } else if (!brokenVar) {
        active = true;
        detail = null;
      }
    }

    subsystems.push({
      name,
      title: SUBSYSTEM_TITLES[name],
      active,
      detail,
      vars,
    });
  }

  return { scope, subsystems, issues };
};
