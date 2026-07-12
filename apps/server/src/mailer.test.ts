import { describe, expect, it } from "vitest";
import { isSmtpConfigError, parseSmtpConfig } from "./mailer.js";

describe("parseSmtpConfig", () => {
  it("returns null when no SMTP transport is configured", () => {
    expect(parseSmtpConfig({})).toBeNull();
    expect(parseSmtpConfig({ MAIL_FROM: "onelight@example.com" })).toBeNull();
    expect(parseSmtpConfig({ SMTP_URL: "", SMTP_HOST: "  " })).toBeNull();
  });

  it("requires MAIL_FROM once a transport is configured", () => {
    const result = parseSmtpConfig({ SMTP_URL: "smtp://mail.example.com:587" });
    expect(result).not.toBeNull();
    expect(isSmtpConfigError(result as never)).toBe(true);
  });

  it("parses the URL form", () => {
    const result = parseSmtpConfig({
      SMTP_URL: "smtps://user:pass@mail.example.com:465",
      MAIL_FROM: "Onelight <onelight@example.com>",
    });
    expect(result).toEqual({
      kind: "url",
      url: "smtps://user:pass@mail.example.com:465",
      from: "Onelight <onelight@example.com>",
    });
  });

  it("rejects a URL with the wrong scheme", () => {
    const result = parseSmtpConfig({
      SMTP_URL: "http://mail.example.com",
      MAIL_FROM: "onelight@example.com",
    });
    expect(isSmtpConfigError(result as never)).toBe(true);
  });

  it("prefers SMTP_URL over discrete settings", () => {
    const result = parseSmtpConfig({
      SMTP_URL: "smtp://mail.example.com",
      SMTP_HOST: "other.example.com",
      MAIL_FROM: "onelight@example.com",
    });
    expect(result).toMatchObject({ kind: "url" });
  });

  it("parses discrete settings with defaults", () => {
    const result = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      MAIL_FROM: "onelight@example.com",
    });
    expect(result).toEqual({
      kind: "options",
      host: "mail.example.com",
      port: 587,
      secure: false,
      auth: null,
      from: "onelight@example.com",
    });
  });

  it("defaults secure to true on port 465", () => {
    const result = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_PORT: "465",
      MAIL_FROM: "onelight@example.com",
    });
    expect(result).toMatchObject({ port: 465, secure: true });
  });

  it("honors an explicit SMTP_SECURE over the port convention", () => {
    const off = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "false",
      MAIL_FROM: "onelight@example.com",
    });
    expect(off).toMatchObject({ secure: false });
    const on = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_PORT: "587",
      SMTP_SECURE: "1",
      MAIL_FROM: "onelight@example.com",
    });
    expect(on).toMatchObject({ secure: true });
  });

  it("rejects a malformed SMTP_SECURE", () => {
    const result = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_SECURE: "yes",
      MAIL_FROM: "onelight@example.com",
    });
    expect(isSmtpConfigError(result as never)).toBe(true);
  });

  it("rejects an out-of-range port", () => {
    const result = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_PORT: "70000",
      MAIL_FROM: "onelight@example.com",
    });
    expect(isSmtpConfigError(result as never)).toBe(true);
  });

  it("carries credentials only when both are present", () => {
    const both = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_USER: "mailer",
      SMTP_PASS: "hunter22",
      MAIL_FROM: "onelight@example.com",
    });
    expect(both).toMatchObject({ auth: { user: "mailer", pass: "hunter22" } });
    const half = parseSmtpConfig({
      SMTP_HOST: "mail.example.com",
      SMTP_USER: "mailer",
      MAIL_FROM: "onelight@example.com",
    });
    expect(isSmtpConfigError(half as never)).toBe(true);
  });
});
