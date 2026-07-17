/* SMTP configuration parsing, shared by every place that accepts mail
   settings: the Node server reading its environment, and the API validating
   what an administrator types into the settings page. One parser, one set of
   error messages, both legs. */

export interface MailSettingsInput {
  SMTP_URL?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: string | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASS?: string | undefined;
  SMTP_SECURE?: string | undefined;
  MAIL_FROM?: string | undefined;
}

export type SmtpConfig =
  | { kind: "url"; url: string; from: string }
  | {
      kind: "options";
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string } | null;
      from: string;
    };

export interface SmtpConfigError {
  error: string;
}

export const isSmtpConfigError = (
  value: SmtpConfig | SmtpConfigError,
): value is SmtpConfigError => "error" in value;

/**
 * Parse SMTP settings. Returns null when no transport is configured at all
 * (email disabled), an error object when the configuration is present but
 * unusable, and a config otherwise.
 *
 * Accepted forms: SMTP_URL (smtp://user:pass@host:port or smtps://...) or
 * discrete SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_SECURE. MAIL_FROM
 * is required with either form.
 */
export const parseSmtpConfig = (
  env: MailSettingsInput,
): SmtpConfig | SmtpConfigError | null => {
  const url = env.SMTP_URL?.trim();
  const host = env.SMTP_HOST?.trim();
  if (!url && !host) return null;
  const from = env.MAIL_FROM?.trim();
  if (!from) return { error: "MAIL_FROM is required when SMTP is configured." };
  if (url) {
    if (!/^smtps?:\/\//i.test(url))
      return { error: "SMTP_URL must start with smtp:// or smtps://." };
    return { kind: "url", url, from };
  }
  const portRaw = env.SMTP_PORT?.trim();
  const port = portRaw ? Number(portRaw) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { error: "SMTP_PORT must be an integer between 1 and 65535." };
  const secureRaw = (env.SMTP_SECURE ?? "").trim().toLowerCase();
  if (secureRaw && !["true", "1", "false", "0"].includes(secureRaw))
    return {
      error: 'SMTP_SECURE accepts only "true", "1", "false", or "0".',
    };
  // Unset SMTP_SECURE follows the conventional port: implicit TLS on 465,
  // STARTTLS-or-plain otherwise.
  const secure = secureRaw
    ? secureRaw === "true" || secureRaw === "1"
    : port === 465;
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  if ((user && !pass) || (!user && pass))
    return { error: "SMTP_USER and SMTP_PASS must be set together." };
  return {
    kind: "options",
    host: host as string,
    port,
    secure,
    auth: user && pass ? { user, pass } : null,
    from,
  };
};

/* The shape stored in app_settings under the "mail" key: the admin page's
   fields, password included (it has to be sent somewhere, and the database
   of a self-hosted instance is where every other credential-equivalent
   already lives). The wire NEVER carries the password back out; projections
   expose has_pass instead. */
export interface StoredMailSettings {
  smtp_url: string | null;
  host: string | null;
  port: number | null;
  user: string | null;
  pass: string | null;
  secure: boolean | null;
  mail_from: string | null;
}

/** Convert stored settings to the parser's env-shaped input. */
export const mailSettingsToInput = (
  stored: StoredMailSettings,
): MailSettingsInput => ({
  SMTP_URL: stored.smtp_url ?? undefined,
  SMTP_HOST: stored.host ?? undefined,
  SMTP_PORT: stored.port === null ? undefined : String(stored.port),
  SMTP_USER: stored.user ?? undefined,
  SMTP_PASS: stored.pass ?? undefined,
  SMTP_SECURE: stored.secure === null ? undefined : String(stored.secure),
  MAIL_FROM: stored.mail_from ?? undefined,
});
