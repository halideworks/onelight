/* Real private-workspace flows. Fixtures belong to a disposable project, not
   the integration project's media or anybody's working library. */
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
const stamp = Date.now();
const screenshots = process.env.E2E_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
const shot = async (name) => {
  if (screenshots)
    await page.screenshot({ path: `${screenshots}/workbench-${name}.png` });
};
const api = async (method, path, data, client = context) => {
  const response = await client.request.fetch(`${base}/api/v1${path}`, {
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
const login = async (asEmail = email, asPassword = password) => {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email", { exact: true }).fill(asEmail);
  await page.getByLabel("Password", { exact: true }).fill(asPassword);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
};
let project;
let secondUser;
const uploaded = [];
const library = async () => {
  await page.goto(`${base}/projects/${project.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Saved view").waitFor();
};
const listResponse = (test = () => true) =>
  page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/v1/projects/${project.id}/assets` &&
      response.ok() &&
      test(url.searchParams)
    );
  });
const filter = async (label, value) => {
  if ((await page.getByLabel(label, { exact: true }).inputValue()) === value)
    return;
  await Promise.all([
    listResponse(),
    page.getByLabel(label, { exact: true }).selectOption(value),
  ]);
};
const row = (name) =>
  page
    .locator(".card, .list tbody tr[data-virtual-item]")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
const menu = async (name, action) => {
  await row(name).click({ button: "right" });
  await page.getByRole("menuitem", { name: action, exact: true }).click();
};
const undo = async () => {
  await page
    .getByRole("complementary", { name: "Recent action" })
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Recent action" })
    .getByRole("status")
    .filter({ hasText: /Undid|changes? undone/ })
    .waitFor();
};
const rename = async (from, to) => {
  await menu(from, "Rename");
  const dialog = page.getByRole("dialog", {
    name: "Rename asset",
    exact: true,
  });
  await dialog.getByLabel("Asset name").fill(to);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await row(to).waitFor();
};

try {
  await login();
  project = await api("POST", "/projects", { name: `Workbench ${stamp}` });
  const folder = await api("POST", `/projects/${project.id}/folders`, {
    name: "Pinned work",
  });
  // More than one server page. Approved assets straddle the first page so a
  // client-only filter cannot accidentally satisfy the completeness check.
  for (let start = 0; start < 105; start += 5) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(5, 105 - start) }, (_, offset) => {
        const index = start + offset;
        return api(
          "POST",
          `/projects/${project.id}/uploads/direct?filename=Workbench-${String(index).padStart(3, "0")}.txt`,
          Buffer.from(`Workbench fixture ${index}`),
        );
      }),
    );
    uploaded.push(...batch.map((result) => result.asset));
  }
  const image = await api(
    "POST",
    `/projects/${project.id}/uploads/direct?filename=Z-preview.png`,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afoQAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await api("PATCH", `/assets/${uploaded[0].id}`, { status: "approved" });
  await api("PATCH", `/assets/${uploaded[104].id}`, { status: "approved" });
  await library();

  // A short viewport can trigger automatic pagination before a manual click.
  const secondResponse = listResponse(
    (params) =>
      params.get("sort") === "name" &&
      params.get("direction") === "asc" &&
      Boolean(params.get("cursor")),
  );
  await filter("Sort assets", "name");
  let first;
  if (
    (await page.getByLabel("Reverse sort direction").innerText()).includes(
      "Descending",
    )
  ) {
    const response = listResponse(
      (params) => params.get("direction") === "asc",
    );
    await page.getByLabel("Reverse sort direction").click();
    first = await (await response).json();
  } else
    first = await api(
      "GET",
      `/projects/${project.id}/assets?sort=name&direction=asc&limit=100`,
    );
  assert.equal(first.items.length, 100);
  assert.equal(first.items[0].name, "Workbench-000.txt");
  assert(first.next_cursor);
  await row("Workbench-000.txt").waitFor();
  const more = page.getByRole("button", { name: "Load more", exact: true });
  if (await more.count()) await more.evaluate((button) => button.click());
  const second = await (await secondResponse).json();
  const names = [...first.items, ...second.items].map((asset) => asset.name);
  assert.equal(names.length, 106);
  assert.equal(new Set(names).size, 106);
  assert.deepEqual(names, [...names].sort());
  assert.equal(second.next_cursor, null);
  await page.evaluate(() => window.scrollTo(0, 0));
  console.log(
    "PASS server sorting crosses pagination without omissions or duplicates",
  );

  await filter("Filter by status", "approved");
  await filter("Filter by kind", "file");
  await row("Workbench-000.txt").waitFor();
  await row("Workbench-104.txt").waitFor();
  assert.equal(await page.locator(".card[role=option]").count(), 2);
  await page
    .getByRole("slider", { name: "Thumbnail size", exact: true })
    .focus();
  await page
    .getByRole("slider", { name: "Thumbnail size", exact: true })
    .press("End");
  assert.equal(
    await page
      .getByRole("slider", { name: "Thumbnail size", exact: true })
      .getAttribute("aria-valuenow"),
    "400",
  );
  await page.getByRole("button", { name: "List", exact: true }).click();
  const comfortablePadding = await row("Workbench-000.txt")
    .locator("td")
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).paddingTop));
  await page.getByText("Display options", { exact: true }).click();
  await page.getByLabel("Information density").selectOption("compact");
  const compactPadding = await row("Workbench-000.txt")
    .locator("td")
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).paddingTop));
  assert(
    compactPadding < comfortablePadding,
    "Compact density reduces actual row spacing",
  );
  await page.getByLabel("Folder panel width").focus();
  await page.getByLabel("Folder panel width").press("End");
  await page.getByLabel("Folder panel width").press("ArrowLeft");
  assert.equal(await page.getByLabel("Folder panel width").inputValue(), "350");
  await page.getByRole("checkbox", { name: "Size", exact: true }).uncheck();
  assert.equal(
    await page.getByRole("columnheader", { name: "Size", exact: true }).count(),
    0,
  );
  const columnCount = await page.locator(".list thead th").count();
  assert.equal(
    await row("Workbench-000.txt").locator("td").count(),
    columnCount,
  );
  await page.getByText("Display options", { exact: true }).click();
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  const saveDialog = page.getByRole("dialog", { name: "Save library view" });
  await saveDialog.getByLabel("View name").fill("Approved compact");
  await saveDialog
    .getByRole("button", { name: "Save view", exact: true })
    .click();
  await page.waitForFunction(() =>
    Object.keys(localStorage).some(
      (key) =>
        key.startsWith("onelight.workbench.") &&
        localStorage.getItem(key).includes("Approved compact"),
    ),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await row("Workbench-104.txt").waitFor();
  assert.equal(
    await page.getByLabel("Filter by status").inputValue(),
    "approved",
  );
  assert.equal(
    await page.getByRole("columnheader", { name: "Size", exact: true }).count(),
    0,
  );
  await page.getByText("Display options", { exact: true }).click();
  assert.equal(
    await page.getByLabel("Information density").inputValue(),
    "compact",
  );
  assert.equal(await page.getByLabel("Folder panel width").inputValue(), "350");
  await page.getByLabel("Information density").selectOption("comfortable");
  await page.getByText("Display options", { exact: true }).click();
  await filter("Filter by status", "");
  await page
    .getByLabel("Saved view")
    .selectOption({ label: "Approved compact" });
  await row("Workbench-104.txt").waitFor();
  assert.equal(
    await page.getByLabel("Filter by status").inputValue(),
    "approved",
  );
  await page.getByRole("button", { name: "Rename view", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("View name")
    .fill("Approved working view");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Approved working view" })
      .count(),
    1,
  );
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await saveDialog.getByLabel("View name").fill("Duplicate approved view");
  await saveDialog
    .getByRole("button", { name: "Save view", exact: true })
    .click();
  await page
    .getByLabel("Saved view")
    .selectOption({ label: "Duplicate approved view" });
  await page.getByRole("button", { name: "Rename view", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("View name")
    .fill("Duplicate renamed");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Approved working view" })
      .count(),
    1,
  );
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Duplicate renamed" })
      .count(),
    1,
  );
  await page.getByRole("button", { name: "Delete view", exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Duplicate renamed" })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Approved working view" })
      .count(),
    1,
  );
  await page
    .getByLabel("Saved view")
    .selectOption({ label: "Approved working view" });
  await shot("saved-view");
  console.log(
    "PASS saved views restore filters, density and aligned metadata columns across reloads",
  );

  const trigger = page.getByRole("button", {
    name: "Open command palette",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", {
    name: "Go anywhere. Keep your place.",
  });
  const search = palette.getByRole("combobox");
  await search.waitFor();
  assert(
    await search.evaluate((element) => element === document.activeElement),
  );
  await search.fill(`Workbench ${stamp}`);
  await palette
    .getByRole("option", { name: new RegExp(`Workbench ${stamp}.*Project`) })
    .waitFor();
  await search.fill("Workbench-104");
  await palette
    .getByRole("option", { name: /Workbench-104.txt.*Asset/ })
    .waitFor();
  await shot("palette");
  await page.setViewportSize({ width: 1440, height: 480 });
  await search.fill("Workbench");
  await palette
    .getByRole("option", { name: /Workbench-.*Asset/ })
    .first()
    .waitFor();
  const shortPalette = await palette.boundingBox();
  assert(
    shortPalette.y >= 0 && shortPalette.y + shortPalette.height <= 480,
    "Many palette results fit a short desktop viewport",
  );
  await shot("short-palette");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  assert(
    await trigger.evaluate((element) => element === document.activeElement),
  );
  await trigger.click();
  await search.fill("Library: grid");
  await search.press("ArrowDown");
  await search.press("ArrowUp");
  await search.press("Enter");
  await page.getByRole("listbox", { name: "Assets", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("slider", { name: "Thumbnail size", exact: true })
      .getAttribute("aria-valuenow"),
    "400",
  );
  console.log(
    "PASS palette searches real projects/assets, runs context commands and restores focus",
  );

  const firstRow = row("Workbench-000.txt");
  await firstRow.focus();
  await firstRow.press("Space");
  const preview = page.getByRole("dialog", { name: /^Quick Look:/ });
  await preview.waitFor();
  assert.match(await preview.getAttribute("aria-label"), /Workbench-000.txt/);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    assert(
      await preview.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    );
  }
  await preview
    .getByRole("button", { name: "Next preview", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Quick Look: Workbench-104.txt", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
  assert(
    await firstRow.evaluate(
      (element) =>
        element === document.activeElement ||
        element.contains(document.activeElement),
    ),
  );
  assert.equal(await firstRow.getAttribute("aria-selected"), "false");
  await menu("Workbench-000.txt", "Inspect");
  const inspector = page.getByRole("region", {
    name: "Asset inspector",
    exact: true,
  });
  await inspector
    .getByRole("heading", { name: "Versions and processing" })
    .waitFor();
  await inspector
    .getByText("Workbench-000.txt", { exact: true })
    .first()
    .waitFor();
  await shot("inspector");
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  console.log(
    "PASS Quick Look preserves selection, traps/restores focus, navigates and shares the inspector",
  );

  await menu("Workbench-000.txt", "Pinned work");
  await page.getByRole("status").filter({ hasText: "Moved" }).waitFor();
  assert.equal(
    (await api("GET", `/assets/${uploaded[0].id}`)).folder_id,
    folder.id,
  );
  await page.locator(`#tree-row-${folder.id}`).click();
  await row("Workbench-000.txt").waitFor();
  await page.getByRole("button", { name: "Pin folder", exact: true }).click();
  const pins = page.getByRole("navigation", { name: "Pinned folders" });
  await pins
    .getByRole("button", { name: "Pinned work", exact: true })
    .waitFor();
  await page.waitForFunction(
    (id) =>
      Object.keys(localStorage).some(
        (key) =>
          key.startsWith("onelight.workbench.") &&
          localStorage
            .getItem(key)
            .includes(`"id":"${id}","name":"Pinned work"`),
      ),
    folder.id,
  );
  await page.locator("#tree-row-root").click();
  await pins.getByRole("button", { name: "Pinned work", exact: true }).click();
  await row("Workbench-000.txt").waitFor();
  await undo();
  assert.equal((await api("GET", `/assets/${uploaded[0].id}`)).folder_id, null);
  await pins
    .getByRole("button", { name: "Unpin Pinned work", exact: true })
    .click();
  await pins.waitFor({ state: "detached" });
  await page.locator("#tree-row-root").click();
  await row("Workbench-000.txt").waitFor();
  console.log(
    "PASS folder moves are reversible and pinned folders navigate directly and unpin",
  );

  // All mutations exercise the visible controls and verify the actual server.
  const original = uploaded[0];
  await rename(original.name, "Workbench renamed.txt");
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    "Workbench renamed.txt",
  );
  await trigger.click();
  await search.pressSequentially("typing");
  await search.press("Control+z");
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    "Workbench renamed.txt",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("link", { name: "Workbench renamed.txt", exact: true })
    .click();
  await page
    .locator(".renametrigger")
    .filter({ hasText: "Workbench renamed.txt" })
    .waitFor();
  await page.locator(".renametrigger").focus();
  await page.keyboard.press("Control+z");
  await page
    .locator(".renametrigger")
    .filter({ hasText: original.name })
    .waitFor();
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    original.name,
  );
  await page.goBack({ waitUntil: "domcontentloaded" });
  await row(original.name).waitFor();
  await rename(original.name, "Workbench retry.txt");
  let failOnce = true;
  await page.route(`**/api/v1/assets/${original.id}`, async (route) => {
    if (route.request().method() === "PATCH" && failOnce) {
      failOnce = false;
      await route.abort();
    } else await route.continue();
  });
  await undo();
  await page
    .getByRole("status")
    .filter({ hasText: "You can retry Undo" })
    .waitFor();
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    "Workbench retry.txt",
  );
  await undo();
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    original.name,
  );
  await page.unroute(`**/api/v1/assets/${original.id}`);
  await rename(original.name, "Workbench conflict.txt");
  await api("PATCH", `/assets/${original.id}`, {
    name: "Workbench collaborator.txt",
  });
  await undo();
  await page
    .getByRole("status")
    .filter({ hasText: "could not be undone safely" })
    .waitFor();
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    "Workbench collaborator.txt",
  );
  await api("PATCH", `/assets/${original.id}`, { name: original.name });
  await library();
  console.log(
    "PASS guarded undo reverses real mutations, retries network failures and preserves concurrent edits",
  );

  await menu(original.name, "Edit tags");
  await page
    .getByRole("dialog")
    .getByLabel("Tags, separated by commas")
    .fill("final, client");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save tags" })
    .click();
  await page.getByRole("status").filter({ hasText: "Updated tags" }).waitFor();
  assert.deepEqual((await api("GET", `/assets/${original.id}`)).tags, [
    "final",
    "client",
  ]);
  await undo();
  assert.deepEqual((await api("GET", `/assets/${original.id}`)).tags, []);
  await api("PATCH", `/assets/${original.id}`, { tags: ["remove-me"] });
  await menu(original.name, "Edit tags");
  await page
    .getByRole("dialog")
    .getByLabel("Tags, separated by commas")
    .fill("");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save tags" })
    .click();
  await page.getByRole("status").filter({ hasText: "Updated tags" }).waitFor();
  assert.deepEqual((await api("GET", `/assets/${original.id}`)).tags, []);
  await undo();
  assert.deepEqual((await api("GET", `/assets/${original.id}`)).tags, [
    "remove-me",
  ]);
  await menu(original.name, "Move to trash");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await row(original.name).waitFor({ state: "detached" });
  assert(
    (await api("GET", `/projects/${project.id}/trash`)).items.some(
      (asset) => asset.id === original.id,
    ),
  );
  await undo();
  await row(original.name).waitFor();
  assert.equal((await api("GET", `/assets/${original.id}`)).deleted_at, null);
  await menu(original.name, "Move to trash");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await row(original.name).waitFor({ state: "detached" });
  await page.locator("#tree-row-trash").click();
  const trashedRow = page
    .locator(".trashlist li")
    .filter({ hasText: original.name });
  await trashedRow
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await trashedRow.waitFor({ state: "detached" });
  assert.equal((await api("GET", `/assets/${original.id}`)).deleted_at, null);
  await undo();
  await trashedRow.waitFor();
  assert(
    (await api("GET", `/projects/${project.id}/trash`)).items.some(
      (asset) => asset.id === original.id,
    ),
  );
  await trashedRow
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await trashedRow.waitFor({ state: "detached" });
  await page.locator("#tree-row-root").click();
  await row(original.name).waitFor();
  console.log(
    "PASS tags, trash and Restore are reversible through the same visible undo control",
  );

  await page.getByRole("button", { name: "List", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select Workbench-000.txt", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Select Workbench-104.txt", exact: true })
    .check();
  await page.getByLabel("Approval status to apply").selectOption("in_review");
  await page.getByRole("button", { name: "Set status", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Changed status: 2 assets" })
    .waitFor();
  await api("PATCH", `/assets/${original.id}`, { status: "changes_requested" });
  await undo();
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).status,
    "changes_requested",
  );
  assert.equal(
    (await api("GET", `/assets/${uploaded[104].id}`)).status,
    "approved",
  );
  await page
    .getByRole("status")
    .filter({ hasText: "1 change undone. 1 could not be undone safely." })
    .waitFor();
  await api("PATCH", `/assets/${original.id}`, { status: "approved" });
  console.log(
    "PASS bulk undo reports partial success and never overwrites a collaborator's status",
  );

  const curated = [uploaded[2], uploaded[0], uploaded[1]];
  const createdShare = (
    await api("POST", "/shares", {
      project_id: project.id,
      title: "Workbench curated order",
      asset_ids: curated.map((asset) => asset.id),
    })
  ).share;
  const shareOrder = async () =>
    (await api("GET", `/shares/${createdShare.id}`)).assets
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((link) => link.asset_id);
  await page.goto(`${base}/projects/${project.id}/shares/${createdShare.id}`, {
    waitUntil: "domcontentloaded",
  });
  const later = page.getByRole("button", {
    name: `Move ${curated[0].name} later`,
    exact: true,
  });
  await page.locator(".contentwrap .content").first().focus();
  await later.waitFor();
  assert.deepEqual(
    await page.locator(".contentname").allTextContents(),
    curated.map((asset) => asset.name),
  );
  await later.click();
  await page
    .getByRole("status")
    .filter({ hasText: "Share order changed" })
    .waitFor();
  assert.deepEqual(await shareOrder(), [
    curated[1].id,
    curated[0].id,
    curated[2].id,
  ]);
  await undo();
  assert.deepEqual(
    await shareOrder(),
    curated.map((asset) => asset.id),
  );
  await page.waitForFunction(
    (names) =>
      JSON.stringify(
        [...document.querySelectorAll(".contentname")].map(
          (element) => element.textContent,
        ),
      ) === JSON.stringify(names),
    curated.map((asset) => asset.name),
  );
  assert.deepEqual(
    await page.locator(".contentname").allTextContents(),
    curated.map((asset) => asset.name),
  );
  await page.locator(".contentwrap .content").first().focus();
  await later.click();
  await page
    .getByRole("status")
    .filter({ hasText: "Share order changed" })
    .waitFor();
  const concurrent = [curated[2].id, curated[1].id, curated[0].id];
  await api("PATCH", `/shares/${createdShare.id}/assets`, {
    asset_ids: concurrent,
    expected_asset_ids: [curated[1].id, curated[0].id, curated[2].id],
  });
  await undo();
  await page
    .getByRole("status")
    .filter({ hasText: "could not be undone safely" })
    .waitFor();
  assert.deepEqual(await shareOrder(), concurrent);
  await page.waitForFunction(
    (names) =>
      JSON.stringify(
        [...document.querySelectorAll(".contentname")].map(
          (element) => element.textContent,
        ),
      ) === JSON.stringify(names),
    [curated[2].name, curated[1].name, curated[0].name],
  );
  assert.deepEqual(await page.locator(".contentname").allTextContents(), [
    curated[2].name,
    curated[1].name,
    curated[0].name,
  ]);
  await library();
  console.log(
    "PASS share reordering preserves curated order, supports undo and respects concurrent changes",
  );

  await filter("Filter by status", "");
  await filter("Filter by kind", "");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await rename("Workbench-000.txt", "Workbench-000-renamed.txt");
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await page
    .getByRole("checkbox", { name: "Select Workbench-104.txt", exact: true })
    .check();
  const before = await page.evaluate(() => window.scrollY);
  assert(
    before > 500,
    "The return-state check starts beyond the first server page, not at the top",
  );
  await page
    .getByRole("link", { name: "Workbench-104.txt", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname.includes("/assets/"));
  const departureScroll = await page.evaluate((id) => {
    const key = Object.keys(localStorage).find((key) =>
      key.endsWith(`.library:${id}`),
    );
    return key ? JSON.parse(localStorage.getItem(key)).value.scroll : null;
  }, project.id);
  assert(
    Math.abs(departureScroll - before) < 20,
    "Navigation snapshots the library scroll before the router resets it",
  );
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("checkbox", { name: "Select Workbench-104.txt", exact: true })
    .waitFor();
  assert(
    await page
      .getByRole("checkbox", { name: "Select Workbench-104.txt", exact: true })
      .isChecked(),
  );
  await page.waitForFunction(
    (scroll) => Math.abs(window.scrollY - scroll) < 20,
    before,
  );
  const refreshedTail = listResponse((params) => Boolean(params.get("cursor")));
  await undo();
  assert(
    (await (await refreshedTail).json()).items.some(
      (asset) => asset.id === uploaded[104].id,
    ),
  );
  assert.equal(
    (await api("GET", `/assets/${original.id}`)).name,
    original.name,
  );
  await page
    .getByText("106 loaded. Sorting and filters apply to the whole library.", {
      exact: true,
    })
    .waitFor();
  assert(
    await page
      .getByRole("checkbox", { name: "Select Workbench-104.txt", exact: true })
      .isChecked(),
  );
  assert(
    Math.abs((await page.evaluate(() => window.scrollY)) - before) < 20,
    "Undo keeps a deep loaded selection in place",
  );
  await api(
    "POST",
    `/projects/${project.id}/uploads/direct?filename=Z-live-arrival.txt`,
    Buffer.from("Live library arrival"),
  );
  await page
    .getByText("107 loaded. Sorting and filters apply to the whole library.", {
      exact: true,
    })
    .waitFor();
  assert(
    await page
      .getByRole("checkbox", { name: "Select Workbench-104.txt", exact: true })
      .isChecked(),
  );
  assert(
    Math.abs((await page.evaluate(() => window.scrollY)) - before) < 20,
    "Live arrivals keep a deep loaded selection in place",
  );
  console.log(
    "PASS review return, undo and live arrivals preserve selection and scroll beyond the first server page",
  );

  await filter("Filter by kind", "image");
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await row(image.asset.name).focus();
  await row(image.asset.name).press("Space");
  await preview.waitFor();
  const previewBackground = await preview.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const channels = previewBackground.match(/\d+/g).slice(0, 3);
  assert.equal(
    new Set(channels).size,
    1,
    "Quick Look's surface is strictly neutral",
  );
  await shot("image-preview");
  await page.keyboard.press("Escape");
  await filter("Filter by kind", "");

  if (process.env.E2E_PROJECT_ID) {
    const fixtures = await api(
      "GET",
      `/projects/${process.env.E2E_PROJECT_ID}/assets?limit=100`,
    );
    const video = fixtures.items.find((asset) => asset.kind === "video");
    assert(
      video,
      "Integration fixture must include a video for frame-state verification",
    );
    await page.goto(`${base}/projects/${process.env.E2E_PROJECT_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByLabel("Saved view").waitFor();
    await row(video.name).focus();
    await row(video.name).press("Space");
    await preview.locator(".player").waitFor();
    await preview
      .getByRole("slider", { name: "Position", exact: true })
      .waitFor();
    assert(
      await preview
        .locator("video")
        .evaluateAll(
          (videos) =>
            videos.length > 0 && videos.every((element) => element.paused),
        ),
    );
    await shot("video-preview");
    await page.setViewportSize({ width: 390, height: 844 });
    const phonePreview = await preview.boundingBox();
    assert(
      phonePreview.x >= 0 &&
        phonePreview.x + phonePreview.width <= 390 &&
        phonePreview.y >= 0 &&
        phonePreview.y + phonePreview.height <= 844,
    );
    await shot("phone-video-preview");
    const closePreview = preview.getByRole("button", {
      name: "Close Quick Look",
      exact: true,
    });
    await closePreview.focus();
    await closePreview.press("Space");
    await preview.waitFor({ state: "detached" });
    assert(
      await row(video.name).evaluate(
        (element) =>
          element === document.activeElement ||
          element.contains(document.activeElement),
      ),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const reviewPath = `/projects/${process.env.E2E_PROJECT_ID}/assets/${video.id}`;
    await page.goto(`${base}${reviewPath}?f=12`, {
      waitUntil: "domcontentloaded",
    });
    const position = page.getByRole("slider", {
      name: "Timeline scrubber",
      exact: true,
    });
    await position.waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"][aria-label="Timeline scrubber"]')
          ?.getAttribute("aria-valuenow") === "12",
    );
    await page.getByRole("button", { name: "Next frame", exact: true }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"][aria-label="Timeline scrubber"]')
          ?.getAttribute("aria-valuenow") === "13",
    );
    const notesWidth = page.getByLabel("Notes panel width");
    await notesWidth.focus();
    await notesWidth.press("Home");
    for (let index = 0; index < 16; index++)
      await notesWidth.press("ArrowRight");
    assert.equal(await notesWidth.inputValue(), "440");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await page.locator(".info-trigger").click();
    await page
      .getByRole("region", { name: "Asset inspector", exact: true })
      .waitFor();
    await page.waitForFunction(
      (id) =>
        Object.keys(localStorage).some((key) => {
          if (!key.startsWith("onelight.workbench.")) return false;
          const remembered = JSON.parse(localStorage.getItem(key))[
            `review:${id}`
          ]?.value;
          return (
            remembered?.frame === 13 &&
            remembered.notes === false &&
            remembered.info === true &&
            remembered.width === 440 &&
            remembered.filter === "open"
          );
        }),
      video.id,
    );
    await page.keyboard.press("Control+k");
    await search.waitFor();
    const background = await palette.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    assert.equal(
      new Set(background.match(/\d+/g).slice(0, 3)).size,
      1,
      "Review palette stays neutral",
    );
    await search.pressSequentially("j k l ");
    await search.press("ArrowRight");
    assert.equal(await position.getAttribute("aria-valuenow"), "13");
    assert(
      await page
        .locator("video")
        .evaluateAll((videos) => videos.every((element) => element.paused)),
    );
    await shot("review-palette");
    await page.keyboard.press("Escape");
    await library();
    await page.goto(`${base}${reviewPath}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"][aria-label="Timeline scrubber"]')
          ?.getAttribute("aria-valuenow") === "13",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Focus", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page
      .getByRole("region", { name: "Asset inspector", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    assert.equal(await notesWidth.inputValue(), "440");
    assert.equal(
      await page
        .getByRole("button", { name: "Open", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.goto(`${base}${reviewPath}?f=5`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="slider"][aria-label="Timeline scrubber"]')
          ?.getAttribute("aria-valuenow") === "5",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    if (!(await page.locator(".info-panel").isVisible()))
      await page.locator(".info-trigger").click();
    await page
      .getByRole("region", { name: "Asset inspector", exact: true })
      .waitFor();
    const phoneInfo = await page.locator(".info-panel").boundingBox();
    assert(
      phoneInfo.x >= 0 &&
        phoneInfo.x + phoneInfo.width <= 390 &&
        phoneInfo.y + phoneInfo.height <= 844,
      "Review inspector fits a phone",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await shot("phone-review-inspector");
    await page.setViewportSize({ width: 390, height: 320 });
    const shortInfo = await page.locator(".info-panel").boundingBox();
    assert(
      shortInfo.x >= 0 &&
        shortInfo.x + shortInfo.width <= 390 &&
        shortInfo.y + shortInfo.height <= 320,
      "Review inspector fits a short landscape viewport",
    );
    await shot("short-review-inspector");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await library();
    console.log(
      "PASS review remembers integer frame and panel arrangement, honors explicit URLs, and isolates modal shortcuts",
    );
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page
    .getByRole("button", { name: "Open command palette", exact: true })
    .click();
  await search.waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const paletteRect = await palette.boundingBox();
  assert(paletteRect.x >= 0 && paletteRect.x + paletteRect.width <= 390);
  await shot("phone-palette");
  await page.keyboard.press("Escape");
  await shot("phone-library");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await inspector.waitFor();
  const phoneInspector = await inspector.boundingBox();
  assert(
    phoneInspector.x >= 0 && phoneInspector.x + phoneInspector.width <= 390,
    "Library inspector fits a phone",
  );
  await shot("phone-library-inspector");
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  console.log(
    "PASS phone library and keyboard-accessible palette stay inside the viewport",
  );

  // Same browser storage, genuinely different authenticated account.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const inviteEmail = `workbench-${stamp}@example.test`;
  const invited = await api("POST", "/invites", {
    email: inviteEmail,
    role: "member",
  });
  const inviteUrl = new URL(invited.accept_url);
  const token =
    inviteUrl.searchParams.get("token") ?? inviteUrl.pathname.split("/").at(-1);
  const other = await browser.newContext();
  try {
    secondUser = (
      await api(
        "POST",
        "/invites/accept",
        {
          token,
          name: "Workbench reviewer",
          password: "Workbench-test-password-2026!",
        },
        other,
      )
    ).user;
  } finally {
    await other.close();
  }
  await api("POST", "/auth/logout");
  await login(inviteEmail, "Workbench-test-password-2026!");
  await library();
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Approved working view" })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("complementary", { name: "Recent action" }).count(),
    0,
  );
  await page.getByText("Display options", { exact: true }).click();
  assert.equal(
    await page.getByLabel("Information density").inputValue(),
    "comfortable",
  );
  await page.getByText("Display options", { exact: true }).click();
  await api("POST", "/auth/logout");
  await login();
  await library();
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Approved working view" })
      .count(),
    1,
  );
  await page
    .getByLabel("Saved view")
    .selectOption({ label: "Approved working view" });
  await page.getByRole("button", { name: "Delete view", exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Saved view")
      .locator("option", { hasText: "Approved working view" })
      .count(),
    0,
  );
  console.log(
    "PASS saved working preferences stay private per account and saved views can be deleted",
  );

  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log("PASS workbench has no uncaught browser errors");
} catch (caught) {
  await shot("failure").catch(() => {});
  console.error("Browser errors:", errors);
  console.error(
    "Failure state:",
    await page
      .evaluate(() => ({
        path: location.pathname,
        scroll: window.scrollY,
        loaded: document.querySelector(".loaded-count")?.textContent,
        workbench: Object.fromEntries(
          Object.keys(localStorage)
            .filter((key) => key.startsWith("onelight.workbench."))
            .map((key) => [key, JSON.parse(localStorage.getItem(key))]),
        ),
      }))
      .catch(() => null),
  );
  throw caught;
} finally {
  try {
    // Cleanup must work even when the failure happened after switching users.
    const session = await context.request.get(`${base}/api/v1/auth/session`);
    if (!session.ok() || (await session.json()).user.email !== email)
      await api("POST", "/auth/login", { email, password });
    if (secondUser) await api("DELETE", `/users/${secondUser.id}`);
    if (project) await api("DELETE", `/projects/${project.id}`);
  } finally {
    await browser.close();
  }
}
