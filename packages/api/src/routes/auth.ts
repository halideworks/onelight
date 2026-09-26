import { eq, and, desc } from "drizzle-orm";
import {
  users,
  workspaces,
  sessions,
  passwordResets,
  apiTokens,
  identities,
} from "@onelight/db/schema";
import {
  errors,
  utf8,
  verifyTotp,
  sha256Hex,
  base64UrlEncode,
  randomBytes,
  renderEmail,
  sha256,
} from "@onelight/core";
import { jsonBody, clientIp, userFromContext, base62 } from "../helpers.js";
import { bodies } from "../schemas.js";
import {
  createSession,
  requireAuth,
  SESSION_COOKIE,
  clearSessionCookie,
  OIDC_COOKIE,
} from "../auth.js";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Identity } from "../operation/identity.js";
import type { Activity } from "../operation/activity.js";
import { userWire } from "../wire.js";
import type { Mail } from "../operation/mail.js";
import type { Access } from "../operation/access.js";

export const registerAuthRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    identity,
    activity,
    mail,
    access,
  }: { identity: Identity; activity: Activity; mail: Mail; access: Access },
) => {
  const { assertPassword, hitRateLimit, spendVerifyBudget } = identity;
  const { audit } = activity;
  const { mailControl, mailStatus } = mail;
  const { workspaceFor } = access;

  // Public pre-auth bootstrap for the web shell: exactly these three fields
  // and nothing else (no ids, no emails, no settings), so nothing leaks
  // beyond what the login and setup pages need.
  api.get("/bootstrap", async (c) => {
    const existingUsers = await env.db
      .select({ id: users.id })
      .from(users)
      .limit(1)
      .all();
    const setupRequired = existingUsers.length === 0;
    const workspace = setupRequired
      ? undefined
      : (
          await env.db
            .select({ name: workspaces.name })
            .from(workspaces)
            .limit(1)
            .all()
        )[0];
    return c.json({
      oidc_enabled: Boolean(
        env.config.OIDC_ISSUER &&
        env.config.OIDC_CLIENT_ID &&
        env.config.OIDC_CLIENT_SECRET,
      ),
      setup_required: setupRequired,
      workspace_name: workspace?.name ?? null,
    });
  });

  api.post("/setup", async (c) => {
    const existing = await env.db
      .select({ id: users.id })
      .from(users)
      .limit(1)
      .all();
    if (existing.length) throw errors.notFound("Setup is already complete.");
    const body = await jsonBody(c, bodies.setup);
    assertPassword(body.password);
    const now = env.clock.now();
    const workspaceId = env.ids.ulid();
    const userId = env.ids.ulid();
    await env.db
      .insert(workspaces)
      .values({
        id: workspaceId,
        name: body.workspace_name,
        settingsJson: "{}",
        createdAt: now,
      })
      .run();
    await env.db
      .insert(users)
      .values({
        id: userId,
        workspaceId,
        email: body.email.trim().toLowerCase(),
        name: body.name.trim(),
        role: "admin",
        passwordHash: await env.hasher.hash(body.password),
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await audit(
      workspaceId,
      userId,
      "setup.complete",
      `workspace:${workspaceId}`,
    );
    const created = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .all()
    )[0];
    if (!created) throw errors.internal();
    c.set("user", created);
    c.set("authType", "session");
    await createSession(env, userId, c);
    return c.json({ user: userWire(created) }, 201);
  });

  api.post("/auth/login", async (c) => {
    const body = await jsonBody(c, bodies.login);
    const ip = clientIp(c, env);
    await hitRateLimit(
      `login:email:${body.email.toLowerCase()}`,
      10,
      5 * 60 * 1000,
    );
    await hitRateLimit(`login:ip:${ip}`, 10, 5 * 60 * 1000);
    const rows = await env.db
      .select()
      .from(users)
      .where(eq(users.email, body.email.trim().toLowerCase()))
      .limit(1)
      .all();
    const user = rows[0];
    if (!user || user.disabledAt || !user.passwordHash) {
      /* Spend the same KDF time a real verify would, so a missing or disabled
         account is not faster to probe than a wrong password. */
      await spendVerifyBudget(body.password);
      throw errors.invalidCredentials();
    }
    if (!(await env.hasher.verify(body.password, user.passwordHash))) {
      await audit(
        user.workspaceId,
        user.id,
        "user.login_failed",
        `user:${user.id}`,
      );
      throw errors.invalidCredentials();
    }
    /* A correct password made under an older iteration count is re-hashed to
       the current floor here, transparently, so the store drifts upward as
       people sign in rather than staying at whatever it was provisioned with. */
    if (env.hasher.needsRehash(user.passwordHash)) {
      const upgraded = await env.hasher.hash(body.password);
      await env.db
        .update(users)
        .set({ passwordHash: upgraded })
        .where(eq(users.id, user.id))
        .run();
    }
    /* With TOTP verified, the password alone gets a five-minute, single
       purpose challenge token, never a session. The token proves the first
       factor to the /auth/login/totp step and nothing else. */
    if (user.totpVerifiedAt && user.totpSecret) {
      const mfaToken = await new SignJWT({ purpose: "mfa" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.id)
        .setExpirationTime("5m")
        .setIssuedAt()
        .sign(utf8(env.config.SECRET_KEY));
      return c.json({ mfa_required: true, mfa_token: mfaToken });
    }
    await createSession(env, user.id, c);
    c.set("user", user);
    c.set("authType", "session");
    await audit(user.workspaceId, user.id, "user.login", `user:${user.id}`);
    return c.json({ user: userWire(user) });
  });

  /* The second factor. Backup codes are accepted in place of a TOTP code
     and burn on use. */
  api.post("/auth/login/totp", async (c) => {
    const body = await jsonBody(c, bodies.loginTotp);
    const ip = clientIp(c, env);
    await hitRateLimit(`login_totp:ip:${ip}`, 10, 5 * 60 * 1000);
    let subject: string;
    try {
      const { payload } = await jwtVerify(
        body.mfa_token,
        utf8(env.config.SECRET_KEY),
      );
      if (payload.purpose !== "mfa" || typeof payload.sub !== "string")
        throw errors.invalidCredentials();
      subject = payload.sub;
    } catch {
      throw errors.invalidCredentials();
    }
    await hitRateLimit(`login_totp:user:${subject}`, 10, 5 * 60 * 1000);
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, subject))
        .limit(1)
        .all()
    )[0];
    if (!user || user.disabledAt || !user.totpSecret || !user.totpVerifiedAt)
      throw errors.invalidCredentials();
    const code = body.code.trim();
    let passed = await verifyTotp(user.totpSecret, code, env.clock.now());
    if (!passed && /^[A-Za-z2-7]{10}$/.test(code)) {
      const hashed = await sha256Hex(code.toUpperCase());
      const stored = JSON.parse(user.totpBackupCodesJson) as string[];
      if (stored.includes(hashed)) {
        const consumed = await env.db
          .update(users)
          .set({
            totpBackupCodesJson: JSON.stringify(
              stored.filter((entry) => entry !== hashed),
            ),
          })
          .where(
            and(
              eq(users.id, user.id),
              eq(users.totpBackupCodesJson, user.totpBackupCodesJson),
            ),
          )
          .returning({ id: users.id })
          .all();
        passed = consumed.length === 1;
      }
    }
    if (!passed) {
      await audit(
        user.workspaceId,
        user.id,
        "user.login_totp_failed",
        `user:${user.id}`,
      );
      throw errors.invalidCredentials();
    }
    await createSession(env, user.id, c);
    c.set("user", user);
    c.set("authType", "session");
    await audit(user.workspaceId, user.id, "user.login", `user:${user.id}`);
    return c.json({ user: userWire(user) });
  });

  api.post("/auth/logout", requireAuth, async (c) => {
    const user = userFromContext(c);
    const token = getCookie(c, SESSION_COOKIE);
    if (token)
      await env.db
        .delete(sessions)
        .where(eq(sessions.tokenHash, await sha256Hex(token)))
        .run();
    clearSessionCookie(c);
    await audit(user.workspaceId, user.id, "user.logout", `user:${user.id}`);
    return c.body(null, 204);
  });

  // Password reset request. ALWAYS 204: whether the email exists, is
  // disabled, or has no password must be indistinguishable to the caller
  // (no account enumeration). Rate limited like login: per email and per IP.
  api.post("/auth/reset-request", async (c) => {
    const body = await jsonBody(c, bodies.resetRequest);
    const email = body.email.trim().toLowerCase();
    const ip = clientIp(c, env);
    await hitRateLimit(`pwreset:email:${email}`, 5, 15 * 60 * 1000);
    await hitRateLimit(`pwreset:ip:${ip}`, 5, 15 * 60 * 1000);
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
        .all()
    )[0];
    if (user && !user.disabledAt) {
      const token = base64UrlEncode(randomBytes(32));
      const now = env.clock.now();
      await env.db
        .insert(passwordResets)
        .values({
          id: env.ids.ulid(),
          userId: user.id,
          tokenHash: await sha256Hex(token),
          createdAt: now,
          expiresAt: now + 60 * 60 * 1000,
          usedAt: null,
        })
        .run();
      if (mailControl && (await mailStatus()).state === "ready") {
        const resetUrl = `${env.config.PUBLIC_URL.replace(/\/$/, "")}/reset/${token}`;
        const workspace = await workspaceFor(user.workspaceId);
        await mailControl.send({
          to: user.email,
          ...renderEmail({
            subject: "Reset your Onelight password",
            /* What the inbox shows beside the subject: the deadline, which is
               the one fact that decides whether to act now or later. */
            preheader: "The link works for one hour.",
            heading: "Reset your password",
            intro: `Somebody asked to reset the password for ${user.email}. If that was you, set a new one within the hour.`,
            ...(workspace?.name ? { workspace: workspace.name } : {}),
            sections: [],
            action: { label: "Choose a new password", href: resetUrl },
            footer: [
              "If it was not you, nothing has changed and you can ignore this. The link expires on its own.",
              "Onelight never asks for your password by email.",
            ],
          }),
        });
        await audit(
          user.workspaceId,
          user.id,
          "password_reset.request",
          `user:${user.id}`,
        );
      } else {
        // No mailer is configured: the token row exists but nothing was
        // delivered. Record that so operators can see why resets stall.
        await audit(
          user.workspaceId,
          user.id,
          "password_reset.request",
          `user:${user.id}`,
          { mail: "unconfigured" },
        );
      }
    }
    return c.body(null, 204);
  });

  api.post("/auth/reset", async (c) => {
    const body = await jsonBody(c, bodies.resetComplete);
    const reset = (
      await env.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, await sha256Hex(body.token)))
        .limit(1)
        .all()
    )[0];
    const now = env.clock.now();
    if (!reset || reset.usedAt || reset.expiresAt <= now)
      throw errors.validation("Reset token is invalid or has expired.");
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, reset.userId))
        .limit(1)
        .all()
    )[0];
    if (!user || user.disabledAt)
      throw errors.validation("Reset token is invalid or has expired.");
    // Password policy runs after token validation but BEFORE the token is
    // consumed, so a weak password does not burn the link.
    assertPassword(body.password);
    await env.db
      .update(users)
      .set({
        passwordHash: await env.hasher.hash(body.password),
        updatedAt: now,
      })
      .where(eq(users.id, user.id))
      .run();
    await env.db
      .update(passwordResets)
      .set({ usedAt: now })
      .where(eq(passwordResets.id, reset.id))
      .run();
    // Every session dies: a reset is the recovery path from a compromised
    // credential, so nothing issued under the old password survives.
    await env.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
    await audit(
      user.workspaceId,
      user.id,
      "password_reset.complete",
      `user:${user.id}`,
    );
    return c.body(null, 204);
  });

  api.get("/auth/session", (c) => {
    const user = c.get("user");
    if (!user) throw errors.unauthorized();
    return c.json({ user: userWire(user), auth: c.get("authType") });
  });

  api.get("/tokens", requireAuth, async (c) => {
    const user = userFromContext(c);
    const rows = await env.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, user.id))
      .orderBy(desc(apiTokens.id))
      .all();
    return c.json({
      items: rows.map((token: typeof apiTokens.$inferSelect) => ({
        id: token.id,
        name: token.name,
        token_prefix: token.tokenPrefix,
        created_at: token.createdAt,
        last_used_at: token.lastUsedAt,
      })),
    });
  });

  api.post("/tokens", requireAuth, async (c) => {
    const user = userFromContext(c);
    const body = await jsonBody(c, bodies.tokenCreate);
    const raw = `olt_${base62(32)}`;
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(apiTokens)
      .values({
        id,
        userId: user.id,
        name: body.name.trim(),
        tokenHash: await sha256Hex(raw),
        tokenPrefix: raw.slice(0, 12),
        createdAt: now,
        lastUsedAt: null,
      })
      .run();
    await audit(user.workspaceId, user.id, "token.create", `token:${id}`);
    return c.json(
      {
        id,
        name: body.name.trim(),
        token_prefix: raw.slice(0, 12),
        token: raw,
        created_at: now,
        last_used_at: null,
      },
      201,
    );
  });

  api.delete("/tokens/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    const token = (
      await env.db
        .select()
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.id, c.req.param("id")),
            eq(apiTokens.userId, user.id),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!token) throw errors.notFound();
    await env.db.delete(apiTokens).where(eq(apiTokens.id, token.id)).run();
    await audit(user.workspaceId, user.id, "token.revoke", `token:${token.id}`);
    return c.body(null, 204);
  });

  api.get("/sessions", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const rows = await env.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, actor.id))
      .orderBy(desc(sessions.lastSeenAt))
      .all();
    return c.json({
      items: rows.map((session: typeof sessions.$inferSelect) => ({
        id: session.id,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
        last_seen_at: session.lastSeenAt,
        ip: session.ip,
        user_agent: session.userAgent,
      })),
    });
  });

  api.delete("/sessions/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await env.db
      .delete(sessions)
      .where(
        and(eq(sessions.id, c.req.param("id")), eq(sessions.userId, actor.id)),
      )
      .run();
    return c.body(null, 204);
  });

  const oidcEnabled = () => {
    if (
      !env.config.OIDC_ISSUER ||
      !env.config.OIDC_CLIENT_ID ||
      !env.config.OIDC_CLIENT_SECRET
    )
      throw errors.notFound("OIDC is not configured.");
    return {
      issuer: env.config.OIDC_ISSUER,
      clientId: env.config.OIDC_CLIENT_ID,
      clientSecret: env.config.OIDC_CLIENT_SECRET,
    };
  };

  api.get("/auth/oidc/start", async (c) => {
    const { issuer, clientId } = oidcEnabled();
    const discovery = await fetch(
      `${issuer}/.well-known/openid-configuration`,
    ).then(async (response) => {
      if (!response.ok) throw errors.internal("OIDC discovery failed.");
      return response.json() as Promise<{ authorization_endpoint: string }>;
    });
    const state = base64UrlEncode(randomBytes(24));
    const nonce = base64UrlEncode(randomBytes(24));
    const verifier = base64UrlEncode(randomBytes(32));
    const challenge = base64UrlEncode(await sha256(verifier));
    const signed = await new SignJWT({ state, nonce, verifier })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(env.config.SECRET_KEY));
    setCookie(c, OIDC_COOKIE, signed, {
      httpOnly: true,
      sameSite: "Lax",
      secure: env.config.cookieSecure,
      maxAge: 600,
      path: "/",
    });
    const redirect = new URL(discovery.authorization_endpoint);
    redirect.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/api/v1/auth/oidc/callback`,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(redirect.toString(), 302);
  });

  api.get("/auth/oidc/callback", async (c) => {
    const { issuer, clientId, clientSecret } = oidcEnabled();
    const ip = clientIp(c, env);
    await hitRateLimit(`oidc_callback:${ip}`, 20, 5 * 60 * 1000);
    const code = c.req.query("code");
    const returnedState = c.req.query("state");
    const signed = getCookie(c, OIDC_COOKIE);
    if (!code || !returnedState || !signed)
      throw errors.forbidden("OIDC callback state is missing.");
    const { payload } = await jwtVerify(
      signed,
      new TextEncoder().encode(env.config.SECRET_KEY),
    );
    if (
      payload.state !== returnedState ||
      typeof payload.verifier !== "string" ||
      typeof payload.nonce !== "string"
    )
      throw errors.forbidden("OIDC callback state is invalid.");
    const discovery = await fetch(
      `${issuer}/.well-known/openid-configuration`,
    ).then(async (response) => {
      if (!response.ok) throw errors.internal("OIDC discovery failed.");
      return response.json() as Promise<{
        token_endpoint: string;
        jwks_uri: string;
      }>;
    });
    const basic = btoa(`${clientId}:${clientSecret}`);
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${env.config.PUBLIC_URL.replace(/\/$/, "")}/api/v1/auth/oidc/callback`,
        code_verifier: payload.verifier,
      }).toString(),
    });
    if (!tokenResponse.ok)
      throw errors.forbidden("OIDC token exchange failed.");
    const tokenBody = (await tokenResponse.json()) as { id_token?: string };
    if (!tokenBody.id_token)
      throw errors.forbidden("OIDC response did not include an ID token.");
    const verified = await jwtVerify(
      tokenBody.id_token,
      createRemoteJWKSet(new URL(discovery.jwks_uri)),
      { issuer, audience: clientId },
    );
    const claims = verified.payload;
    if (claims.nonce !== payload.nonce)
      throw errors.forbidden("OIDC nonce is invalid.");
    const subject = claims.sub;
    const email =
      typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
    if (!subject || !email)
      throw errors.forbidden(
        "OIDC account is missing a verified subject or email.",
      );
    const identity = (
      await env.db
        .select({ user: users })
        .from(identities)
        .innerJoin(users, eq(identities.userId, users.id))
        .where(
          and(eq(identities.provider, issuer), eq(identities.subject, subject)),
        )
        .limit(1)
        .all()
    )[0];
    let user = identity?.user;
    const emailVerified = claims.email_verified === true;
    if (!user && !emailVerified)
      throw errors.forbidden(
        "OIDC email must be verified before this account can be authorized.",
      );
    if (!user && emailVerified)
      user = (
        await env.db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)
          .all()
      )[0];
    if (!user && env.config.OIDC_AUTO_PROVISION) {
      const domain = email.split("@")[1]?.toLowerCase();
      if (
        env.config.oidcAllowedDomains.length &&
        (!domain || !env.config.oidcAllowedDomains.includes(domain))
      )
        throw errors.forbidden("OIDC email domain is not allowed.");
      const workspaceRows = await env.db
        .select()
        .from(workspaces)
        .limit(1)
        .all();
      const workspace = workspaceRows[0];
      if (!workspace)
        throw errors.notFound("Setup is required before OIDC login.");
      const now = env.clock.now();
      const id = env.ids.ulid();
      await env.db
        .insert(users)
        .values({
          id,
          workspaceId: workspace.id,
          email,
          name:
            typeof claims.name === "string"
              ? claims.name
              : (email.split("@")[0] ?? email),
          role: "member",
          passwordHash: null,
          disabledAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      user = (
        await env.db.select().from(users).where(eq(users.id, id)).limit(1).all()
      )[0];
    }
    if (!user || user.disabledAt)
      throw errors.forbidden("This OIDC account is not authorized.");
    const existingIdentity = await env.db
      .select({ id: identities.id })
      .from(identities)
      .where(
        and(eq(identities.provider, issuer), eq(identities.subject, subject)),
      )
      .limit(1)
      .all();
    if (!existingIdentity.length)
      await env.db
        .insert(identities)
        .values({
          id: env.ids.ulid(),
          userId: user.id,
          provider: issuer,
          subject,
          createdAt: env.clock.now(),
        })
        .run();
    await createSession(env, user.id, c);
    deleteCookie(c, OIDC_COOKIE, { path: "/" });
    await audit(user.workspaceId, user.id, "oidc.login", `user:${user.id}`);
    return c.redirect("/", 302);
  });
};
