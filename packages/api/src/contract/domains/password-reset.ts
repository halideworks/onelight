import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { base64UrlEncode, randomBytes, sha256Hex } from "@onelight/core";
import { auditLog, passwordResets, sessions } from "@onelight/db/schema";
import { errorCode, json, req, travel } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import { createUser, uniqueEmail, uniqueIp } from "../seed.js";
import type { SuiteContext } from "../context.js";

const requestReset = async (
  h: ContractHarness,
  email: string,
  ip = uniqueIp(),
): Promise<Response> =>
  req(h, "/api/v1/auth/reset-request", {
    json: { email },
    headers: { "x-forwarded-for": ip },
  });

/**
 * A raw reset token for a user: through the stub mailer when the leg has
 * one (the delivered link is the source of truth), otherwise seeded
 * directly, mirroring what /auth/reset-request writes.
 */
const issueResetToken = async (
  h: ContractHarness,
  userId: string,
  email: string,
): Promise<string> => {
  if (h.mailer) {
    const before = h.mailer.messages.length;
    const response = await requestReset(h, email);
    expect(response.status).toBe(204);
    const message = h.mailer.messages[h.mailer.messages.length - 1];
    expect(h.mailer.messages.length).toBe(before + 1);
    const match = /\/reset\/([A-Za-z0-9_-]+)/.exec(message?.text ?? "");
    expect(match, "reset mail must contain the reset link").toBeTruthy();
    return match?.[1] ?? "";
  }
  const token = base64UrlEncode(randomBytes(32));
  const now = h.clock.now();
  await h.db
    .insert(passwordResets)
    .values({
      id: h.ids.ulid(),
      userId,
      tokenHash: await sha256Hex(token),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      usedAt: null,
    })
    .run();
  return token;
};

export const registerPasswordResetDomain = (ctx: SuiteContext): void => {
  describe("password reset", () => {
    it("answers 204 for unknown and known emails alike, creating rows only for real accounts", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const rowsBefore = (await h.db.select().from(passwordResets).all())
        .length;
      const unknown = await requestReset(h, uniqueEmail());
      expect(unknown.status).toBe(204);
      const rowsAfterUnknown = (await h.db.select().from(passwordResets).all())
        .length;
      expect(rowsAfterUnknown).toBe(rowsBefore);
      const mailedBefore = h.mailer?.messages.length ?? 0;
      const known = await requestReset(h, user.email);
      expect(known.status).toBe(204);
      const rows = await h.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.userId, user.id))
        .all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.usedAt).toBeNull();
      expect(row?.expiresAt).toBe((row?.createdAt ?? 0) + 60 * 60 * 1000);
      if (h.mailer) {
        // The delivered link carries the raw token; only its hash is stored.
        expect(h.mailer.messages.length).toBe(mailedBefore + 1);
        const message = h.mailer.messages[h.mailer.messages.length - 1];
        expect(message?.to).toBe(user.email);
        const prefix = `${h.config.PUBLIC_URL.replace(/\/$/, "")}/reset/`;
        expect(message?.text).toContain(prefix);
        const token =
          /\/reset\/([A-Za-z0-9_-]+)/.exec(message?.text ?? "")?.[1] ?? "";
        expect(await sha256Hex(token)).toBe(row?.tokenHash);
      } else {
        // No mailer configured: the request is still 204 but the audit
        // trail records that nothing was delivered.
        const audits = await h.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "password_reset.request"),
              eq(auditLog.target, `user:${user.id}`),
            ),
          )
          .all();
        expect(audits).toHaveLength(1);
        expect(JSON.parse(audits[0]?.metaJson ?? "{}")).toEqual({
          mail: "unconfigured",
        });
      }
    });

    it("resets the password, revokes every session, and rejects token reuse", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const sessionsBefore = await h.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id))
        .all();
      expect(sessionsBefore.length).toBeGreaterThan(0);
      const token = await issueResetToken(h, user.id, user.email);
      // A weak password is rejected without consuming the token.
      const weak = await req(h, "/api/v1/auth/reset", {
        json: { token, password: "short" },
      });
      expect(weak.status).toBe(400);
      expect(await errorCode(weak)).toBe("validation_failed");
      const newPassword = "a-fresh-password-42";
      const reset = await req(h, "/api/v1/auth/reset", {
        json: { token, password: newPassword },
      });
      expect(reset.status).toBe(204);
      // Every session issued under the old password is gone.
      const sessionsAfter = await h.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, user.id))
        .all();
      expect(sessionsAfter).toHaveLength(0);
      const staleCookie = await req(h, "/api/v1/auth/session", {
        cookie: user.cookie,
      });
      expect(staleCookie.status).toBe(401);
      // The new password works; the old one does not.
      const oldLogin = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: "contract-password-1" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(oldLogin.status).toBe(401);
      const login = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: newPassword },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(login.status).toBe(200);
      expect((await json<{ user: { id: string } }>(login)).user.id).toBe(
        user.id,
      );
      // Reuse is rejected: the token was consumed.
      const reuse = await req(h, "/api/v1/auth/reset", {
        json: { token, password: "another-password-42" },
      });
      expect(reuse.status).toBe(400);
      expect(await errorCode(reuse)).toBe("validation_failed");
    });

    it("expires tokens after one hour", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const token = await issueResetToken(h, user.id, user.email);
      const expired = await travel(h.clock, 61 * 60 * 1000, () =>
        req(h, "/api/v1/auth/reset", {
          json: { token, password: "a-fresh-password-42" },
        }),
      );
      expect(expired.status).toBe(400);
      expect(await errorCode(expired)).toBe("validation_failed");
      // Inside the hour the same token is still live.
      const inTime = await req(h, "/api/v1/auth/reset", {
        json: { token, password: "a-fresh-password-42" },
      });
      expect(inTime.status).toBe(204);
    });

    it("rate limits reset requests per email and per IP", async () => {
      const h = ctx.h();
      // Per email: 5 requests in the window, unique IPs so only the email
      // bucket is exercised.
      const email = uniqueEmail();
      for (let index = 0; index < 5; index += 1)
        expect((await requestReset(h, email)).status).toBe(204);
      const emailLimited = await requestReset(h, email);
      expect(emailLimited.status).toBe(429);
      expect(await errorCode(emailLimited)).toBe("rate_limited");
      expect(emailLimited.headers.get("retry-after")).toBeTruthy();
      // Per IP: 5 requests from one address across distinct emails.
      const ip = uniqueIp();
      for (let index = 0; index < 5; index += 1)
        expect((await requestReset(h, uniqueEmail(), ip)).status).toBe(204);
      const ipLimited = await requestReset(h, uniqueEmail(), ip);
      expect(ipLimited.status).toBe(429);
      expect(await errorCode(ipLimited)).toBe("rate_limited");
    });
  });
};
