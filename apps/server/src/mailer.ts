import nodemailer from "nodemailer";
import { isSmtpConfigError, parseSmtpConfig } from "@onelight/core";
import type { Mailer, SmtpConfig } from "@onelight/core";

export type { Mailer, SmtpConfig };
/* The parser lives in core so the API validates admin-typed settings with
   the exact same rules; re-exported here for the existing callers/tests. */
export { isSmtpConfigError, parseSmtpConfig };

/** The message shape the core Mailer port sends. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Build a nodemailer-backed Mailer for a parsed config. */
export const createMailerForConfig = (config: SmtpConfig): Mailer => {
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
  return createMailerForConfig(config);
};
