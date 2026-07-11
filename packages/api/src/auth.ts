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
import type { AppEnv, Variables } from "./types.js";

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
      ip:
        c.req.header("cf-connecting-ip") ??
        c.req.header("x-forwarded-for") ??
        null,
      userAgent: c.req.header("user-agent") ?? null,
    })
    .run();
  setSessionCookie(c, token, env.config.cookieSecure);
};

const authFromBearer = async (
  env: AppEnv,
  token: string,
): Promise<
  { user: typeof users.$inferSelect; authType: "token" } | undefined
> => {
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
  return { user: row.user, authType: "token" };
};

const authFromSession = async (
  env: AppEnv,
  token: string,
): Promise<
  { user: typeof users.$inferSelect; authType: "session" } | undefined
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
  if (now - row.session.lastSeenAt > 24 * 60 * 60 * 1000) {
    await env.db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: now + SESSION_LIFETIME })
      .where(eq(sessions.id, row.session.id))
      .run();
  }
  return { user: row.user, authType: "session" };
};

export const authMiddleware =
  (env: AppEnv): MiddlewareHandler<{ Variables: Variables }> =>
  async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const resolved = bearer
      ? await authFromBearer(env, bearer)
      : await (async () => {
          const cookie = getCookie(c, SESSION_COOKIE);
          return cookie ? authFromSession(env, cookie) : undefined;
        })();
    if (resolved) {
      c.set("user", resolved.user);
      c.set("authType", resolved.authType);
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
    if (
      !candidate ||
      new URL(candidate).origin !== new URL(env.config.PUBLIC_URL).origin
    )
      throw errors.forbidden("The request origin is not allowed.");
    await next();
  };
