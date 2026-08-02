/* Writes every configuration artifact from the manifest.
 *
 *   pnpm config:gen     rewrite .env.example, the compose environment lists,
 *                       and docs/CONFIGURATION.md
 *   pnpm config:check   fail if any of them is stale (what CI runs)
 *
 * The compose files keep their hand-written structure: only the region between
 * the ONELIGHT-CONFIG markers inside each service's environment block is
 * generated, so volumes, healthchecks and GPU overrides stay where the person
 * who wrote them put them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CONFIG_GROUPS,
  SUBSYSTEM_ORDER,
  SUBSYSTEM_TITLES,
  varsForScope,
  type ConfigScope,
  type ConfigVar,
} from "../packages/core/src/config-manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

const BEGIN = "# ONELIGHT-CONFIG:BEGIN";
const END = "# ONELIGHT-CONFIG:END";

const wrap = (text: string, width: number, prefix: string): string[] => {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push(prefix.trimEnd());
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (current === "") current = word;
      else if (`${current} ${word}`.length + prefix.length <= width)
        current = `${current} ${word}`;
      else {
        lines.push(`${prefix}${current}`);
        current = word;
      }
    }
    if (current !== "") lines.push(`${prefix}${current}`);
  }
  return lines;
};

const defaultLine = (entry: ConfigVar): string | null => {
  if (entry.default !== undefined) return `Default ${entry.default}.`;
  if (entry.defaultNote !== undefined) return `Default: ${entry.defaultNote}.`;
  return null;
};

const serverNames = new Set(varsForScope("server").map((entry) => entry.name));
const allVars = (): ConfigVar[] => [
  ...varsForScope("server"),
  ...varsForScope("worker").filter((entry) => !serverNames.has(entry.name)),
];

/* What an operator can actually change from this file.

   Two kinds are left out, however real a setting each one is. Compose does not
   pass the "omit" entries at all (WORK_ROOT, HOST), and it pins the "literal"
   ones to a container value that ignores .env (PORT, DATABASE_PATH,
   BLOB_ROOT). Offering either here would recreate the exact defect this
   manifest exists to end: a line in .env that reads back fine and changes
   nothing at all. Both stay in docs/CONFIGURATION.md with what they resolve
   to under compose. */
const CONFIG_VARS_FOR_ENV: ConfigVar[] = allVars().filter(
  (entry) => entry.compose !== "omit" && entry.compose !== "literal",
);

/* .env.example: every variable an operator can set, grouped by subsystem, with
   the prose that explains what happens if they get it wrong. */
const renderEnvExample = (): string => {
  const lines: string[] = [
    "# Onelight configuration. Copy to .env and adjust.",
    "#",
    "# Generated from packages/core/src/config-manifest.ts by `pnpm config:gen`.",
    "# Edit the manifest, not this file: CI fails when the two disagree.",
    "#",
    "# docker compose refuses to start unless SECRET_KEY and WORKER_SECRET are",
    "# set, because there are no insecure defaults for either.",
    "#",
    "# Every setting compose passes is here. A few the code reads are absent on",
    "# purpose, because compose pins them to the container: docs/CONFIGURATION.md",
    "# lists those with the reason.",
  ];

  for (const subsystem of SUBSYSTEM_ORDER) {
    const entries = CONFIG_VARS_FOR_ENV.filter(
      (entry) => entry.subsystem === subsystem,
    );
    if (entries.length === 0) continue;
    lines.push("", `# --- ${SUBSYSTEM_TITLES[subsystem]} ---`);
    const groups = CONFIG_GROUPS.filter(
      (group) => group.subsystem === subsystem,
    );
    for (const group of groups) lines.push(...wrap(group.message, 76, "# "));

    for (const entry of entries) {
      lines.push("");
      lines.push(...wrap(entry.summary, 76, "# "));
      if (entry.doc) {
        lines.push("#");
        lines.push(...wrap(entry.doc, 76, "# "));
      }
      const note = defaultLine(entry);
      if (note) lines.push(...wrap(note, 76, "# "));
      if (entry.kind === "enum" && entry.values)
        lines.push(...wrap(`One of: ${entry.values.join(", ")}.`, 76, "# "));
      const value = entry.example ?? entry.default ?? "";
      const assignment = `${entry.name}=${value}`;
      lines.push(entry.commented || !value ? `#${assignment}` : assignment);
    }
  }
  return `${lines.join("\n")}\n`;
};

const composeLines = (scope: ConfigScope, indent: string): string[] => {
  const lines: string[] = [];
  for (const entry of varsForScope(scope)) {
    if (entry.compose === "omit") continue;
    if (entry.compose === "literal") {
      const value = entry.composeValueByScope?.[scope] ?? entry.composeValue;
      lines.push(`${indent}${entry.name}: ${value ?? ""}`);
      continue;
    }
    if (entry.compose === "required") {
      lines.push(
        `${indent}${entry.name}: \${${entry.name}:?${entry.name} is required}`,
      );
      continue;
    }
    /* Defaults are NOT duplicated here. Compose passes an empty string for
       anything the operator did not set, and empty means unset everywhere the
       manifest is parsed, so the default lives in exactly one place. A
       composeDefault is only for facts compose alone knows, like the service
       name the worker answers to. */
    lines.push(
      `${indent}${entry.name}: \${${entry.name}:-${entry.composeDefault ?? ""}}`,
    );
  }
  return lines;
};

