import nodemailer from "nodemailer";
import type { Mailer } from "@onelight/core";

export type { Mailer };

/** The message shape the core Mailer port sends. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
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
 * Parse SMTP settings from the environment. Returns null when no transport
 * is configured at all (email disabled), an error object when the
 * configuration is present but unusable, and a config otherwise.
 *
 * Accepted forms: SMTP_URL (smtp://user:pass@host:port or smtps://...) or
 * discrete SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_SECURE. MAIL_FROM
 * is required with either form.
 */
export const parseSmtpConfig = (
  env: Record<string, string | undefined>,
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

/**
 * Build the SMTP mailer from the environment. Returns null (and logs one
 * line) when email is not configured or the configuration is invalid.
 */
export const createMailerFromEnv = (
  env: Record<string, string | undefined>,
): Mailer | null => {
  const config = parseSmtpConfig(env);
  if (config === null) {
    console.log(
      "[onelight] Email is disabled: set SMTP_URL or SMTP_HOST plus MAIL_FROM to enable it.",
    );
    return null;
  }
  if (isSmtpConfigError(config)) {
    console.warn(`[onelight] Email is disabled: ${config.error}`);
    return null;
  }
  const transport =
    config.kind === "url"
      ? nodemailer.createTransport(config.url)
      : nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure,
          ...(config.auth ? { auth: config.auth } : {}),
        });
  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
};
