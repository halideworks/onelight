/* Run against a disposable instance. Exercises real account and transfer
   flows without needing transcoded media or an existing project. */
import assert from "node:assert/strict";
import { firefox } from "playwright";

const base = process.env.BASE_URL;
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
assert(base && email && password, "Set BASE_URL, E2E_EMAIL and E2E_PASSWORD.");
const browser = await firefox.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
context.setDefaultTimeout(15_000);
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
let project;
let originalName;

try {
  await page.goto(`${base}/settings/profile`);
  await page.waitForURL(
    (url) =>
      url.pathname === "/login" &&
      url.searchParams.get("next") === "/settings/profile",
  );
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await Promise.all([
    page.waitForURL("**/settings/profile"),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  console.log("PASS sign-in restores the requested page");
  const inlineRan = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__auditInlineRan = true";
    document.body.append(script);
    return window.__auditInlineRan === true;
  });
  assert.equal(inlineRan, false);
  console.log(
    "PASS CSP allows the app bootstrap and blocks injected inline scripts",
  );

  originalName = (await api("GET", "/users/me")).name;
  await page.locator(".nametext").click();
  await page.getByLabel("Your name").fill("Élodie Audit");
  await page.getByLabel("Your name").press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".nametext")?.textContent === "Élodie Audit",
  );
  assert.equal((await api("GET", "/users/me")).name, "Élodie Audit");
  const avatar = page.locator(".facecol .avatar.gen");
  await avatar.waitFor();
  assert.equal(await avatar.textContent(), "É");
  const color = await avatar.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  await page.reload();
  await avatar.waitFor();
  assert.equal(await avatar.textContent(), "É");
  assert.equal(
    await avatar.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    ),
    color,
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.E2E_SCREENSHOTS}/profile.png`,
    });
  console.log("PASS profile saves, avatar survives reload, phone layout fits");

  project = await api("POST", "/projects", { name: "Account E2E" });
  const uploaded = await api(
    "POST",
    `/projects/${project.id}/uploads/direct?filename=audit.txt`,
    Buffer.from("Disposable email dialog fixture"),
  );
  const { share } = await api("POST", "/shares", {
    project_id: project.id,
    asset_ids: [uploaded.asset.id],
    title: "Audit review",
    passphrase: "dialog-e2e-passphrase",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/projects/${project.id}`);
  await page.locator(`#tree-row-${share.id}`).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Send by email/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Send Audit review by email",
  });
  await dialog.waitFor();
  await dialog
    .getByText("This share has a password.", { exact: false })
    .waitFor();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    assert(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    );
  }
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.E2E_SCREENSHOTS}/email-dialog.png`,
    });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log(
    "PASS email dialog shows current share policy and traps keyboard focus",
  );
  const { transfer } = await api("POST", "/transfers", {
    project_id: project.id,
    kind: "request",
    title: "Send your files",
    passphrase: "account-e2e-passphrase",
  });
  const guest = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  guest.setDefaultTimeout(15_000);
  const portal = await guest.newPage();
  await portal.goto(`${base}/t/${transfer.slug}`);
  await portal
    .locator("input:not([type=password]):not([type=file])")
    .fill("Client");
  await portal.locator("input[type=password]").fill("wrong-passphrase");
  const refused = portal.waitForResponse(
    (response) =>
      response.url().endsWith("/access") && response.status() === 401,
  );
  await portal.locator("button[type=submit]").click();
  await refused;
  await portal.locator('[role="alert"]').waitFor();
  assert.equal(new URL(portal.url()).pathname, `/t/${transfer.slug}`);
  await portal.locator("input[type=password]").fill("account-e2e-passphrase");
  const accepted = portal.waitForResponse(
    (response) =>
      response.url().endsWith("/access") && response.status() === 200,
  );
  await portal.locator("button[type=submit]").click();
  await accepted;
  await portal.locator("input[type=file]").waitFor({ state: "attached" });
  const delivered = Buffer.from("Browser transfer receipt fixture");
  await portal.getByRole("button", { name: "Choose files" }).waitFor();
  await portal.locator("input[type=file]").setInputFiles({
    name: "receipt.txt",
    mimeType: "text/plain",
    buffer: delivered,
  });
  await portal.getByText("Received", { exact: true }).waitFor();
  const receipt = await guest.request.get(`${base}/api/v1/t/${transfer.slug}`);
  assert.equal(
    (await receipt.json()).transfer.received_bytes,
    delivered.length,
  );
  const csrf = await guest.request.post(
    `${base}/api/v1/t/${transfer.slug}/access`,
    {
      headers: {
        origin: "https://untrusted.example",
        authorization: "Bearer invalid",
      },
      data: { name: "Intruder", passphrase: "account-e2e-passphrase" },
    },
  );
  assert.equal(csrf.status(), 403);
  if (process.env.E2E_SCREENSHOTS)
    await portal.screenshot({
      path: `${process.env.E2E_SCREENSHOTS}/transfer.png`,
    });
  console.log(
    "PASS transfer error, recovery, real upload receipt and cookie CSRF protection",
  );

  await portal.goto(`${base}/login`);
  await portal.getByRole("button", { name: "Forgot password" }).click();
  await portal.getByLabel("Email for the reset link").fill(email);
  await portal.route("**/api/v1/auth/reset-request", (route) => route.abort());
  await portal.getByRole("button", { name: "Send reset link" }).click();
  await portal.locator('[role="alert"]').waitFor();
  assert.equal(await portal.locator(".reset-note").count(), 0);
  console.log("PASS failed reset requests do not claim mail was sent");
  await guest.close();
} finally {
  try {
    if (originalName) await api("PATCH", "/users/me", { name: originalName });
    if (project) await api("DELETE", `/projects/${project.id}`);
  } finally {
    await browser.close();
  }
}
