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

  /* The planner has always lowercased this, so an uppercase spelling is a
     deployment that has been working and must keep working. */
  it("accepts an enum in any case and normalises it", () => {
    expect(parseConfigValue(entry("ONELIGHT_HWACCEL"), "VAAPI")).toEqual({
      value: "vaapi",
    });
    expect(parseConfigValue(entry("ONELIGHT_HWACCEL"), "NvEnc")).toEqual({
      value: "nvenc",
    });
    expect(
      loadWorkerConfig({ ...workerBase, ONELIGHT_HWACCEL: "VAAPI" })
        .ONELIGHT_HWACCEL,
    ).toBe("vaapi");
  });

  /* The worker's hardware flags went through a reader that treated these as
     false, so a worker set that way is running somewhere right now. */
  it("keeps the worker's no and off spellings working", () => {
    for (const value of ["no", "off", "NO", "Off"])
      expect(
        loadWorkerConfig({ ...workerBase, ONELIGHT_VAAPI_LOW_POWER: value })
          .ONELIGHT_VAAPI_LOW_POWER,
        value,
      ).toBe(false);
    for (const value of ["yes", "on"])
      expect(
        loadWorkerConfig({ ...workerBase, ONELIGHT_VAAPI_LOW_POWER: value })
          .ONELIGHT_VAAPI_LOW_POWER,
        value,
      ).toBe(true);
  });

  /* But the server's booleans stay strict: "yes" reading as true under an
     older parser is the surprise this manifest exists to end. */
  it("does not grant those spellings to the server's booleans", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "off" })).toThrow();
    expect(() => loadConfig({ ...base, TRUST_PROXY: "yes" })).toThrow();
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

/* Every worker parses against the same required pair; these tests are about
   one variable at a time, so they start from a worker that is otherwise
   completely configured. */
const workerBase = {
  ONELIGHT_SERVER_URL: "http://onelight:3000",
  WORKER_SECRET: "worker-secret",
};

