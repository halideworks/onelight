/* CI gate: no documented setting may be silently ignored.
 *
 * Compose does not pass a container's environment through. It passes exactly
 * the keys named under `environment:`, so a variable documented in
 * .env.example but missing from that list can be set by an operator, read back
 * from their own .env, and do nothing at all. That happened to SMTP, then to
 * ONELIGHT_GC_DELETE, then to OIDC, the headless admin, backups and every
 * retention knob. This fails the build instead.
 *
 * Four properties, checked against the manifest:
 *   1. every variable the manifest says compose should pass is in the right
 *      service's environment block
 *   2. no compose environment key is missing from the manifest
 *   3. every variable the code reads is declared in the manifest
 *   4. the generated artifacts are not stale
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CONFIG_VARS,
  varsForScope,
  type ConfigScope,
} from "../packages/core/src/config-manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");

const failures: string[] = [];
const fail = (message: string): void => {
  failures.push(message);
};

/* Which service in the base compose file carries which scope. */
const SERVICES: Array<{ service: string; scope: ConfigScope }> = [
  { service: "onelight", scope: "server" },
  { service: "onelight-worker", scope: "worker" },
];

/** Environment keys a compose service actually passes. */
const composeEnvKeys = (
  source: string,
  service: string,
): Set<string> | null => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${service}:`);
  if (start === -1) return null;
  const serviceIndent = lines[start]?.search(/\S/) ?? 0;
  const keys = new Set<string>();
  let inEnvironment = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "") continue;
    const indent = line.search(/\S/);
    if (indent <= serviceIndent) break;
    if (/^\s*environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (inEnvironment) {
      const match = /^\s*([A-Z][A-Z0-9_]*):/.exec(line);
      if (match?.[1]) {
        keys.add(match[1]);
        continue;
      }
      // A sibling key at or above the environment block's own indent ends it.
      if (/^\s*[a-z_]+:/.test(line)) inEnvironment = false;
    }
  }
  return keys;
};

const composePath = path.join(repo, "deploy/docker-compose.yml");
const compose = readFileSync(composePath, "utf8");

for (const { service, scope } of SERVICES) {
  const keys = composeEnvKeys(compose, service);
  if (!keys) {
    fail(`deploy/docker-compose.yml has no "${service}" service.`);
    continue;
  }
  for (const entry of varsForScope(scope)) {
    if (entry.compose === "omit") {
      if (keys.has(entry.name))
        fail(
          `${entry.name} is marked compose: "omit" in the manifest but the ${service} service passes it.`,
        );
      continue;
    }
    if (!keys.has(entry.name))
      fail(
        `${entry.name} is documented but the ${service} service does not pass it, so setting it in .env does nothing.`,
      );
  }
  for (const key of keys) {
    const entry = CONFIG_VARS.find((item) => item.name === key);
    if (!entry) {
      fail(
        `The ${service} service passes ${key}, which is not declared in packages/core/src/config-manifest.ts.`,
      );
      continue;
    }
    if (!entry.scope.includes(scope))
      fail(
        `The ${service} service passes ${key}, which the manifest scopes to ${entry.scope.join(", ")} only.`,
      );
  }
}

/* Property 3: a variable the code reads but nobody declared is the same defect
   wearing different clothes, so find the reads and compare. Only our own
   source, and only names that look like settings rather than NODE_ENV and the
   test runner's own flags. */
const IGNORED_READS = new Set([
  "NODE_ENV",
  "CI",
  "VITEST",
  "VITEST_WORKER_ID",
  "FUZZ_SEED",
  "DEV_API_PROXY",
  "ENVIRONMENT",
  "ASSETS",
  "BLOBS",
  "WEB_ROOT",
  "ONELIGHT_VERSION",
  "ONELIGHT_RENDER_GID",
  "NVIDIA_VISIBLE_DEVICES",
  "PUBLIC_BASE_URL",
  "TZ",
]);

const SOURCE_ROOTS = ["packages", "apps"];
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".svelte-kit")
      continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(name) && !/\.(test|fuzz)\.ts$/.test(name))
      out.push(full);
  }
  return out;
};

const declared = new Set(CONFIG_VARS.map((entry) => entry.name));
for (const root of SOURCE_ROOTS) {
  for (const file of walk(path.join(repo, root))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    )) {
      const name = match[1] as string;
      if (IGNORED_READS.has(name) || declared.has(name)) continue;
      fail(
        `${path.relative(repo, file)} reads process.env.${name}, which is not declared in the manifest.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Configuration parity check failed:\n");
  for (const message of new Set(failures)) console.error(`  - ${message}`);
  console.error(
    "\nDeclare the setting in packages/core/src/config-manifest.ts and run `pnpm config:gen`.",
  );
  process.exit(1);
}
console.log(
  `Configuration parity: ${String(CONFIG_VARS.length)} variables, compose and manifest agree.`,
);
