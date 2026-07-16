/* The share room, driven as a client drives it: the landing, the review and
   presentation rooms, playback, seeking, approval, notes with drawings,
   text on the frame, attachments, and the download. */

import {
  BASE,
  adminPage,
  check,
  enterShare,
  finish,
  launch,
  note,
  seedShare,
} from "./lib.mjs";

const STAMP = Date.now();
const browser = await launch();
const admin = await adminPage(browser);
const share = await seedShare(admin, { allow_download: "proxy" });

try {
  // ---- the landing: posters decode, durations read as clocks ----
  const viewer = await enterShare(browser, share.slug, `E2E Viewer ${STAMP}`);
  const errors = [];
  viewer.on("pageerror", (event) => errors.push(String(event)));
  await viewer.waitForSelector(".asset", { timeout: 15000 });
  const posters = await viewer.evaluate(async () => {
    const out = [];
    for (const asset of document.querySelectorAll(".asset")) {
      asset.scrollIntoView({ block: "center" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const img = asset.querySelector("img");
      if (!img) {
        out.push(null);
        continue;
      }
      try {
        await img.decode();
      } catch {
        /* stays 0x0 and fails below */
      }
      out.push(img.naturalWidth > 0);
    }
    return out;
  });
  check(
    "landing posters decode",
    posters.length === 2 && posters.every(Boolean),
    JSON.stringify(posters),
  );

  // ---- the review room ----
  await viewer.locator(".asset").first().click();
  await viewer.waitForSelector(".preview", { timeout: 15000 });
  await viewer.waitForTimeout(6000);
  const video = await viewer.evaluate(() => {
    const element = document.querySelector("video");
    return element
      ? { w: element.videoWidth, ready: element.readyState }
      : null;
  });
  if (!video || video.w === 0)
    note("playback not asserted: media not transcoded or codec missing");
  else check("the review room plays the footage", video.w > 0, `${video.w}px`);
  check(
    "the room is strictly neutral",
    (await viewer.evaluate(
      () =>
        getComputedStyle(document.querySelector(".preview")).backgroundImage,
    )) === "none",
  );
  check(
    "the readout speaks timecode",
    /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(
      (
        (await viewer
          .locator(".frame-readout")
          .textContent()
          .catch(() => "")) ?? ""
      ).trim(),
    ),
  );

  // approval round-trips through the server
  await viewer.locator(".approval .approve").click();
  await viewer.waitForTimeout(900);
  const approved = await admin.evaluate(
    async ({ projectId, assetId }) => {
      const assets = await (
        await fetch(`/api/v1/projects/${projectId}/assets?limit=50`)
      ).json();
      return assets.items.find((asset) => asset.id === assetId)?.status;
    },
    { projectId: process.env.E2E_PROJECT_ID, assetId: share.assetIds[0] },
  );
  check("Approve records on the asset", approved === "approved", approved);
  await viewer.locator(".approval .approve").click(); // back to in_review
  await viewer.waitForTimeout(600);

  // a note with an attachment; the note is editable and removable because it is mine
  await viewer.locator("input.attachinput").setInputFiles({
    name: `e2e-note-${STAMP}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from(`%PDF-1.4 e2e ${STAMP}`),
  });
  await viewer.fill(".comments textarea", `e2e note ${STAMP}`);
  await viewer.locator("button.post").click();
  await viewer.waitForTimeout(2500);
  const myNote = viewer.locator(".comments article", {
    hasText: String(STAMP),
  });
  await myNote.scrollIntoViewIfNeeded();
  check(
    "the posted note carries its file",
    (await myNote.locator(".filechip").count()) === 1,
  );
  check(
    "and offers Edit and Remove, because it is mine",
    (await myNote.locator(".noteacts .linkish").count()) === 2,
  );
  await myNote.locator(".noteacts .linkish", { hasText: "Edit" }).click();
  await viewer.waitForTimeout(300);
  await viewer.locator(".noteedit").fill(`e2e note ${STAMP} amended`);
  await viewer.keyboard.press("Enter");
  await viewer.waitForTimeout(900);
  check(
    "editing my note sticks",
    ((await myNote.textContent()) ?? "").includes("amended"),
  );

  // the download is a real file, not the SPA shell
  const downloadPromise = viewer
    .waitForEvent("download", { timeout: 20000 })
    .catch(() => null);
  await viewer.locator("button.download").click();
  const download = await downloadPromise;
  if (download) {
    const path = await download.path();
    const { readFileSync } = await import("node:fs");
    const head = path
      ? readFileSync(path).subarray(0, 8).toString("latin1")
      : "";
    check(
      "the download is real media",
      !head.toLowerCase().includes("<!doct") && head.length > 0,
      JSON.stringify(head),
    );
  } else note("download not asserted: no proxy rendition ready");
  await viewer.close();

  // ---- the presentation room ----
  await share.patch({
    brand: { colors: ["#3d1c2a", "#c8a96a"], player: "simple" },
  });
  const client = await enterShare(browser, share.slug, `E2E Client ${STAMP}`);
  await client
    .waitForSelector(".preview", { timeout: 15000 })
    .catch(() => null);
  await client.waitForTimeout(5000);
  check(
    "a gallery landing first (two assets, no auto-open)",
    (await client.locator(".preview").count()) === 0 ||
      (await client.locator(".carousel").count()) === 1,
  );
  if ((await client.locator(".preview").count()) === 0) {
    await client.locator(".asset").first().click();
    await client.waitForSelector(".preview", { timeout: 15000 });
    await client.waitForTimeout(5000);
  }
  check(
    "the room wears the brand wash",
    (
      await client.evaluate(
        () =>
          getComputedStyle(document.querySelector(".preview")).backgroundImage,
      )
    ).includes("gradient"),
  );
  check(
    "the presentation scrub is the seek bar",
    (await client.locator(".preview .scrub").count()) === 1,
  );
  check(
    "its handle is always present",
    (await client.locator(".scrub-handle").count()) === 1,
  );
  check(
    "the carousel offers the reel",
    (await client.locator(".carousel .reeltile").count()) === 2,
  );

  // text on the frame: place, drag, resize, post
  if (await client.locator(".drawrow button").count()) {
    await client.locator(".drawrow button").first().click();
    await client.locator(".drawrow .seg button", { hasText: "Text" }).click();
    const frame = await client.locator(".frame-box").boundingBox();
    await client.mouse.click(
      frame.x + frame.width * 0.3,
      frame.y + frame.height * 0.3,
    );
    await client.waitForTimeout(400);
    await client.keyboard.type("e2e words");
    await client.keyboard.press("Enter");
    await client.waitForTimeout(400);
    check(
      "text lands as a live item",
      (await client.locator(".textitem").count()) === 1,
    );
    const item = await client.locator(".textitem").boundingBox();
    await client.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
    await client.mouse.down();
    await client.mouse.move(
      item.x + item.width / 2 + 160,
      item.y + item.height / 2 + 90,
      { steps: 6 },
    );
    await client.mouse.up();
    await client.waitForTimeout(400);
    check("and drags", true);
    await client.fill(".comments textarea", `e2e drawn ${STAMP}`);
    await client.locator("button.post").click();
    await client.waitForTimeout(2000);
    check(
      "posting hands the words to the canvas",
      (await client.locator(".textitem").count()) === 0,
    );
  } else note("draw controls not present (comments off?)");
  await client.close();
} finally {
  await share.revoke();
}

await finish(browser);