describe("mutually dependent settings", () => {
  it("fails startup when a group is half set", () => {
    expect(() =>
      loadConfig({ ...base, OIDC_ISSUER: "https://id.test" }),
    ).toThrow(/must be set together/);
    expect(() =>
      loadConfig({ ...base, ONELIGHT_ADMIN_EMAIL: "a@example.com" }),
    ).toThrow(/must be set together/);
    /* The worker pair is judged in worker scope now: the server holds only
       the secret, and it is the worker that needs a server URL to go with
       it. */
    expect(() =>
      loadWorkerConfig({ ONELIGHT_SERVER_URL: "http://onelight:3000" }),
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

describe("credentials keep the bytes the operator set", () => {
  /* Trimming a secret invalidates every live session on upgrade, or fails
     against a provider whose client secret has not changed. */
  it("does not trim a secret while validating it", () => {
    const key = "  0123456789abcdef0123456789abcdef  ";
    expect(loadConfig({ ...base, SECRET_KEY: key }).SECRET_KEY).toBe(key);
    expect(
      loadConfig({
        ...base,
        OIDC_ISSUER: "https://id.test",
        OIDC_CLIENT_ID: "x",
        OIDC_CLIENT_SECRET: " shh ",
      }).OIDC_CLIENT_SECRET,
    ).toBe(" shh ");
  });

  it("still trims a path, where whitespace is a typo and not a value", () => {
    expect(
      loadConfig({ ...base, BACKUP_DIR: " /data/backups " }).backupDir,
    ).toBe("/data/backups");
  });

  /* Whitespace alone is still nothing at all. */
  it("treats an all-whitespace value as unset", () => {
    expect(
      loadConfig({ ...base, BACKUP_DIR: "   " }).backupDir,
    ).toBeUndefined();
  });
});

describe("tools that borrow the parser", () => {
  /* pnpm seed generates a password when only the address is given, and uses
     demo@onelight.local when only the password is. Both are supported ways to
     run it, and the server's first-run pairing rule must not break them. */
  it("lets seed set one half of the admin pair", () => {
    expect(() =>
      loadConfig(
        { ...base, ONELIGHT_ADMIN_EMAIL: "a@example.com" },
        { startup: false },
      ),
    ).not.toThrow();
    expect(() =>
      loadConfig(
        { ...base, ONELIGHT_ADMIN_PASSWORD: "long-enough" },
        { startup: false },
      ),
    ).not.toThrow();
  });

  it("still holds the server to the pair", () => {
    expect(() =>
      loadConfig({ ...base, ONELIGHT_ADMIN_EMAIL: "a@example.com" }),
    ).toThrow(/must be set together/);
  });

  /* Only the startup-only rules relax: a group that is wrong in any context
     is still wrong here. */
  it("keeps every other group in force", () => {
    expect(() =>
      loadConfig(
        { ...base, OIDC_ISSUER: "https://id.test" },
        { startup: false },
      ),
    ).toThrow(/must be set together/);
  });
});

describe("mail state comes from the transport parser", () => {
  const mailState = (env: Record<string, string>) =>
    effectiveConfig({ ...base, ...env }, "server").subsystems.find(
      (item) => item.name === "mail",
    );

  /* These satisfy every rule the manifest can express and are still refused
     by parseSmtpConfig, so the report has to ask it rather than guess. */
  it("reports a user without a password as off", () => {
    const mail = mailState({
      SMTP_HOST: "mail.example.com",
      MAIL_FROM: "Onelight <onelight@example.com>",
      SMTP_USER: "onelight",
    });
    expect(mail?.active).toBe(false);
    expect(mail?.detail).toMatch(/SMTP_USER and SMTP_PASS/);
  });

  it("reports a non-SMTP url as off", () => {
    const mail = mailState({
      SMTP_URL: "https://mail.example.com",
      MAIL_FROM: "Onelight <onelight@example.com>",
    });
    expect(mail?.active).toBe(false);
    expect(mail?.detail).toMatch(/smtp:\/\//);
  });

  it("reports a usable transport as on", () => {
    expect(
      mailState({
        SMTP_HOST: "mail.example.com",
        MAIL_FROM: "Onelight <onelight@example.com>",
      })?.active,
    ).toBe(true);
    expect(
      mailState({
        SMTP_URL: "smtp://user:pass@mail.example.com:587",
        MAIL_FROM: "Onelight <onelight@example.com>",
      })?.active,
    ).toBe(true);
  });
});

describe("the worker parses the same manifest", () => {
  it("reads a boolean by its declared type, not by one magic string", () => {
    /* "false" used to leave the software AV1 encode ON, because the old reader
       only recognised the exact string "0". */
    expect(loadWorkerConfig(workerBase).ONELIGHT_SOFTWARE_AV1).toBe(true);
    expect(
      loadWorkerConfig({ ...workerBase, ONELIGHT_SOFTWARE_AV1: "false" })
        .ONELIGHT_SOFTWARE_AV1,
    ).toBe(false);
    expect(
      loadWorkerConfig({ ...workerBase, ONELIGHT_SOFTWARE_AV1: "0" })
        .ONELIGHT_SOFTWARE_AV1,
    ).toBe(false);
  });

  it("refuses a malformed worker value instead of guessing", () => {
    /* This one silently read as ON before: anything outside a deny list was
       treated as true. */
    expect(() =>
      loadWorkerConfig({ ...workerBase, ONELIGHT_VAAPI_LOW_POWER: "garbage" }),
    ).toThrow(/ONELIGHT_VAAPI_LOW_POWER/);
    expect(() =>
      loadWorkerConfig({ ...workerBase, ONELIGHT_HWACCEL: "quicksync" }),
    ).toThrow(/ONELIGHT_HWACCEL/);
  });

  /* Workers pull, so the pair the worker needs is its server URL and the
     secret it signs a claim with. The stock compose stack passes both, and
     empty strings for everything the operator left alone. */
  it("starts on exactly what the stock compose stack passes it", () => {
    expect(() =>
      loadWorkerConfig({
        PORT: "8080",
        ONELIGHT_SERVER_URL: "http://onelight:3000",
        WORKER_SECRET: "worker-secret",
        MEDIA_CONCURRENCY: "",
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
      loadWorkerConfig({ ...workerBase, ONELIGHT_HWACCEL: "none" })
        .ONELIGHT_HWACCEL,
    ).toBe("none");
  });

  it("applies the documented defaults", () => {
    const config = loadWorkerConfig(workerBase);
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

  /* A page that answers "what is in force" must not answer "not set" for a
     value the server computed and is actively using. */
  it("reports a derived value as in force, not as unset", () => {
    const report = effectiveConfig(
      { ...base, PUBLIC_URL: "https://review.example.com" },
      "server",
      {
        COOKIE_SECURE: "true",
        BLOB_ROOT: "/data/blobs",
        MEDIA_CONCURRENCY: "2",
      },
    );
    const flat = report.subsystems.flatMap((item) => item.vars);
    expect(flat.find((item) => item.name === "COOKIE_SECURE")).toMatchObject({
      set: false,
      source: "derived",
      value: "true",
    });
    expect(flat.find((item) => item.name === "BLOB_ROOT")).toMatchObject({
      source: "derived",
      value: "/data/blobs",
    });
  });

  /* But a value the operator set is theirs, not the runtime's. */
  it("prefers the configured value over a derived one", () => {
    const report = effectiveConfig(
      { ...base, COOKIE_SECURE: "false" },
      "server",
      {
        COOKIE_SECURE: "true",
      },
    );
    const flat = report.subsystems.flatMap((item) => item.vars);
    expect(flat.find((item) => item.name === "COOKIE_SECURE")).toMatchObject({
      set: true,
      source: "environment",
      value: "false",
    });
  });

  it("reports a value it cannot honour against the variable", () => {
    const report = effectiveConfig({ ...base, BACKUP_KEEP: "oops" }, "server");
    const flat = report.subsystems.flatMap((item) => item.vars);
    expect(flat.find((item) => item.name === "BACKUP_KEEP")?.issue).toMatch(
      /whole number/,
    );
  });
});
