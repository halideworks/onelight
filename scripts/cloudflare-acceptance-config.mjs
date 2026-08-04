#!/usr/bin/env node
/*
 * The wrangler config for a throwaway acceptance deployment.
 *
 * Derived from apps/cf/wrangler.jsonc rather than written out again, so the
 * thing CI deploys is the thing the project actually deploys: a compatibility
 * flag or a binding added to the real config reaches the acceptance leg
 * without anybody remembering to copy it. Only what has to differ is patched.
 *
 * What differs, and why:
 *   name          a per-run name, so two runs cannot collide and so nothing
 *                 in the account can be mistaken for a real deployment
 *   d1 / r2       the ids and names of the resources this run just created
 *   (the cron is kept: it is what runs the sweeps, so a deployment without it
 *    cannot queue a watermark or bury an abandoned job)
 *
 * Usage:
 *   node scripts/cloudflare-acceptance-config.mjs \
 *     --name onelight-ci-123 --database-id <uuid> --bucket onelight-ci-123 \
 *     --out /tmp/wrangler.ci.json
 */
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const arg = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1])
    throw new Error(`${flag} is required.`);
  return process.argv[index + 1];
};

/* wrangler.jsonc is JSON with comments. Stripping them with a regex would
   corrupt any string containing // or /*, so this walks the text and only
   treats a comment marker as one when it is outside a string. */
const stripComments = (text) => {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    out += char;
  }
  /* Trailing commas are legal in jsonc and common in this file. */
  return out.replace(/,(\s*[}\]])/g, "$1");
};

const source = readFileSync("apps/cf/wrangler.jsonc", "utf8");
const config = JSON.parse(stripComments(source));

config.name = arg("--name");
if (!Array.isArray(config.d1_databases) || !config.d1_databases[0])
  throw new Error("The real config declares no D1 binding to patch.");
config.d1_databases[0].database_name = arg("--name");
config.d1_databases[0].database_id = arg("--database-id");
if (!Array.isArray(config.r2_buckets) || !config.r2_buckets[0])
  throw new Error("The real config declares no R2 binding to patch.");
config.r2_buckets[0].bucket_name = arg("--bucket");
/* The cron stays.
 *
 * It was deleted here to stop a throwaway Worker firing every minute until the
 * delete landed. That was wrong: the scheduled handler is what runs the
 * sweeps, and the sweeps are what queue a watermark, backfill a still ladder
 * and bury an abandoned job. Removing it made the acceptance run test a
 * deployment that could never do any of that -- and then a share sat at "202,
 * pending" for four minutes and the run failed for a reason the deployment
 * would not have had.
 *
 * A run lives about fifteen minutes, so this costs about fifteen invocations. */

/* Both of these are set after the deploy instead.
 *
 * SECRET_KEY because the development one must not be deployed even briefly.
 * PUBLIC_URL because it cannot be known any earlier: it is the URL the deploy
 * prints, and this file is written before that exists.
 *
 * They have to leave `vars` rather than merely be overridden, because wrangler
 * refuses a secret whose name is already a var binding -- "Binding name
 * 'PUBLIC_URL' already in use" -- rather than shadowing it. A secret binding
 * is just a string the Worker reads through env, so using one for a URL that
 * is not secret costs nothing and saves a second deploy. */
delete config.vars?.SECRET_KEY;
delete config.vars?.PUBLIC_URL;

/* The asset and migration directories are relative to the real config's
   directory, and this one is written elsewhere, so they are resolved here. */
if (config.assets?.directory) config.assets.directory = "packages/web/build";
if (config.d1_databases[0].migrations_dir)
  config.d1_databases[0].migrations_dir = "packages/db/migrations";
config.main = "apps/cf/src/index.ts";

writeFileSync(arg("--out"), `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrote ${arg("--out")} for ${config.name} (d1 ${arg("--database-id")}, r2 ${arg("--bucket")})`,
);
