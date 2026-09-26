import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (body) =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { check, finish } from ${JSON.stringify(new URL("./lib.mjs", import.meta.url).href)};
       const browser = { close: async () => {} };
       ${body}`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );

test("browser cleanup preserves errors and rejects empty or failed runs", () => {
  const thrown = run(`
    try {
      check("initial check", true);
      throw new Error("navigation failed");
    } finally {
      await finish(browser);
    }
  `);
  assert.equal(thrown.status, 1);
  assert.match(thrown.stderr, /navigation failed/);
  assert.equal(run("await finish(browser)").status, 1);
  assert.equal(run('check("failed", false); await finish(browser)').status, 1);
  assert.equal(run('check("passed", true); await finish(browser)').status, 0);
  assert.equal(
    run('process.exitCode = 2; check("passed", true); await finish(browser)')
      .status,
    2,
  );
});