/**
 * Replace the generated region inside a compose file. Each service's block is
 * marked once, so a file may carry two of them (server and worker).
 */
const renderCompose = (source: string, scopes: ConfigScope[]): string => {
  const out: string[] = [];
  const lines = source.split("\n");
  let inside = false;
  let scopeIndex = 0;
  for (const line of lines) {
    if (line.includes(BEGIN)) {
      inside = true;
      out.push(line);
      const indent = `${line.slice(0, line.indexOf("#"))}`;
      const scope = scopes[scopeIndex];
      if (!scope) throw new Error("More generated regions than scopes given.");
      out.push(...composeLines(scope, indent));
      scopeIndex += 1;
      continue;
    }
    if (line.includes(END)) {
      inside = false;
      out.push(line);
      continue;
    }
    if (!inside) out.push(line);
  }
  if (scopeIndex !== scopes.length)
    throw new Error(
      `Expected ${scopes.length} generated region(s), found ${scopeIndex}.`,
    );
  return out.join("\n");
};

const renderDocs = (): string => {
  const lines: string[] = [
    "# Configuration",
    "",
    "Generated from `packages/core/src/config-manifest.ts` by `pnpm config:gen`.",
    "Edit the manifest, not this file.",
    "",
    "Every variable below is passed to the container by `deploy/docker-compose.yml`,",
    "or is noted as deliberately not passed. A setting that reaches neither is a CI",
    "failure: `pnpm config:check` compares this manifest against the compose files.",
    "",
    "Values are validated at startup. A malformed number or an unknown enum value",
    "stops the server with a message naming the variable, rather than falling back",
    "to a default nobody asked for.",
  ];

  for (const subsystem of SUBSYSTEM_ORDER) {
    const entries = allVars().filter((entry) => entry.subsystem === subsystem);
    if (entries.length === 0) continue;
    lines.push("", `## ${SUBSYSTEM_TITLES[subsystem]}`, "");
    for (const group of CONFIG_GROUPS.filter(
      (item) => item.subsystem === subsystem,
    ))
      lines.push(
        `${group.severity === "error" ? "Startup fails:" : "Note:"} ${group.message}`,
        "",
      );
    lines.push(
      "| Variable | Container | Default | Notes |",
      "|---|---|---|---|",
    );
    for (const entry of entries) {
      const containers = entry.scope.join(", ");
      const fallback =
        entry.default !== undefined
          ? `\`${entry.default}\``
          : entry.defaultNote !== undefined
            ? entry.defaultNote
            : entry.required
              ? "required"
              : "unset";
      const notes = [
        entry.summary,
        entry.doc,
        entry.kind === "enum" && entry.values
          ? `One of: ${entry.values.join(", ")}.`
          : undefined,
        entry.compose === "omit"
          ? `Not passed by compose: ${entry.composeNote ?? "deliberately"}.`
          : undefined,
        entry.secret ? "Credential: never shown in the admin view." : undefined,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\n+/g, " ");
      lines.push(
        `| \`${entry.name}\` | ${containers} | ${fallback} | ${notes} |`,
      );
    }
  }
  lines.push(
    "",
    "## Checking what is actually in effect",
    "",
    "An administrator can read the resolved configuration at",
    "`GET /api/v1/admin/system/config`, or on the admin system page. It reports each",
    "subsystem as active or inactive with the reason, and each variable as set or",
    "defaulted. Secrets report only whether they are set.",
    "",
  );
  return lines.join("\n");
};

const targets = (): Array<{ file: string; next: string }> => {
  const composeTargets: Array<{ file: string; scopes: ConfigScope[] }> = [
    { file: "deploy/docker-compose.yml", scopes: ["server", "worker"] },
  ];
  const out = [
    { file: ".env.example", next: renderEnvExample() },
    { file: "docs/CONFIGURATION.md", next: renderDocs() },
  ];
  for (const target of composeTargets) {
    const full = path.join(repo, target.file);
    out.push({
      file: target.file,
      next: renderCompose(readFileSync(full, "utf8"), target.scopes),
    });
  }
  return out;
};

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const target of targets()) {
  const full = path.join(repo, target.file);
  const current = existsSync(full) ? readFileSync(full, "utf8") : null;
  if (current === target.next) continue;
  if (check) stale.push(target.file);
  else writeFileSync(full, target.next);
}

if (check && stale.length > 0) {
  console.error(
    `These files no longer match packages/core/src/config-manifest.ts:\n${stale
      .map((file) => `  - ${file}`)
      .join("\n")}\n\nRun \`pnpm config:gen\` and commit the result.`,
  );
  process.exit(1);
}
if (!check) console.log("Configuration artifacts written.");
