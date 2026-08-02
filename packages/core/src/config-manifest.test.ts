import { describe, expect, it } from "vitest";
import {
  CONFIG_GROUPS,
  CONFIG_VARS,
  SUBSYSTEM_ORDER,
  varsForScope,
} from "./config-manifest.js";
import {
  effectiveConfig,
  parseConfigValue,
  parseScope,
} from "./config-report.js";
import { loadConfig, loadWorkerConfig } from "./config.js";

const base = {
  PUBLIC_URL: "http://localhost:3000",
  SECRET_KEY: "0123456789abcdef0123456789abcdef",
};

describe("the manifest itself", () => {
  it("declares every variable exactly once, in a known subsystem", () => {
    const names = CONFIG_VARS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of CONFIG_VARS) {
      expect(SUBSYSTEM_ORDER).toContain(entry.subsystem);
      expect(entry.scope.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it("gives every group real members", () => {
    for (const group of CONFIG_GROUPS)
      for (const member of group.members)
        expect(CONFIG_VARS.some((entry) => entry.name === member)).toBe(true);
  });

  /* A manifest entry that says "omit" without saying why is how a variable
     quietly stops being passed. */
  it("explains every deliberate omission from compose", () => {
    for (const entry of CONFIG_VARS)
      if (entry.compose === "omit") expect(entry.composeNote).toBeTruthy();
  });

  it("keeps the settings an operator sets in the server scope", () => {
    const server = varsForScope("server").map((entry) => entry.name);
    for (const name of [
      "OIDC_ISSUER",
      "ONELIGHT_ADMIN_EMAIL",
      "BACKUP_DIR",
      "TRASH_PURGE_AFTER_MS",
      "WORKER_JOB_TIMEOUT_MS",
    ])
      expect(server).toContain(name);
  });
});

describe("strict parsing", () => {
  const entry = (name: string) =>
    CONFIG_VARS.find((item) => item.name === name) as (typeof CONFIG_VARS)[0];

  it("refuses a number it cannot honour instead of defaulting", () => {
    expect(parseConfigValue(entry("BACKUP_KEEP"), "oops")).toHaveProperty(
      "issue",
    );
    expect(parseConfigValue(entry("BACKUP_KEEP"), "-3")).toHaveProperty(
      "issue",
    );
    expect(parseConfigValue(entry("BACKUP_KEEP"), "1.5")).toHaveProperty(
      "issue",
    );
    expect(parseConfigValue(entry("BACKUP_KEEP"), "9")).toEqual({ value: 9 });
  });

  it("treats empty as unset, because compose passes empty for unset", () => {
    expect(parseConfigValue(entry("BACKUP_DIR"), "")).toEqual({
      value: undefined,
    });
    expect(parseConfigValue(entry("ONELIGHT_HWACCEL"), "")).toEqual({
      value: "auto",
    });
  });

  it("rejects an unknown enum value", () => {
    expect(
      parseConfigValue(entry("ONELIGHT_HWACCEL"), "quicksync"),
    ).toHaveProperty("issue");
    expect(parseConfigValue(entry("ONELIGHT_HWACCEL"), "nvenc")).toEqual({
      value: "nvenc",
    });
  });
});

describe("mutually dependent settings", () => {
  it("fails startup when a group is half set", () => {
    expect(() =>
      loadConfig({ ...base, OIDC_ISSUER: "https://id.test" }),
    ).toThrow(/must be set together/);
    expect(() =>
      loadConfig({ ...base, ONELIGHT_ADMIN_EMAIL: "a@example.com" }),
    ).toThrow(/must be set together/);
    expect(() =>
      loadConfig({ ...base, WORKER_URL: "http://worker:8080" }),
    ).toThrow(/must be set together/);
  });

  it("fails startup when backup knobs are set without a directory", () => {
    expect(() => loadConfig({ ...base, BACKUP_INTERVAL_MS: "60000" })).toThrow(
      /BACKUP_DIR/,
    );
  });

  it("accepts a complete group", () => {
    const config = loadConfig({
      ...base,
      OIDC_ISSUER: "https://id.test",
      OIDC_CLIENT_ID: "onelight",
      OIDC_CLIENT_SECRET: "shh",
      BACKUP_DIR: "/data/backups",
      BACKUP_KEEP: "7",
      WORKER_URL: "http://worker:8080",
      WORKER_SECRET: "worker-secret",
    });
    expect(config.OIDC_ISSUER).toBe("https://id.test");
    expect(config.backupDir).toBe("/data/backups");
    expect(config.backupKeep).toBe(7);
  });

  /* Mail reports rather than refusing to boot: a typo in a notification
     transport must not take the whole server down. */
  it("does not fail startup over incomplete mail settings", () => {
    expect(() =>
      loadConfig({ ...base, SMTP_HOST: "mail.example.com" }),
    ).not.toThrow();
    const report = effectiveConfig(
      { ...base, SMTP_HOST: "mail.example.com" },
      "server",
    );
    const mail = report.subsystems.find((item) => item.name === "mail");
    expect(mail?.active).toBe(false);
    expect(mail?.detail).toMatch(/MAIL_FROM/);
  });
});

describe("mail never stops the server", () => {
  /* Every other malformed value is fatal. Mail is not: stored admin settings
     may be in use instead of the environment, and a typo in a notification
     transport must not take a review platform offline. */
  it("reports a malformed mail value instead of refusing to boot", () => {
    expect(() => loadConfig({ ...base, SMTP_PORT: "oops" })).not.toThrow();
    expect(() => loadConfig({ ...base, SMTP_SECURE: "garbage" })).not.toThrow();
    const parsed = parseScope({ ...base, SMTP_PORT: "oops" }, "server");
    expect(parsed.issues).toEqual([]);
    expect(parsed.reported.map((issue) => issue.name)).toContain("SMTP_PORT");
  });

  /* But it must not then read as working. A complete-looking mail group with
     one unparseable value is a transport that sends nothing. */
  it("reports mail as off when a value it needs cannot be parsed", () => {
    const report = effectiveConfig(
      {
        ...base,
        SMTP_HOST: "mail.example.com",
        MAIL_FROM: "Onelight <onelight@example.com>",
        SMTP_PORT: "oops",
      },
      "server",
    );
    const mail = report.subsystems.find((item) => item.name === "mail");
    expect(mail?.active).toBe(false);
    expect(mail?.detail).toMatch(/SMTP_PORT/);
  });

  it("still refuses a malformed value anywhere else", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "garbage" })).toThrow();
    expect(() =>
      loadConfig({ ...base, BACKUP_DIR: "/b", BACKUP_KEEP: "x" }),
    ).toThrow();
  });
});

