/* Run only against a disposable instance. Every upload belongs to a project
   created here, and original bytes are checked after each structural move. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { firefox } from "playwright";

const base = process.env.BASE_URL;
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
assert(base && email && password, "Set BASE_URL, E2E_EMAIL and E2E_PASSWORD.");
const browser = await firefox.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
context.setDefaultTimeout(20_000);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let project;
const screenshots = process.env.E2E_SCREENSHOTS;
const shot = async (name) => {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/version-stack-${name}.png` });
};
const api = async (method, path, data) => {
  const response = await context.request.fetch(`${base}/api/v1${path}`, {
    method,
    headers: { origin: new URL(base).origin },
    ...(data === undefined ? {} : { data }),
  });
  assert(
    response.ok(),
    `${method} ${path}: ${response.status()} ${await response.text()}`,
  );
  return response.status() === 204 ? undefined : response.json();
};
const responseFor = (path) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1${path}` &&
      response.request().method() === "POST",
  );
const file = (name, contents) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(contents),
});
const seed = (name) =>
  api(
    "POST",
    `/projects/${project.id}/uploads/direct?filename=${encodeURIComponent(name)}`,
    Buffer.from(`Original ${name}`),
  );
const versions = (id) => api("GET", `/assets/${id}/versions`);
const asset = (id) => api("GET", `/assets/${id}`);
const review = async (id) => {
  await page.goto(`${base}/projects/${project.id}/assets/${id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator(".renametrigger").waitFor();
  await page
    .locator(".vtrigger-no")
    .filter({ hasText: /^v\d+$/ })
    .waitFor();
};
const openVersions = async () => {
  if (
    (await page.locator(".vtrigger").getAttribute("aria-expanded")) !== "true"
  )
    await page.locator(".vtrigger").click();
  await page.locator(".vpanel").waitFor();
};
const upload = async (id, entry) => {
  await openVersions();
  await page.getByLabel("Carry open notes forward", { exact: true }).uncheck();
  const response = responseFor(`/assets/${id}/versions`);
  await page.locator(".vupload input[type=file]").setInputFiles(entry);
  const landed = await response;
  assert.equal(landed.status(), 201, await landed.text());
  const result = await landed.json();
  await page
    .locator(".vtrigger-no")
    .filter({ hasText: `v${result.version.version_no}` })
    .waitFor();
  await page
    .getByRole("complementary", { name: "Recent action" })
    .getByRole("status")
    .filter({ hasText: "Stacked" })
    .waitFor();
  return result;
};
const undo = async (conflict = false) => {
  const notification = page.getByRole("complementary", {
    name: "Recent action",
  });
  await notification.getByRole("button", { name: "Undo", exact: true }).click();
  await notification
    .getByRole("status")
    .filter({ hasText: conflict ? "could not be undone safely" : /^Undid / })
    .waitFor();
};
const unstack = async (version) => {
  await openVersions();
  await page
    .getByRole("button", {
      name: `Unstack v${version.version_no}`,
      exact: true,
    })
    .click();
  const confirm = page.getByRole("dialog", {
    name: `Unstack v${version.version_no}?`,
    exact: true,
  });
  const response = responseFor(`/versions/${version.id}/unstack`);
  await confirm.getByRole("button", { name: "Unstack", exact: true }).click();
  const moved = await response;
  assert(moved.ok(), await moved.text());
  await page
    .getByRole("complementary", { name: "Recent action" })
    .getByRole("status")
    .filter({ hasText: "Unstacked" })
    .waitFor();
  return moved.json();
};
const originalBytes = async (id, expected) => {
  const download = await api("GET", `/versions/${id}/download?kind=original`);
  const response = await context.request.get(new URL(download.url, base).href);
  assert(response.ok(), `Original download: ${response.status()}`);
  assert.deepEqual(await response.body(), expected);
};
const membership = (listing) =>
  listing.items
    .map(({ id, version_no }) => ({ id, version_no }))
    .sort((a, b) => a.version_no - b.version_no);
const noteExists = async (versionId, noteId) => {
  const listing = await api("GET", `/versions/${versionId}/comments`);
  assert(
    listing.items.some((note) => note.id === noteId),
    "The original note ID survives the move",
  );
};

try {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  project = await api("POST", "/projects", {
    name: `Version stack ${Date.now()}`,
  });
  const initial = await seed("Stack original.txt");
  const source = initial.asset;
  const v1 = (await versions(source.id)).items[0];
  await review(source.id);

  const firstUpload = file(
    "Upload undo.txt",
    "The upload must survive Undo unchanged.",
  );
  const first = await upload(source.id, firstUpload);
  assert.equal((await versions(source.id)).items.length, 2);
  assert.equal((await asset(source.id)).current_version_id, first.version.id);
  await undo();
  assert.deepEqual(membership(await versions(source.id)), [
    { id: v1.id, version_no: 1 },
  ]);
  assert.equal((await asset(source.id)).current_version_id, v1.id);
  const preserved = await api("GET", `/versions/${first.version.id}`);
  assert.notEqual(preserved.asset_id, source.id);
  assert.equal(preserved.version_no, 1);
  assert.equal((await asset(preserved.asset_id)).name, firstUpload.name);
  await originalBytes(preserved.id, firstUpload.buffer);
  const trash = await api("GET", `/projects/${project.id}/trash`);
  assert(
    !trash.items.some(
      (entry) => entry.id === source.id || entry.id === preserved.asset_id,
    ),
  );
  console.log(
    "PASS version-upload Undo preserves original bytes in a separate live asset",
  );

  const second = await upload(
    source.id,
    file("Stack second.txt", "Second version."),
  );
  const thirdFile = file("Stack third.txt", "Third version with its own note.");
  const third = await upload(source.id, thirdFile);
  const note = await api("POST", `/versions/${third.version.id}/comments`, {
    body_text: "Keep this note with the original version.",
  });
  const before = membership(await versions(source.id));
  await api("PATCH", `/versions/${v1.id}/stack`, { version_no: 1 });
  await review(source.id);
  const detached = await unstack(third.version);
  assert.equal(detached.asset.current_version_id, third.version.id);
  assert.equal((await asset(source.id)).current_version_id, v1.id);
  assert.deepEqual(
    membership(await versions(source.id)),
    before.filter((entry) => entry.id !== third.version.id),
  );
  await noteExists(third.version.id, note.id);
  await originalBytes(third.version.id, thirdFile.buffer);
  await shot("unstacked");
  // Client navigation keeps the in-memory Undo history while remounting the
  // review, so this cannot pass through a closure over the old page instance.
  await page
    .getByRole("link", { name: "Back to project", exact: true })
    .click();
  await page.getByRole("link", { name: source.name, exact: true }).click();
  await page.locator(".renametrigger").waitFor();
  await undo();
  assert.deepEqual(membership(await versions(source.id)), before);
  assert.equal((await asset(source.id)).current_version_id, v1.id);
  assert.equal(
    (await api("GET", `/versions/${third.version.id}`)).asset_id,
    source.id,
  );
  await noteExists(third.version.id, note.id);
  await originalBytes(third.version.id, thirdFile.buffer);
  assert.equal(
    (
      await context.request.get(`${base}/api/v1/assets/${detached.asset.id}`)
    ).status(),
    404,
  );
  await openVersions();
  assert.deepEqual(await page.locator(".vpanel .vno").allTextContents(), [
    "v3",
    "v2",
    "v1",
  ]);
  await shot("restored-menu");
  await page.setViewportSize({ width: 390, height: 844 });
  await openVersions();
  const phoneMenu = await page.locator(".vpanel").boundingBox();
  assert(phoneMenu.x >= 0 && phoneMenu.x + phoneMenu.width <= 390);
  assert(phoneMenu.y >= 0 && phoneMenu.y + phoneMenu.height <= 844);
  await shot("phone-menu");
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    "PASS Unstack and Undo restore exact version numbers, non-latest current, comments and bytes",
  );

  // Moving the current, non-latest version falls back to the newest remaining
  // version. Undo must put the original current pointer back, not assume latest.
  const detachedCurrent = await unstack(v1);
  assert.equal((await asset(source.id)).current_version_id, third.version.id);
  assert.deepEqual(
    membership(await versions(source.id)),
    before.filter((entry) => entry.id !== v1.id),
  );
  await undo();
  assert.deepEqual(membership(await versions(source.id)), before);
  assert.equal((await asset(source.id)).current_version_id, v1.id);
  assert.equal(
    (
      await context.request.get(
        `${base}/api/v1/assets/${detachedCurrent.asset.id}`,
      )
    ).status(),
    404,
  );
  console.log(
    "PASS unstacking the current version and Undo preserve the original non-latest pointer",
  );

  await api("POST", `/versions/${second.version.id}/comments`, {
    body_text: "A predecessor note that has not been carried forward.",
  });
  await openVersions();
  await page
    .locator(".vrow")
    .filter({
      has: page.locator(".vno").filter({ hasText: /^v3$/ }),
    })
    .locator(".vpick")
    .click();
  const carry = page.getByRole("button", {
    name: "Carry forward from v2",
    exact: true,
  });
  await carry.waitFor();
  await unstack(second.version);
  await carry.waitFor({ state: "detached" });
  assert.equal(await page.locator(".vtrigger-no").innerText(), "v3");
  await undo();
  await carry.waitFor();
  assert.equal(await page.locator(".vtrigger-no").innerText(), "v3");
  console.log(
    "PASS predecessor Unstack and Undo refresh carry-forward without changing the viewed version",
  );

  const changed = await unstack(second.version);
  await api("PATCH", `/assets/${changed.asset.id}`, {
    name: "A colleague edited this detached asset",
  });
  await undo(true);
  assert.equal(
    (await api("GET", `/versions/${second.version.id}`)).asset_id,
    changed.asset.id,
  );
  assert.equal(
    (await asset(changed.asset.id)).name,
    "A colleague edited this detached asset",
  );
  assert.deepEqual(
    membership(await versions(source.id)),
    before.filter((entry) => entry.id !== second.version.id),
  );
  console.log("PASS stale Undo refuses to discard an edited detached asset");

  const referenced = await unstack(third.version);
  const share = await api("POST", "/shares", {
    project_id: project.id,
    title: "Detached asset is now shared",
    asset_ids: [referenced.asset.id],
  });
  await undo(true);
  assert.equal(
    (await api("GET", `/versions/${third.version.id}`)).asset_id,
    referenced.asset.id,
  );
  assert(
    (await api("GET", `/shares/${share.share.id}`)).assets.some(
      (link) => link.asset_id === referenced.asset.id,
    ),
  );
  await noteExists(third.version.id, note.id);
  await originalBytes(third.version.id, thirdFile.buffer);
  await openVersions();
  assert(
    await page
      .getByRole("button", { name: "Unstack v1", exact: true })
      .isDisabled(),
  );
  console.log(
    "PASS Undo respects new share references and a sole remaining version cannot be unstacked",
  );

  const batchNames = ["Batch left.txt", "Batch right.txt"];
  const batchAssets = await Promise.all(batchNames.map(seed));
  await page.goto(`${base}/projects/${project.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Saved view").waitFor();
  let releaseMatches;
  const matching = new Promise((resolve) => {
    releaseMatches = resolve;
  });
  const matchPath = `**/api/v1/projects/${project.id}/versions/match`;
  await page.route(matchPath, async (route) => {
    const response = await route.fetch();
    await matching;
    await route.fulfill({ response });
  });
  const prematureAssets = [];
  const observeAssets = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/api/v1/projects/${project.id}/assets/batch`
    )
      prematureAssets.push(request.postDataJSON());
  };
  page.on("request", observeAssets);
  try {
    await page
      .getByLabel("Add files", { exact: true })
      .setInputFiles(
        batchNames.map((name) => file(name, `New batch version of ${name}`)),
      );
    await page.waitForFunction(() => {
      const rows = [
        ...document.querySelectorAll('[aria-label="Upload queue"] > li'),
      ];
      return (
        rows.length === 2 &&
        rows.every(
          (row) =>
            row.classList.contains("q-landing") ||
            row.classList.contains("q-done"),
        )
      );
    });
    assert.deepEqual(
      prematureAssets,
      [],
      "Uploads must await their pending filename match before choosing a destination",
    );
  } finally {
    releaseMatches();
    page.off("request", observeAssets);
  }
  const batchResponse = responseFor(`/projects/${project.id}/versions/batch`);
  await page
    .getByRole("button", { name: "Upload as new versions", exact: true })
    .click();
  const batchLanded = await batchResponse;
  assert(batchLanded.ok(), await batchLanded.text());
  const batch = await batchLanded.json();
  await page.unroute(matchPath);
  assert.equal(batch.items.length, 2);
  assert.deepEqual(batch.failures, []);
  await page
    .getByRole("complementary", { name: "Recent action" })
    .getByRole("status")
    .filter({ hasText: "Stacked 2 versions" })
    .waitFor();
  for (const entry of batchAssets)
    assert.equal((await versions(entry.asset.id)).items.length, 2);
  await undo();
  for (const entry of batchAssets)
    assert.equal((await versions(entry.asset.id)).items.length, 1);
  for (const entry of batch.items) {
    const moved = await api("GET", `/versions/${entry.version_id}`);
    assert.notEqual(moved.asset_id, entry.asset_id);
    const original = batchAssets.find(
      (item) => item.asset.id === entry.asset_id,
    );
    await originalBytes(
      entry.version_id,
      Buffer.from(`New batch version of ${original.asset.name}`),
    );
    await page
      .getByRole("link", { name: original.asset.name, exact: true })
      .first()
      .waitFor();
  }
  console.log(
    "PASS library batch-upload Undo separates every new version without deleting files",
  );

  const subsequent = await seed("Second delivery.txt");
  await page
    .getByRole("button", { name: "Clear finished", exact: true })
    .click();
  await page
    .getByLabel("Add files", { exact: true })
    .setInputFiles(
      file(
        subsequent.asset.name,
        "A second delivery without leaving the library.",
      ),
    );
  const subsequentResponse = responseFor(
    `/projects/${project.id}/versions/batch`,
  );
  await page
    .getByRole("button", { name: "Upload as new versions", exact: true })
    .click();
  const subsequentLanded = await subsequentResponse;
  assert(subsequentLanded.ok(), await subsequentLanded.text());
  assert.equal((await versions(subsequent.asset.id)).items.length, 2);
  await page
    .getByRole("complementary", { name: "Recent action" })
    .getByRole("status")
    .filter({ hasText: "Stacked 1 version" })
    .waitFor();
  await undo();
  assert.equal((await versions(subsequent.asset.id)).items.length, 1);
  console.log(
    "PASS consecutive library deliveries each offer version stacking and Undo",
  );

  const racedAsset = batchAssets[0].asset;
  const pendingUpload = await api(
    "POST",
    `/projects/${project.id}/uploads/direct?filename=Initial-race.txt&attach=0`,
    Buffer.from("Concurrent stack fixture."),
  );
  const pendingVersion = await api(
    "POST",
    `/assets/${racedAsset.id}/versions`,
    {
      upload_id: pendingUpload.upload.id,
    },
  );
  // Observe actual SSE delivery, without synthesizing events or changing the
  // app listener. Hold only the initial HTTP snapshot while the stack changes.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener("open", () => {
          window.__versionStreamReady = true;
        });
        this.addEventListener("asset.versions_changed", () => {
          window.__versionEvents = (window.__versionEvents ?? 0) + 1;
        });
      }
    };
  });
  await page.goto(`${base}/projects/${project.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Saved view").waitFor();
  await page.waitForFunction(() => window.__versionStreamReady);
  const previewCard = page
    .locator(".card, .list tbody tr[data-virtual-item]")
    .filter({
      has: page.getByRole("link", { name: source.name, exact: true }),
    });
  await previewCard.focus();
  await previewCard.press("Space");
  const fallback = page.locator(".quick-look .fallback");
  await fallback.waitFor();
  const originalPreview = await fallback.elementHandle();
  const previewRequests = [];
  const observePreview = (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      [
        `/api/v1/assets/${source.id}`,
        `/api/v1/assets/${source.id}/versions`,
        `/api/v1/versions/${v1.id}/renditions`,
      ].includes(path)
    )
      previewRequests.push(path);
  };
  page.on("request", observePreview);
  let unrelatedMove;
  try {
    await page.evaluate(() => {
      window.__versionEvents = 0;
    });
    unrelatedMove = await api(
      "POST",
      `/versions/${pendingVersion.version.id}/unstack`,
      {
        expected: pendingVersion.stack_state,
      },
    );
    await page.waitForFunction(() => window.__versionEvents > 0);
    await page
      .getByRole("link", { name: "Initial-race.txt", exact: true })
      .first()
      .waitFor({ state: "attached" });
    assert.deepEqual(
      previewRequests,
      [],
      "An unrelated stack event must not reload Quick Look",
    );
    assert(
      await originalPreview.evaluate((element) => element.isConnected),
      "The existing preview stays mounted",
    );
  } finally {
    page.off("request", observePreview);
    await page.keyboard.press("Escape");
  }
  await api("POST", `/versions/${pendingVersion.version.id}/restack`, {
    expected: unrelatedMove.source_stack,
    undo_token: unrelatedMove.undo_token,
  });
  console.log(
    "PASS an unrelated stack change preserves Quick Look without refetching its preview",
  );

  let releaseSnapshot;
  let snapshotReady;
  let snapshotFailed;
  const held = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const ready = new Promise((resolve, reject) => {
    snapshotReady = resolve;
    snapshotFailed = reject;
  });
  const listingPath = `**/api/v1/assets/${racedAsset.id}/versions`;
  let holdFirst = true;
  await page.route(listingPath, async (route) => {
    if (!holdFirst) return route.continue();
    holdFirst = false;
    try {
      const response = await route.fetch();
      snapshotReady();
      await held;
      await route.fulfill({ response });
    } catch (caught) {
      snapshotFailed(caught);
      await route.abort();
    }
  });
  try {
    const initialRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/v1/assets/${racedAsset.id}/versions`,
    );
    await page.goto(`${base}/projects/${project.id}/assets/${racedAsset.id}`, {
      waitUntil: "domcontentloaded",
    });
    await initialRequest;
    await ready;
    await page.waitForFunction(() => window.__versionStreamReady);
    await api("POST", `/versions/${pendingVersion.version.id}/unstack`, {
      expected: pendingVersion.stack_state,
    });
    await page.waitForFunction(() => window.__versionEvents > 0);
    releaseSnapshot();
    await page.locator(".vtrigger-no").filter({ hasText: /^v1$/ }).waitFor();
    await openVersions();
    await page.waitForFunction(() => {
      const numbers = [...document.querySelectorAll(".vpanel .vno")].map(
        (element) => element.textContent,
      );
      return numbers.length === 1 && numbers[0] === "v1";
    });
    assert.deepEqual(
      membership(await versions(racedAsset.id)).map(
        (version) => version.version_no,
      ),
      [1],
    );
  } finally {
    releaseSnapshot();
    await page.unroute(listingPath);
  }
  console.log(
    "PASS a stack event during initial loading supersedes the stale HTTP snapshot",
  );
  assert.deepEqual(errors, [], "No uncaught browser errors");
} catch (caught) {
  await shot("failure").catch(() => {});
  console.error("Browser errors:", errors);
  throw caught;
} finally {
  try {
    if (project) await api("DELETE", `/projects/${project.id}`);
  } finally {
    await browser.close();
  }
}
