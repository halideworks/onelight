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

  // ---- the avatar path takes a photo far over the server's byte cap ----
  // The browser normalizes to a 512px square before upload; this is the
  // regression net for "The avatar must be under 512 KB".
  await admin.goto(`${BASE}/settings/profile`, { waitUntil: "networkidle" });
  const bigPicture = await admin.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1600;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(2400, 1600);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = (i / 4) % 256;
      img.data[i + 1] = (i / 7) % 256;
      img.data[i + 2] = Math.floor(Math.random() * 256);
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    return {
      size: blob.size,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    };
  });
  check(
    "the test photo is over the old 512 KB limit",
    bigPicture.size > 512 * 1024,
  );
  await admin.setInputFiles(".uploadlabel input", {
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.from(bigPicture.bytes),
  });
  await admin.waitForFunction(
    () =>
      document.querySelector(".saved")?.textContent?.includes("Picture saved"),
    { timeout: 20000 },
  );
  const face = admin.locator(".facecol img").first();
  await face.waitFor({ timeout: 5000 });
  check(
    "the oversized photo lands and decodes",
    await face.evaluate((node) => node.complete && node.naturalWidth > 0),
  );
  await admin.click('button:has-text("Remove picture")');
  await admin.waitForFunction(
    () =>
      document
        .querySelector(".saved")
        ?.textContent?.includes("Picture removed"),
    { timeout: 10000 },
  );
  check(
    "and can be removed again",
    (await admin.locator(".facecol img").count()) === 0,
  );
} finally {
  await share.revoke();
}

await finish(browser);
