/* Shared plumbing for the e2e specs: environment, login, seeding, and a
   check collector that fails the process on any red. */

import { firefox } from "playwright";

export const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
export const EMAIL = process.env.E2E_EMAIL ?? "";
export const PASSWORD = process.env.E2E_PASSWORD ?? "";
export const PROJECT_ID = process.env.E2E_PROJECT_ID ?? "";

export const results = [];
export const check = (name, pass, detail) => {
  results.push(Boolean(pass));
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`,
  );
};
export const note = (message) => console.log(`NOTE  ${message}`);

export const finish = async (browser) => {
  await browser.close();
  const failed = results.filter((entry) => !entry).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
};

export const launch = async () => {
  if (!EMAIL || !PASSWORD || !PROJECT_ID) {
    console.error("Set BASE_URL, E2E_EMAIL, E2E_PASSWORD, E2E_PROJECT_ID.");
    process.exit(2);
  }
  return firefox.launch();
};

export const adminPage = async (
  browser,
  viewport = { width: 1920, height: 1080 },
) => {
  const page = await browser.newPage({ viewport });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("input[type=email]", EMAIL);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForTimeout(1800);
  return page;
};

/* Creates a passphrase-less share of the project's first two video assets.
   Returns ids the caller needs and a revoke() for teardown. */
export const seedShare = async (page, options = {}) => {
  const seeded = await page.evaluate(
    async ({ projectId, options: opts }) => {
      const assets = await (
        await fetch(`/api/v1/projects/${projectId}/assets?limit=50`)
      ).json();
      const videos = assets.items
        .filter((asset) => asset.kind === "video")
        .slice(0, 2);
      if (videos.length < 2)
        return { error: `need 2 video assets, found ${videos.length}` };
      const created = await (
        await fetch("/api/v1/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_id: projectId,
            title: `E2E ${Math.floor(performance.timeOrigin + performance.now())}`,
            asset_ids: videos.map((asset) => asset.id),
            ...opts,
          }),
        })
      ).json();
      return {
        shareId: created.share.id,
        slug: created.share.slug,
        assetIds: videos.map((asset) => asset.id),
      };
    },
    { projectId: PROJECT_ID, options },
  );
  if (seeded.error) {
    console.error(`Cannot seed: ${seeded.error}`);
    process.exit(2);
  }
  return {
    ...seeded,
    patch: (body) =>
      page.evaluate(
        async ({ id, body: patchBody }) =>
          (
            await fetch(`/api/v1/shares/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patchBody),
            })
          ).status,
        { id: seeded.shareId, body },
      ),
    revoke: () =>
      page.evaluate(
        async (id) =>
          (await fetch(`/api/v1/shares/${id}`, { method: "DELETE" })).status,
        seeded.shareId,
      ),
  };
};

/* Enter a share as a named viewer; the share must be passphrase-less. */
export const enterShare = async (
  browser,
  slug,
  name,
  viewport = { width: 1920, height: 1080 },
) => {
  const page = await browser.newPage({ viewport });
  await page.goto(`${BASE}/s/${slug}`, { waitUntil: "networkidle" });
  await page.fill("form input:not([type=password]):not([type=email])", name);
  await page.click("button[type=submit]");
  return page;
};
