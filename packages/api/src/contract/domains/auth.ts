import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { days, loadConfig, sha256Hex, totpCode } from "@onelight/core";
import { rateLimits, sessions } from "@onelight/db/schema";
import { createApp } from "../../app.js";
import {
  assertSnakeCaseKeys,
  errorCode,
  forbiddenKeysIn,
  json,
  req,
  travel,
} from "../harness.js";
import {
  PASSWORD,
  createSessionCookie,
  createUser,
  uniqueEmail,
  uniqueIp,
} from "../seed.js";
import type { SuiteContext } from "../context.js";

const HOUR = 60 * 60 * 1000;

export const registerAuthDomain = (ctx: SuiteContext): void => {
  describe("auth", () => {
    it("returns 404 from /setup once a user exists", async () => {
      const h = ctx.h();
      const response = await req(h, "/api/v1/setup", {
        json: {
          workspace_name: "Again",
          name: "Nope",
          email: uniqueEmail(),
          password: PASSWORD,
        },
      });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
    });

    it("logs in with the phase-0 cookie flags and user wire shape", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
        session: false,
      });
      const response = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: PASSWORD },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(response.status).toBe(200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("ol_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain(`Max-Age=${(days(30) / 1000).toString()}`);
      const body = await json<{ user: Record<string, unknown> }>(response);
      expect(body.user.email).toBe(user.email);
      expect(body.user.role).toBe("member");
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      expect(forbiddenKeysIn(body)).toEqual([]);
      expect(body.user).not.toHaveProperty("password_hash");
    });

    it("rejects bad credentials, unknown emails, and disabled users identically", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
        session: false,
      });
      const disabled = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
        disabled: true,
        session: false,
      });
      for (const attempt of [
        { email: user.email, password: "wrong-password-1" },
        { email: uniqueEmail(), password: PASSWORD },
        { email: disabled.email, password: PASSWORD },
      ]) {
        const response = await req(h, "/api/v1/auth/login", {
          json: attempt,
          headers: { "x-forwarded-for": uniqueIp() },
        });
        expect(response.status, attempt.email).toBe(401);
        expect(await errorCode(response)).toBe("invalid_credentials");
      }
    });

    it("reports the session via GET /auth/session for cookies and tokens", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const anonymous = await req(h, "/api/v1/auth/session");
      expect(anonymous.status).toBe(401);
      const viaCookie = await req(h, "/api/v1/auth/session", {
        cookie: seed.admin.cookie,
      });
      expect(viaCookie.status).toBe(200);
      expect((await json(viaCookie)).auth).toBe("session");
      const tokenResponse = await req(h, "/api/v1/tokens", {
        cookie: seed.admin.cookie,
        json: { name: "session-probe" },
      });
      const token = await json<{ token: string; id: string }>(tokenResponse);
      const viaToken = await req(h, "/api/v1/auth/session", {
        bearer: token.token,
      });
      expect(viaToken.status).toBe(200);
      expect((await json(viaToken)).auth).toBe("token");
      await req(h, `/api/v1/tokens/${token.id}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
    });

    it("logs out: 204, cleared cookie, session row revoked", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const logout = await req(h, "/api/v1/auth/logout", {
        method: "POST",
        cookie: user.cookie,
      });
      expect(logout.status).toBe(204);
      const cleared = logout.headers.get("set-cookie") ?? "";
      expect(cleared).toContain("ol_session=");
      expect(cleared.toLowerCase()).toContain("max-age=0");
      const after = await req(h, "/api/v1/users/me", { cookie: user.cookie });
      expect(after.status).toBe(401);
    });

    it("slides session expiry after 24h and re-sends the cookie", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const token = user.cookie.split("=")[1] ?? "";
      const fresh = await req(h, "/api/v1/users/me", { cookie: user.cookie });
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("set-cookie")).toBeNull();
      await travel(h.clock, 25 * HOUR, async () => {
        const slid = await req(h, "/api/v1/users/me", { cookie: user.cookie });
        expect(slid.status).toBe(200);
        const setCookie = slid.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain(`ol_session=${token}`);
        expect(setCookie).toContain(`Max-Age=${(days(30) / 1000).toString()}`);
        const row = (
          await h.db
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, await sha256Hex(token)))
            .limit(1)
            .all()
        )[0];
        expect(row?.expiresAt).toBe(h.clock.now() + days(30));
        expect(row?.lastSeenAt).toBe(h.clock.now());
      });
    });

    it("rejects sessions older than 30 days", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      await travel(h.clock, days(31), async () => {
        const response = await req(h, "/api/v1/users/me", {
          cookie: user.cookie,
        });
        expect(response.status).toBe(401);
      });
    });

    it("enforces the CSRF origin rule on cookie mutations and exempts bearer", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const noOrigin = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: seed.editor.cookie,
        origin: false,
        json: { name: "No Origin" },
      });
      expect(noOrigin.status).toBe(403);
      const evil = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: seed.editor.cookie,
        origin: "http://evil.example",
        json: { name: "Evil Origin" },
      });
      expect(evil.status).toBe(403);
      const viaReferer = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: seed.editor.cookie,
        origin: false,
        headers: {
          referer: `${new URL(h.config.PUBLIC_URL).origin}/settings`,
        },
        json: { name: "Referer Origin" },
      });
      expect(viaReferer.status).toBe(200);
      const tokenResponse = await req(h, "/api/v1/tokens", {
        cookie: seed.editor.cookie,
        json: { name: "csrf-exempt" },
      });
      const token = await json<{ token: string; id: string }>(tokenResponse);
      const bearerMutation = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        bearer: token.token,
        origin: false,
        json: { name: "Bearer Mutation" },
      });
      expect(bearerMutation.status).toBe(200);
      await req(h, `/api/v1/tokens/${token.id}`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
    });

    /* PUBLIC_URL is both the origin users arrive from and the base for every
       absolute URL the app mints. A deployment reachable by a second name (the
       LAN address before public DNS exists, a tailnet host) cannot express that
       with PUBLIC_URL alone, and the symptom is a login that 403s with no
       obvious cause. ONELIGHT_ALLOWED_ORIGINS widens the CSRF rule and nothing
       else -- so this checks the listed origin passes AND that an unlisted one
       is still refused by the same app. */
    it("accepts an origin from ONELIGHT_ALLOWED_ORIGINS, and still refuses others", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const LAN = "http://192.168.1.52:3000";
      const widened = createApp({
        db: h.db,
        hasher: h.hasher,
        clock: h.clock,
        ids: h.ids,
        config: loadConfig({
          PUBLIC_URL: h.config.PUBLIC_URL,
          SECRET_KEY: h.config.SECRET_KEY,
          ONELIGHT_ALLOWED_ORIGINS: LAN,
        }),
        version: "contract-origins",
      });
      const patch = async (origin: string): Promise<Response> =>
        widened.request("/api/v1/users/me", {
          method: "PATCH",
          headers: {
            cookie: seed.editor.cookie,
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Origin Test" }),
        });
      expect((await patch(LAN)).status).toBe(200);
      expect((await patch(new URL(h.config.PUBLIC_URL).origin)).status).toBe(
        200,
      );
      expect((await patch("http://evil.example")).status).toBe(403);
      // A near-miss must not pass: this is a strict origin match, not a prefix.
      expect((await patch("http://192.168.1.52:3001")).status).toBe(403);
      expect(
        (await patch("http://192.168.1.52:3000.evil.example")).status,
      ).toBe(403);
    });

    it("rate limits login per email with Retry-After and resets by window", async () => {
      const h = ctx.h();
      const email = uniqueEmail();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await req(h, "/api/v1/auth/login", {
          json: { email, password: "definitely-wrong-1" },
          headers: { "x-forwarded-for": uniqueIp() },
        });
        expect(response.status).toBe(401);
      }
      const limited = await req(h, "/api/v1/auth/login", {
        json: { email, password: "definitely-wrong-1" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(limited.status).toBe(429);
      expect(await errorCode(limited)).toBe("rate_limited");
      const retryAfter = Number(limited.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(300);
      await travel(h.clock, 5 * 60 * 1000 + 1000, async () => {
        const reset = await req(h, "/api/v1/auth/login", {
          json: { email, password: "definitely-wrong-1" },
          headers: { "x-forwarded-for": uniqueIp() },
        });
        expect(reset.status).toBe(401);
      });
    });

    it("rate limits login per IP across distinct emails", async () => {
      const h = ctx.h();
      const ip = uniqueIp();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await req(h, "/api/v1/auth/login", {
          json: { email: uniqueEmail(), password: "definitely-wrong-1" },
          headers: { "x-forwarded-for": ip },
        });
        expect(response.status).toBe(401);
      }
      const limited = await req(h, "/api/v1/auth/login", {
        json: { email: uniqueEmail(), password: "definitely-wrong-1" },
        headers: { "x-forwarded-for": ip },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    });

    it("does not let a spoofed X-Forwarded-For split rate buckets when the proxy is untrusted", async () => {
      const h = ctx.h();
      const original = h.config.TRUST_PROXY;
      h.config.TRUST_PROXY = false;
      try {
        // The in-memory app exposes no peer socket, so every request shares the
        // socket-less bucket. Clean it so the threshold is deterministic.
        await h.db
          .delete(rateLimits)
          .where(eq(rateLimits.key, "login:ip:no-socket"))
          .run();
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const response = await req(h, "/api/v1/auth/login", {
            json: { email: uniqueEmail(), password: "definitely-wrong-1" },
            // A distinct spoofed client IP per attempt: with the proxy
            // untrusted these must NOT create distinct buckets.
            headers: { "x-forwarded-for": `10.0.0.${attempt.toString()}` },
          });
          expect(response.status).toBe(401);
        }
        const limited = await req(h, "/api/v1/auth/login", {
          json: { email: uniqueEmail(), password: "definitely-wrong-1" },
          headers: { "x-forwarded-for": "203.0.113.254" },
        });
        expect(limited.status).toBe(429);
        expect(await errorCode(limited)).toBe("rate_limited");
      } finally {
        h.config.TRUST_PROXY = original;
      }
    });

    it("prunes rate-limit rows older than the retention window on increment", async () => {
      const h = ctx.h();
      const staleIp = uniqueIp();
      await req(h, "/api/v1/auth/login", {
        json: { email: uniqueEmail(), password: "definitely-wrong-1" },
        headers: { "x-forwarded-for": staleIp },
      });
      const key = `login:ip:${staleIp}`;
      expect(
        await h.db
          .select()
          .from(rateLimits)
          .where(eq(rateLimits.key, key))
          .all(),
      ).toHaveLength(1);
      // A fresh increment more than the retention window later prunes the row.
      await travel(h.clock, 16 * 60 * 1000, async () => {
        await req(h, "/api/v1/auth/login", {
          json: { email: uniqueEmail(), password: "definitely-wrong-1" },
          headers: { "x-forwarded-for": uniqueIp() },
        });
      });
      expect(
        await h.db
          .select()
          .from(rateLimits)
          .where(eq(rateLimits.key, key))
          .all(),
      ).toHaveLength(0);
    });

    it("changes passwords: current required, other sessions revoked, policy enforced", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const otherCookie = await createSessionCookie(h, user.id);
      const weak = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: user.cookie,
        json: { password: { current: PASSWORD, new: "short" } },
      });
      expect(weak.status).toBe(400);
      const badCurrent = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: user.cookie,
        json: {
          password: { current: "not-the-password", new: "a-new-password-1" },
        },
      });
      expect(badCurrent.status).toBe(401);
      expect(await errorCode(badCurrent)).toBe("invalid_credentials");
      const changed = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: user.cookie,
        json: { password: { current: PASSWORD, new: "a-new-password-1" } },
      });
      expect(changed.status).toBe(200);
      const revoked = await req(h, "/api/v1/users/me", {
        cookie: otherCookie,
      });
      expect(revoked.status).toBe(401);
      const stillValid = await req(h, "/api/v1/users/me", {
        cookie: user.cookie,
      });
      expect(stillValid.status).toBe(200);
      const login = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: "a-new-password-1" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(login.status).toBe(200);
    });

    it("rejects both auth types for a disabled user", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const tokenResponse = await req(h, "/api/v1/tokens", {
        cookie: user.cookie,
        json: { name: "will-be-disabled" },
      });
      const token = await json<{ token: string }>(tokenResponse);
      const disable = await req(h, `/api/v1/users/${user.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { disabled: true },
      });
      expect(disable.status).toBe(200);
      const viaCookie = await req(h, "/api/v1/users/me", {
        cookie: user.cookie,
      });
      expect(viaCookie.status).toBe(401);
      const viaBearer = await req(h, "/api/v1/users/me", {
        bearer: token.token,
      });
      expect(viaBearer.status).toBe(401);
    });

    it("returns 404 from OIDC start when OIDC is not configured", async () => {
      const h = ctx.h();
      const response = await req(h, "/api/v1/auth/oidc/start");
      expect(response.status).toBe(404);
    });
  });

  describe("two-factor", () => {
    it("enrolls, gates login, and burns backup codes on use", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const begun = await req(h, "/api/v1/users/me/totp", {
        method: "POST",
        cookie: user.cookie,
      });
      expect(begun.status).toBe(201);
      const enrolment = await json<{ secret: string; otpauth_url: string }>(
        begun,
      );
      expect(enrolment.otpauth_url).toContain("otpauth://totp/");
      // Unverified enrolment changes nothing about login.
      const plain = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: PASSWORD },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(plain.status).toBe(200);
      expect((await json(plain)).user).toBeDefined();
      // A wrong code does not activate; the right one hands over backups.
      const wrong = await req(h, "/api/v1/users/me/totp/verify", {
        cookie: user.cookie,
        json: { code: "000000" },
      });
      expect(wrong.status).toBe(400);
      const verified = await req(h, "/api/v1/users/me/totp/verify", {
        cookie: user.cookie,
        json: { code: await totpCode(enrolment.secret, h.clock.now()) },
      });
      expect(verified.status).toBe(200);
      const { backup_codes } = await json<{ backup_codes: string[] }>(verified);
      expect(backup_codes).toHaveLength(8);
      const me = await json(
        await req(h, "/api/v1/users/me", { cookie: user.cookie }),
      );
      expect(me.totp_enabled).toBe(true);
      // Password alone now earns a challenge, not a session.
      const challenged = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: PASSWORD },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(challenged.status).toBe(200);
      const challenge = await json<{
        mfa_required?: boolean;
        mfa_token?: string;
        user?: unknown;
      }>(challenged);
      expect(challenge.mfa_required).toBe(true);
      expect(challenge.user).toBeUndefined();
      const badSecond = await req(h, "/api/v1/auth/login/totp", {
        json: { mfa_token: challenge.mfa_token, code: "123456" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(badSecond.status).toBe(401);
      const second = await req(h, "/api/v1/auth/login/totp", {
        json: {
          mfa_token: challenge.mfa_token,
          code: await totpCode(enrolment.secret, h.clock.now()),
        },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(second.status).toBe(200);
      expect((await json(second)).user).toBeDefined();
      // A backup code substitutes for the authenticator, exactly once.
      const reChallenge = await json<{ mfa_token: string }>(
        await req(h, "/api/v1/auth/login", {
          json: { email: user.email, password: PASSWORD },
          headers: { "x-forwarded-for": uniqueIp() },
        }),
      );
      const backup = backup_codes[0] ?? "";
      const viaBackup = await req(h, "/api/v1/auth/login/totp", {
        json: { mfa_token: reChallenge.mfa_token, code: backup },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(viaBackup.status).toBe(200);
      const reuse = await json<{ mfa_token: string }>(
        await req(h, "/api/v1/auth/login", {
          json: { email: user.email, password: PASSWORD },
          headers: { "x-forwarded-for": uniqueIp() },
        }),
      );
      const burned = await req(h, "/api/v1/auth/login/totp", {
        json: { mfa_token: reuse.mfa_token, code: backup },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(burned.status).toBe(401);
      // Turning it off needs a code; after that, login is plain again.
      const denied = await req(h, "/api/v1/users/me/totp", {
        method: "DELETE",
        cookie: user.cookie,
        json: { code: "999999" },
      });
      expect(denied.status).toBe(400);
      const disabled = await req(h, "/api/v1/users/me/totp", {
        method: "DELETE",
        cookie: user.cookie,
        json: { code: await totpCode(enrolment.secret, h.clock.now()) },
      });
      expect(disabled.status).toBe(204);
      const after = await req(h, "/api/v1/auth/login", {
        json: { email: user.email, password: PASSWORD },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect((await json(after)).user).toBeDefined();
    });

    it("refuses enrolment over an API token", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const issued = await req(h, "/api/v1/tokens", {
        cookie: seed.admin.cookie,
        json: { name: "totp-probe" },
      });
      expect(issued.status).toBe(201);
      const { token } = await json<{ token: string }>(issued);
      const overToken = await req(h, "/api/v1/users/me/totp", {
        method: "POST",
        bearer: token,
      });
      expect(overToken.status).toBe(403);
    });
  });

  describe("api tokens", () => {
    it("shows the token exactly once and stores only a prefix", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const created = await req(h, "/api/v1/tokens", {
        cookie: user.cookie,
        json: { name: "ci token" },
      });
      expect(created.status).toBe(201);
      const body = await json<{
        id: string;
        token: string;
        token_prefix: string;
        name: string;
      }>(created);
      expect(body.token.startsWith("olt_")).toBe(true);
      expect(body.token_prefix).toBe(body.token.slice(0, 12));
      const list = await req(h, "/api/v1/tokens", { cookie: user.cookie });
      const listBody = await json<{ items: Array<Record<string, unknown>> }>(
        list,
      );
      const entry = listBody.items.find((item) => item.id === body.id);
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty("token");
      expect(entry).not.toHaveProperty("token_hash");
      expect(assertSnakeCaseKeys(listBody)).toEqual([]);
      const authed = await req(h, "/api/v1/users/me", { bearer: body.token });
      expect(authed.status).toBe(200);
      const afterUse = await req(h, "/api/v1/tokens", { cookie: user.cookie });
      const afterUseBody = await json<{
        items: Array<{ id: string; last_used_at: number | null }>;
      }>(afterUse);
      expect(
        afterUseBody.items.find((item) => item.id === body.id)?.last_used_at,
      ).toBeTruthy();
      const revoked = await req(h, `/api/v1/tokens/${body.id}`, {
        method: "DELETE",
        cookie: user.cookie,
      });
      expect(revoked.status).toBe(204);
      const dead = await req(h, "/api/v1/users/me", { bearer: body.token });
      expect(dead.status).toBe(401);
    });

    it("scopes token listing and revocation to the owning user", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const owner = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const created = await req(h, "/api/v1/tokens", {
        cookie: owner.cookie,
        json: { name: "private" },
      });
      const token = await json<{ id: string; token: string }>(created);
      const foreignDelete = await req(h, `/api/v1/tokens/${token.id}`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
      expect(foreignDelete.status).toBe(404);
      const stillWorks = await req(h, "/api/v1/users/me", {
        bearer: token.token,
      });
      expect(stillWorks.status).toBe(200);
    });
  });

  describe("sessions endpoints", () => {
    it("lists and revokes sessions, scoped to the caller", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const secondCookie = await createSessionCookie(h, user.id);
      const list = await req(h, "/api/v1/sessions", { cookie: user.cookie });
      expect(list.status).toBe(200);
      const body = await json<{ items: Array<Record<string, unknown>> }>(list);
      expect(body.items.length).toBeGreaterThanOrEqual(2);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
      for (const item of body.items) {
        expect(item).not.toHaveProperty("token_hash");
        expect(item).not.toHaveProperty("user_id");
      }
      const secondToken = secondCookie.split("=")[1] ?? "";
      const secondHash = await sha256Hex(secondToken);
      const rows = await h.db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, secondHash))
        .all();
      const secondId = rows[0]?.id ?? "";
      const foreign = await req(h, `/api/v1/sessions/${secondId}`, {
        method: "DELETE",
        cookie: seed.editor.cookie,
      });
      expect(foreign.status).toBe(204);
      const survives = await req(h, "/api/v1/users/me", {
        cookie: secondCookie,
      });
      expect(survives.status).toBe(200);
      const revoke = await req(h, `/api/v1/sessions/${secondId}`, {
        method: "DELETE",
        cookie: user.cookie,
      });
      expect(revoke.status).toBe(204);
      const dead = await req(h, "/api/v1/users/me", { cookie: secondCookie });
      expect(dead.status).toBe(401);
    });
  });
};
