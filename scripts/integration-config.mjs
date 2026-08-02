/* The acceptance check for the configuration manifest.
 *
 * The defect this closes is not "the code ignores a setting", it is "compose
 * never handed the setting to the container", which no unit test can see. So
 * this runs against the real stack: the caller has already recreated it with
 * an env file that turns on OIDC, backups, a custom retention window and a
 * non-default worker timeout, and this asserts the running server reports
 * every one of them through the admin endpoint.
 *
 * Usage: node scripts/integration-config.mjs
 * Env: BASE_URL, ONELIGHT_E2E_EMAIL, ONELIGHT_E2E_PASSWORD.
 */

import console from "node:console";
import process from "node:process";

/* Node 18+ global fetch, referenced through globalThis so the script needs no
   import for it. Same convention as scripts/integration-e2e.mjs. */
const { fetch, URL } = globalThis;

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = "/api/v1";
const EMAIL = process.env.ONELIGHT_E2E_EMAIL ?? "e2e-admin@example.com";
const PASSWORD =
  process.env.ONELIGHT_E2E_PASSWORD ?? "integration-only-password";

const log = (message) => {
  console.log(`[config] ${message}`);
};

let failures = 0;
const check = (condition, message) => {
  if (condition) {
    log(`ok: ${message}`);
    return;
  }
  failures += 1;
  console.error(`[config] FAILED: ${message}`);
};

const cookies = new Map();
const request = async (method, path, options = {}) => {
  const headers = { ...(options.headers ?? {}) };
  if (cookies.size)
    headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (method !== "GET") headers.origin = BASE_URL;
  let body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(new URL(path, BASE_URL), {
    method,
    headers,
    body,
  });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return response;
};

const login = async () => {
  const response = await request("POST", `${API}/auth/login`, {
    json: { email: EMAIL, password: PASSWORD },
  });
  if (!response.ok)
    throw new Error(
      `login failed: ${response.status} ${await response.text()}`,
    );
  log(`authenticated as ${EMAIL}`);
};

const main = async () => {
  await login();
  const response = await request("GET", `${API}/admin/system/config`);
  if (!response.ok)
    throw new Error(
      `config endpoint failed: ${response.status} ${await response.text()}`,
    );
  const body = await response.json();
  check(body.available === true, "the server reports an effective config");

  const vars = new Map(
    body.subsystems
      .flatMap((subsystem) => subsystem.vars)
      .map((entry) => [entry.name, entry]),
  );
  const subsystem = (name) =>
    body.subsystems.find((item) => item.name === name);

  const effective = (name) => vars.get(name)?.value ?? null;
  const isSet = (name) => vars.get(name)?.set === true;

  /* Each of these was set ONLY in the env file the stack was recreated with.
     A value arriving here proves the whole path: env file, compose
     environment list, container, parser, endpoint. */

  // 1. Single sign-on: on, with the issuer that was configured, and its
  //    secret reported as set but never rendered.
  check(subsystem("oidc")?.active === true, "OIDC reports active");
  check(
    effective("OIDC_ISSUER") === "https://id.integration.test",
    `OIDC_ISSUER is the configured issuer (got ${String(effective("OIDC_ISSUER"))})`,
  );
  check(
    effective("OIDC_CLIENT_ID") === "onelight-integration",
    "OIDC_CLIENT_ID is the configured client",
  );
  check(
    isSet("OIDC_CLIENT_SECRET") && effective("OIDC_CLIENT_SECRET") === null,
    "OIDC_CLIENT_SECRET reports as set without being rendered",
  );

  // 2. Backups: on, with the configured directory and retention.
  check(subsystem("backups")?.active === true, "backups report active");
  check(
    effective("BACKUP_DIR") === "/data/backups",
    `BACKUP_DIR is the configured directory (got ${String(effective("BACKUP_DIR"))})`,
  );
  check(
    effective("BACKUP_KEEP") === "5",
    `BACKUP_KEEP is 5 (got ${String(effective("BACKUP_KEEP"))})`,
  );

  // 3. A custom retention window, distinct from the 30-day default.
  check(
    effective("TRASH_PURGE_AFTER_MS") === "1209600000",
    `TRASH_PURGE_AFTER_MS is the configured 14 days (got ${String(effective("TRASH_PURGE_AFTER_MS"))})`,
  );
  check(
    vars.get("TRASH_PURGE_AFTER_MS")?.source === "environment",
    "TRASH_PURGE_AFTER_MS is reported as configured, not defaulted",
  );

  // 4. A non-default worker timeout, distinct from the 6-hour default.
  check(
    effective("WORKER_JOB_TIMEOUT_MS") === "900000",
    `WORKER_JOB_TIMEOUT_MS is the configured 15 minutes (got ${String(effective("WORKER_JOB_TIMEOUT_MS"))})`,
  );

  // And nothing the server was started with leaked into the payload.
  const payload = JSON.stringify(body);
  for (const secret of [
    process.env.SECRET_KEY,
    process.env.WORKER_SECRET,
    "integration-oidc-client-secret",
  ])
    if (secret)
      check(
        !payload.includes(secret),
        "no credential value appears in the report",
      );

  // A setting nobody configured still reads as a default rather than as set.
  check(
    vars.get("UPLOAD_REAP_AFTER_MS")?.source === "default",
    "an unconfigured setting reports as defaulted",
  );

  if (failures > 0)
    throw new Error(`${failures} configuration check(s) failed`);
  log("every configured value reached the running server");
};

main().catch((error) => {
  console.error(`[config] ${error.message}`);
  process.exit(1);
});
