/* The review page on a phone, and the carry-forward banner anywhere.

   The top bar's three panels (versions, Info, the overflow menu) open from a
   band that scrolls sideways behind a fade. Asserting the panel is in the DOM
   proves nothing there: the fade is a mask, and a mask paints its whole
   subtree through itself, so a panel can lay out perfectly over the page and
   still be painted only inside the 40px band. That shipped, and it read as
   buttons that did nothing. These checks diff the pixels inside the panel's
   own rect instead. */

import {
  BASE,
  PROJECT_ID,
  adminPage,
  check,
  finish,
  launch,
  note,
} from "./lib.mjs";

const PHONE = { width: 390, height: 844 };

const browser = await launch();
const admin = await adminPage(browser, PHONE);

/* A second page is the image decoder: it draws two screenshots into a canvas
   and counts the pixels that differ inside a rect. */
const judge = await browser.newPage();
await judge.goto("about:blank");
const changedFraction = async (before, after, rect) =>
  judge.evaluate(
    async ([a, b, r]) => {
      const load = (dataUrl) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = dataUrl;
        });
      const [first, second] = await Promise.all([load(a), load(b)]);
      const canvas = document.createElement("canvas");
      canvas.width = r.w;
      canvas.height = r.h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(first, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const pa = ctx.getImageData(0, 0, r.w, r.h).data;
      ctx.clearRect(0, 0, r.w, r.h);
      ctx.drawImage(second, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const pb = ctx.getImageData(0, 0, r.w, r.h).data;
      let changed = 0;
      for (let index = 0; index < pa.length; index += 4)
        if (
          Math.abs(pa[index] - pb[index]) > 6 ||
          Math.abs(pa[index + 1] - pb[index + 1]) > 6 ||
          Math.abs(pa[index + 2] - pb[index + 2]) > 6
        )
          changed += 1;
      return changed / (r.w * r.h);
    },
    [
      `data:image/png;base64,${before.toString("base64")}`,
      `data:image/png;base64,${after.toString("base64")}`,
      rect,
    ],
  );

const rectOf = (page, selector) =>
  page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    return {
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y)),
      w: Math.min(innerWidth, Math.round(box.width)),
      h: Math.min(innerHeight, Math.round(box.height)),
    };
  }, selector);

try {
  const assets = await admin.evaluate(
    async (projectId) =>
      (
        await (
          await fetch(`/api/v1/projects/${projectId}/assets?limit=50`)
        ).json()
      ).items,
    PROJECT_ID,
  );
  if (!assets.length) {
    console.error("Cannot run: the project has no assets.");
    process.exit(2);
  }

  // ---- the phone top bar: every panel has to reach the screen ----
  await admin.goto(`${BASE}/projects/${PROJECT_ID}/assets/${assets[0].id}`, {
    waitUntil: "networkidle",
  });
  await admin.waitForTimeout(1800);

  for (const [label, trigger, panel] of [
    ["the version menu", ".vtrigger", ".vpanel"],
    ["the Info panel", ".info-trigger", ".info-panel"],
    ["the overflow menu", ".more-trigger", ".more-panel"],
  ]) {
    const before = await admin.screenshot();
    await admin.locator(trigger).first().click();
    await admin.waitForTimeout(500);
    const rect = await rectOf(admin, panel);
    if (!rect) {
      check(`${label} opens on a phone`, false, "no laid-out panel");
      continue;
    }
    const fraction = await changedFraction(
      before,
      await admin.screenshot(),
      rect,
    );
    check(
      `${label} paints on a phone`,
      fraction > 0.5,
      `${(fraction * 100).toFixed(1)}% of its own rect changed`,
    );
    await admin.keyboard.press("Escape");
    await admin.waitForTimeout(300);
    check(`${label} dismisses`, (await admin.locator(panel).count()) === 0);
  }

  // ---- carry forward: what the banner offers, and that it stops offering ----
  const versioned = await admin.evaluate(
    async (ids) => {
      for (const id of ids) {
        const items = (
          await (await fetch(`/api/v1/assets/${id}/versions`)).json()
        ).items;
        if (items.length >= 2)
          return { assetId: id, newest: items[0].id, previous: items[1].id };
      }
      return null;
    },
    assets.map((asset) => asset.id),
  );

  if (!versioned) {
    note(
      "carry forward not checked: no asset in this project has two versions.",
    );
  } else {
    const seeded = await admin.evaluate(async (target) => {
      const made = await (
        await fetch(`/api/v1/versions/${target.previous}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body_text: "E2E carry probe", frame_in: 12 }),
        })
      ).json();
      return made.id;
    }, versioned);

    await admin.goto(
      `${BASE}/projects/${PROJECT_ID}/assets/${versioned.assetId}`,
      {
        waitUntil: "networkidle",
      },
    );
    await admin.waitForTimeout(1800);

    const bannerText = async () => {
      const row = admin.locator(".carry-row");
      return (await row.count())
        ? (await row.first().innerText()).replace(/\s+/g, " ").trim()
        : null;
    };
    const offered = await bannerText();
    check(
      "the banner offers the uncarried note",
      Boolean(offered),
      offered ?? "no banner",
    );
    check(
      "one note reads as one note",
      /^1 open note on v\d+ has not been carried/.test(offered ?? ""),
      offered ?? "",
    );

    await admin.locator(".carry-row button").first().click();
    await admin.waitForTimeout(2500);
    const copies = await admin.evaluate(
      async ([newest, sourceId]) => {
        const items = (
          await (await fetch(`/api/v1/versions/${newest}/comments`)).json()
        ).items;
        return items.filter(
          (comment) => comment.carried_from_comment_id === sourceId,
        );
      },
      [versioned.newest, seeded],
    );
    check("the note is copied onto this version", copies.length === 1);
    check("the banner stops offering it", (await bannerText()) === null);
    await admin.reload({ waitUntil: "networkidle" });
    await admin.waitForTimeout(1800);
    check("and stays gone across a reload", (await bannerText()) === null);

    await admin.evaluate(
      async (ids) => {
        for (const id of ids)
          await fetch(`/api/v1/comments/${id}`, { method: "DELETE" });
      },
      [seeded, ...copies.map((comment) => comment.id)],
    );
  }
} finally {
  await finish(browser);
}