describe("the worker parses the same manifest", () => {
  it("reads a boolean by its declared type, not by one magic string", () => {
    /* "false" used to leave the software AV1 encode ON, because the old reader
       only recognised the exact string "0". */
    expect(loadWorkerConfig({}).ONELIGHT_SOFTWARE_AV1).toBe(true);
    expect(
      loadWorkerConfig({ ONELIGHT_SOFTWARE_AV1: "false" })
        .ONELIGHT_SOFTWARE_AV1,
    ).toBe(false);
    expect(
      loadWorkerConfig({ ONELIGHT_SOFTWARE_AV1: "0" }).ONELIGHT_SOFTWARE_AV1,
    ).toBe(false);
  });

  it("refuses a malformed worker value instead of guessing", () => {
    /* This one silently read as ON before: anything outside a deny list was
       treated as true. */
    expect(() =>
      loadWorkerConfig({ ONELIGHT_VAAPI_LOW_POWER: "garbage" }),
    ).toThrow(/ONELIGHT_VAAPI_LOW_POWER/);
    expect(() => loadWorkerConfig({ ONELIGHT_HWACCEL: "quicksync" })).toThrow(
      /ONELIGHT_HWACCEL/,
    );
  });

  /* The stock compose stack gives the worker WORKER_SECRET and no WORKER_URL,
     because only the server dials the worker. Judging that pair in worker
     scope made every default deployment fail to start. */
  it("starts on exactly what the stock compose stack passes it", () => {
    expect(() =>
      loadWorkerConfig({
        PORT: "8080",
        WORKER_SECRET: "worker-secret",
        ONELIGHT_HWACCEL: "",
        ONELIGHT_VAAPI_DEVICE: "",
        ONELIGHT_VAAPI_LOW_POWER: "",
        ONELIGHT_NVENC_DEVICE: "",
        ONELIGHT_SOFTWARE_AV1: "",
      }),
    ).not.toThrow();
  });

  /* A worker configured this way months ago must keep starting. */
  it("still accepts none as the software alias", () => {
    expect(
      loadWorkerConfig({ ONELIGHT_HWACCEL: "none" }).ONELIGHT_HWACCEL,
    ).toBe("none");
  });

  it("applies the documented defaults", () => {
    const config = loadWorkerConfig({});
    /* The worker's own default, not the server's: one name, two containers. */
    expect(config.PORT).toBe(8080);
    expect(config.WORK_ROOT).toBe("/data/work");
    expect(config.ONELIGHT_HWACCEL).toBe("auto");
    expect(config.ONELIGHT_VAAPI_LOW_POWER).toBe(true);
    expect(config.FFMPEG_PATH).toBe("ffmpeg");
  });
});

