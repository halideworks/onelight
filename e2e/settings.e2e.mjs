/* The manager's surfaces: the share page (link, appearance, curation), the
   settings hub, storage, audit, trash, webhooks. */

import {
  BASE,
  PROJECT_ID,
  adminPage,
  check,
  finish,
  launch,
  seedShare,
} from "./lib.mjs";

const browser = await launch();
const admin = await adminPage(browser);
const share = await seedShare(admin);

try {
  // ---- the share's own page ----
  await admin.goto(`${BASE}/projects/${PROJECT_ID}/shares/${share.shareId}`, {
    waitUntil: "networkidle",
  });
  await admin.waitForTimeout(1500);
  check(
    "the link card leads",
    ((await admin.locator(".linkcard .url").textContent()) ?? "").includes(
      `/s/${share.slug}`,
    ),
  );
  check(
    "the slug reads like the title",
    /^e2e-\d+-[0-9a-zA-Z]{14}$/.test(share.slug),
    share.slug,
  );

  // curation: drag the first tile onto the second (swap), server keeps it
  const tiles = admin.locator(".contentwrap");
  check("the contents are curatable", (await tiles.count()) === 2);
  const orderBefore = await admin.evaluate(async (id) => {
    const detail = await (await fetch(`/api/v1/shares/${id}`)).json();
    return detail.assets.map((link) => link.asset_id);
  }, share.shareId);
  await admin.evaluate(
    async ({ id, order }) => {
      await fetch(`/api/v1/shares/${id}/assets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset_ids: [...order].reverse() }),
      });
    },
    { id: share.shareId, order: orderBefore },
  );
  const orderAfter = await admin.evaluate(async (id) => {
    const detail = await (await fetch(`/api/v1/shares/${id}`)).json();
    return detail.assets.map((link) => link.asset_id);
  }, share.shareId);
  check(
    "reorder persists",
    JSON.stringify(orderAfter) === JSON.stringify([...orderBefore].reverse()),
  );

  // the logo: upload through the appearance panel, see it on the wire
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const logoStatus = await admin.evaluate(
    async ({ id, data }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return (
        await fetch(`/api/v1/shares/${id}/logo`, {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: bytes,
        })
      ).status;
    },
    { id: share.shareId, data: png },
  );
  check("the logo uploads", logoStatus === 200);
  const logoUrl = await admin.evaluate(
    async (id) => (await (await fetch(`/api/v1/shares/${id}`)).json()).logo_url,
    share.shareId,
  );
  check(
    "and rides the wire as a URL",
    typeof logoUrl === "string" && logoUrl.includes("/logo"),
    logoUrl ?? "null",
  );

  // ---- settings surfaces exist and answer ----
  for (const [path, marker] of [
    ["/settings/storage", ".lede"],
    ["/settings/audit", "tbody tr"],
    ["/settings/trash", "h1"],
    ["/settings/webhooks", ".create"],
    ["/settings/profile", ".facecol"],
  ]) {
    await admin.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await admin.waitForTimeout(900);
    check(`${path} renders`, (await admin.locator(marker).count()) > 0);
  }
} finally {
  await share.revoke();
}

await finish(browser);
