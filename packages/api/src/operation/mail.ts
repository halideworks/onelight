import { appSettings } from "@onelight/db/schema";
import { eq } from "drizzle-orm";
import type { StoredMailSettings } from "@onelight/core";
import { openStored } from "@onelight/core";
import type { Context } from "hono";
import type { Variables, AppEnv } from "../types.js";

export const createMail = (env: AppEnv) => {
  /* One mail surface for every route: the platform's dynamic control when
     present (the Node server, which resolves admin settings over the
     environment), else a static facade over the injected mailer (the
     contract harness), else undefined (mail disabled). */
  const mailControl =
    env.mail ??
    (env.mailer
      ? {
          status: () =>
            Promise.resolve({
              state: "ready" as const,
              detail: null,
              source: "env" as const,
            }),
          send: (message: {
            to: string;
            subject: string;
            text: string;
            html?: string;
            headers?: Record<string, string>;
          }) => env.mailer!.send(message),
          reload: (): void => {},
        }
      : undefined);

  const mailStatus = async (): Promise<{
    state: "ready" | "disabled" | "error";
    detail: string | null;
    source: "settings" | "env" | "none";
  }> =>
    mailControl
      ? mailControl.status()
      : { state: "disabled", detail: null, source: "none" };

  /* ---- mail settings (admin, session only): the SMTP transport, editable
     from the UI and stored in app_settings under the "mail" key. Stored
     settings take precedence over the environment; DELETE falls back to
     the environment. The password never leaves the server: projections
     carry has_pass, and a URL is masked of its credential. ---- */

  const MAIL_SETTINGS_KEY = "mail";

  const MAIL_POLICY_KEY = "mail_policy";

  /* What the instance sends when email works. Password resets are not a
     policy: a reset that silently cannot arrive is a lockout. */
  type MailPolicy = { invites: boolean; digests: boolean };

  const readMailPolicy = async (): Promise<MailPolicy> => {
    const rows = await env.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, MAIL_POLICY_KEY))
      .all();
    const row = rows[0];
    if (!row) return { invites: true, digests: true };
    try {
      const parsed = JSON.parse(row.valueJson) as Partial<MailPolicy>;
      return {
        invites: parsed.invites !== false,
        digests: parsed.digests !== false,
      };
    } catch {
      return { invites: true, digests: true };
    }
  };

  const writeMailPolicy = async (
    policy: MailPolicy,
    actorId: string,
  ): Promise<void> => {
    const now = env.clock.now();
    await env.db
      .insert(appSettings)
      .values({
        key: MAIL_POLICY_KEY,
        valueJson: JSON.stringify(policy),
        updatedAt: now,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          valueJson: JSON.stringify(policy),
          updatedAt: now,
          updatedBy: actorId,
        },
      })
      .run();
  };

  /* The two fields that carry a credential to somebody else's system. The
     rest of the row -- host, port, the from address -- is configuration, and
     sealing it would only make the settings page unreadable to its admin. */
  const readStoredMail = async (): Promise<StoredMailSettings | null> => {
    const rows = await env.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, MAIL_SETTINGS_KEY))
      .all();
    const row = rows[0];
    if (!row) return null;
    let stored: StoredMailSettings;
    try {
      stored = JSON.parse(row.valueJson) as StoredMailSettings;
    } catch {
      return null;
    }
    const key = env.config.SECRET_KEY;
    const pass = await openStored(key, stored.pass);
    const url = await openStored(key, stored.smtp_url);
    /* A sealed value that will not open means SECRET_KEY changed. Every one
       of them is unreadable at once, so the honest answer is that mail is not
       configured -- not a 500 on the settings page, and certainly not sending
       through a half-read config. */
    if ((stored.pass && pass === null) || (stored.smtp_url && url === null)) {
      console.warn(
        "[onelight] the stored SMTP credential cannot be read; SECRET_KEY has changed since it was saved. Mail is disabled until the settings are entered again.",
      );
      return null;
    }
    return { ...stored, pass, smtp_url: url };
  };

  const maskedMailUrl = (
    raw: string,
  ): { url: string; hadCredential: boolean } => {
    try {
      const url = new URL(raw);
      const hadCredential = url.password.length > 0;
      if (hadCredential) url.password = "";
      return { url: url.toString(), hadCredential };
    } catch {
      return { url: raw, hadCredential: false };
    }
  };

  const mailSettingsWire = (stored: StoredMailSettings) => {
    const masked = stored.smtp_url ? maskedMailUrl(stored.smtp_url) : null;
    return {
      smtp_url: masked ? masked.url : null,
      host: stored.host,
      port: stored.port,
      user: stored.user,
      has_pass: Boolean(stored.pass) || Boolean(masked?.hadCredential),
      secure: stored.secure,
      mail_from: stored.mail_from,
    };
  };

  const mailSettingsResponse = async (c: Context<{ Variables: Variables }>) => {
    const stored = await readStoredMail();
    return c.json({
      stored: stored ? mailSettingsWire(stored) : null,
      active: await mailStatus(),
      policy: await readMailPolicy(),
    });
  };

  return {
    mailControl,
    mailStatus,
    MAIL_SETTINGS_KEY,
    readMailPolicy,
    writeMailPolicy,
    readStoredMail,
    mailSettingsResponse,
  };
};

export type Mail = ReturnType<typeof createMail>;
