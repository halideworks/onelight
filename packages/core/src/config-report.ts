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
  varsForScope,
  type ConfigScope,
  type ConfigSubsystem,
  type ConfigVar,
} from "./config-manifest.js";

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
      return { value: source };
    }
  }
};

export interface ParsedConfig {
  values: Record<string, ConfigValue>;
  issues: ConfigIssue[];
}

/** Parse every variable in scope. Collects all issues rather than stopping. */
export const parseScope = (env: RawEnv, scope: ConfigScope): ParsedConfig => {
  const values: Record<string, ConfigValue> = {};
  const issues: ConfigIssue[] = [];
  for (const entry of varsForScope(scope)) {
    const result = parseConfigValue(entry, env[entry.name]);
    if ("issue" in result)
      issues.push({ name: entry.name, message: result.issue });
    else values[entry.name] = result.value;
  }
  issues.push(...groupIssues(env, scope, "error"));
  return { values, issues };
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
): ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  for (const group of CONFIG_GROUPS) {
    if (group.severity !== severity) continue;
    const inScope = group.members.some((name) => {
      const entry = varsForScope(scope).find((item) => item.name === name);
      return entry !== undefined;
    });
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