describe("the effective configuration report", () => {
  it("says which subsystems are on and what is missing", () => {
    const report = effectiveConfig(base, "server");
    const oidc = report.subsystems.find((item) => item.name === "oidc");
    expect(oidc?.active).toBe(false);
    expect(oidc?.detail).toMatch(/OIDC_ISSUER/);
    const backups = report.subsystems.find((item) => item.name === "backups");
    expect(backups?.active).toBe(false);

    const on = effectiveConfig(
      {
        ...base,
        OIDC_ISSUER: "https://id.test",
        OIDC_CLIENT_ID: "onelight",
        OIDC_CLIENT_SECRET: "shh",
      },
      "server",
    );
    expect(on.subsystems.find((item) => item.name === "oidc")?.active).toBe(
      true,
    );
  });

  it("never renders a secret, only whether it is set", () => {
    const report = effectiveConfig(
      { ...base, OIDC_CLIENT_SECRET: "super-secret-value" },
      "server",
    );
    const flat = report.subsystems.flatMap((item) => item.vars);
    const secret = flat.find((item) => item.name === "OIDC_CLIENT_SECRET");
    expect(secret?.set).toBe(true);
    expect(secret?.value).toBeNull();
    expect(JSON.stringify(report)).not.toContain("super-secret-value");
    /* And the session key is never in there either. */
    expect(JSON.stringify(report)).not.toContain(base.SECRET_KEY);
  });

  it("distinguishes a set value from a default", () => {
    const report = effectiveConfig({ ...base, BACKUP_KEEP: "9" }, "server");
    const flat = report.subsystems.flatMap((item) => item.vars);
    expect(flat.find((item) => item.name === "BACKUP_KEEP")).toMatchObject({
      set: true,
      source: "environment",
      value: "9",
    });
    expect(
      flat.find((item) => item.name === "TRASH_PURGE_AFTER_MS"),
    ).toMatchObject({ set: false, source: "default" });
  });

  it("reports a value it cannot honour against the variable", () => {
    const report = effectiveConfig({ ...base, BACKUP_KEEP: "oops" }, "server");
    const flat = report.subsystems.flatMap((item) => item.vars);
    expect(flat.find((item) => item.name === "BACKUP_KEEP")?.issue).toMatch(
      /whole number/,
    );
  });
});
