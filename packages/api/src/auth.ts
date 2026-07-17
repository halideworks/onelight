import { and, eq, gt, isNull } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import {
  base64UrlEncode,
  days,
  errors,
  randomBytes,
  sha256Hex,
} from "@onelight/core";
import { apiTokens, sessions, users } from "@onelight/db/schema";
import { clientIp } from "./helpers.js";

/* Fold the stored guest flag into the role, once, at the boundary. */
const effectiveUser = (row: typeof users.$inferSelect): SessionUser =>
  row.guest ? { ...row, role: "guest" } : row;
import type { AppEnv, SessionUser, Variables } from "./types.js";

export const SESSION_COOKIE = "ol_session";
export const OIDC_COOKIE = "ol_oidc";
const SESSION_LIFETIME = days(30);

const setSessionCookie = (
  c: Context<{ Variables: Variables }>,
  value: string,
  secure: boolean,
): void => {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: SESSION_LIFETIME / 1000,
  });
};

export const clearSessionCookie = (
  c: Context<{ Variables: Variables }>,
): void => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
};

export const createSession = async (
  env: AppEnv,
  userId: string,
  c: Context<{ Variables: Variables }>,
): Promise<void> => {
  const now = env.clock.now();
  const token = base64UrlEncode(randomBytes(32));
  await env.db
    .insert(sessions)
    .values({
      id: env.ids.ulid(),
      userId,
      tokenHash: await sha256Hex(token),
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME,
      lastSeenAt: now,
      ip: clientIp(c, env),
      userAgent: c.req.header("user-agent") ?? null,
    })
    .run();
  setSessionCookie(c, token, env.config.cookieSecure);
};

const authFromBearer = async (
  env: AppEnv,
  token: string,
): Promise<{ user: SessionUser; authType: "token" } | undefined> => {
  if (!token.startsWith("olt_")) return undefined;
  const hash = await sha256Hex(token);
  const rows = await env.db
    .select({ user: users, token: apiTokens })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(and(eq(apiTokens.tokenHash, hash), isNull(users.disabledAt)))
    .all();
  const row = rows[0];
  if (!row) return undefined;
  if (
    !row.token.lastUsedAt ||
    env.clock.now() - row.token.lastUsedAt > 60 * 60 * 1000
  ) {
    await env.db
      .update(apiTokens)
      .set({ lastUsedAt: env.clock.now() })
      .where(eq(apiTokens.id, row.token.id))
      .run();
  }
  return { user: effectiveUser(row.user), authType: "token" };
};

const authFromSession = async (
  env: AppEnv,
  token: string,
): Promise<
  { user: SessionUser; authType: "session"; refreshed: boolean } | undefined
> => {
  const now = env.clock.now();
  const hash = await sha256Hex(token);
  const rows = await env.db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hash),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .all();
  const row = rows[0];
  if (!row) return undefined;
  let refreshed = false;
  if (now - row.session.lastSeenAt > 24 * 60 * 60 * 1000) {
    await env.db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: now + SESSION_LIFETIME })
      .where(eq(sessions.id, row.session.id))
      .run();
    refreshed = true;
  }
  return { user: effectiveUser(row.user), authType: "session", refreshed };
};

export const authMiddleware =
  (env: AppEnv): MiddlewareHandler<{ Variables: Variables }> =>
  async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (bearer) {
      const resolved = await authFromBearer(env, bearer);
      if (resolved) {
        c.set("user", resolved.user);
        c.set("authType", resolved.authType);
      }
      return next();
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    const resolved = cookie ? await authFromSession(env, cookie) : undefined;
    if (resolved && cookie) {
      c.set("user", resolved.user);
      c.set("authType", resolved.authType);
      // Sliding expiry: when the row's expiry was extended, re-send the
      // cookie with a fresh Max-Age so the browser cookie does not expire
      // while the session row lives (spec phase-0 section 5).
      if (resolved.refreshed)
        setSessionCookie(c, cookie, env.config.cookieSecure);
    }
    await next();
  };

export const requireAuth: MiddlewareHandler<{ Variables: Variables }> = async (
  c,
  next,
) => {
  if (!c.get("user")) throw errors.unauthorized();
  await next();
};

export const requireOrigin =
  (env: AppEnv): MiddlewareHandler<{ Variables: Variables }> =>
  async (c, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method))
      return next();
    if (c.req.header("authorization")) return next();
    // Cookie-carried credentials are CSRF-able: check the session cookie and
    // every share viewer cookie (ol_share_<id>), not just the session.
    const cookies = getCookie(c);
    const carriesCookieCredential =
      Boolean(cookies[SESSION_COOKIE]) ||
      Object.keys(cookies).some((name) => name.startsWith("ol_share_"));
    if (!carriesCookieCredential) return next();
    const candidate = c.req.header("origin") ?? c.req.header("referer");
    if (!candidate || !isAllowedOrigin(candidate, env.config.allowedOrigins))
      throw errors.forbidden("The request origin is not allowed.");
    await next();
  };

/* allowedOrigins is PUBLIC_URL's origin plus any ONELIGHT_ALLOWED_ORIGINS, so
   a deployment reachable by more than one name (LAN address before DNS exists,
   a tailnet host, a second domain) can accept those without PUBLIC_URL --
   which also seeds every absolute URL the app mints -- having to lie.
   An unparseable candidate is rejected rather than thrown on: "Origin: null"
   from a sandboxed iframe is exactly what this check exists to stop, and it
   must not become a 500. */
const isAllowedOrigin = (candidate: string, allowed: string[]): boolean => {
  try {
    return allowed.includes(new URL(candidate).origin);
  } catch {
    return false;
  }
};
