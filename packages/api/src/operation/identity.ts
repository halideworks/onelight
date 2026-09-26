import { base64UrlEncode, randomBytes, errors } from "@onelight/core";
import { rateLimits, users } from "@onelight/db/schema";
import { lt, eq, sql, and } from "drizzle-orm";
import type { AppEnv } from "../types.js";

export const createIdentity = (env: AppEnv) => {
  // Any bucket older than this is definitely outside its own window (it must
  // be >= the longest window any hitRateLimit caller uses, currently the
  // 15 minute password-reset window), so deleting it opportunistically can
  // never reset a still-live counter for another key.
  const RATE_LIMIT_RETENTION_MS = 15 * 60 * 1000;

  /* A hash of a random secret nobody knows, made once at first login. When an
     email has no account we still verify the submitted password against this,
     so a missing user costs the same time as a wrong password -- otherwise the
     no-user path (which skips the deliberately slow KDF) is measurably faster
     and reveals which emails have accounts. */
  let decoyHash: Promise<string> | null = null;

  const spendVerifyBudget = async (password: string): Promise<void> => {
    decoyHash ??= env.hasher.hash(base64UrlEncode(randomBytes(24)));
    await env.hasher.verify(password, await decoyHash);
  };

  const hitRateLimit = async (key: string, limit: number, windowMs: number) => {
    const now = env.clock.now();
    // Opportunistic cleanup keeps rate_limits from growing without bound: on
    // every increment, drop rows whose window closed long enough ago that no
    // live counter can be lost. Bounded to stale rows only.
    await env.db
      .delete(rateLimits)
      .where(lt(rateLimits.windowStart, now - RATE_LIMIT_RETENTION_MS))
      .run();
    const rows = await env.db
      .select()
      .from(rateLimits)
      .where(eq(rateLimits.key, key))
      .limit(1)
      .all();
    const current = rows[0];
    if (!current || now - current.windowStart >= windowMs) {
      await env.db
        .insert(rateLimits)
        .values({ key, windowStart: now, count: 1 })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: { windowStart: now, count: 1 },
        })
        .run();
      return;
    }
    if (current.count >= limit)
      throw errors.rateLimited(
        Math.ceil((windowMs - (now - current.windowStart)) / 1000),
      );
    /* Increment in SQL, not read-modify-write: concurrent requests in one
       window would otherwise each read the same count and write count+1, losing
       updates and admitting more than `limit`. The WHERE re-checks the window
       so a row that rolled over between the read and here is not bumped as if it
       were still the old window. */
    await env.db
      .update(rateLimits)
      .set({ count: sql`${rateLimits.count} + 1` })
      .where(
        and(
          eq(rateLimits.key, key),
          eq(rateLimits.windowStart, current.windowStart),
        ),
      )
      .run();
  };

  const passwordError = () =>
    errors.validation(
      "Password must be at least 10 characters and not a common password.",
    );

  const assertPassword = (password: string) => {
    if (
      password.length < 10 ||
      [
        "password",
        "password123",
        "1234567890",
        "qwertyuiop",
        "letmein123",
      ].includes(password.toLowerCase())
    )
      throw passwordError();
  };

  /* ---- avatars ---- */

  const AVATAR_TYPES: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };

  const AVATAR_MAX_BYTES = 512 * 1024;

  const userAvatarResponse = async (
    target: typeof users.$inferSelect,
    cacheControl = "private, max-age=86400",
  ): Promise<Response> => {
    if (!env.blobStore) throw errors.notFound();
    if (!target.avatarKey) throw errors.notFound();
    const extension = target.avatarKey.split(".").pop() ?? "png";
    const contentType =
      Object.entries(AVATAR_TYPES).find(([, ext]) => ext === extension)?.[0] ??
      "image/png";
    let stream: ReadableStream;
    try {
      stream = await env.blobStore.getStream(target.avatarKey);
    } catch {
      /* The pointer outlived its blob (a GC sweep, a restore from a database
         backup taken after the blob was gone). Reconcile rather than serving a
         broken image forever: clearing the column makes userWire stop emitting
         an avatar_url and the initials stand in cleanly. */
      await env.db
        .update(users)
        .set({ avatarKey: null, updatedAt: env.clock.now() })
        .where(eq(users.id, target.id))
        .run();
      throw errors.notFound();
    }
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
      },
    });
  };

  return {
    spendVerifyBudget,
    hitRateLimit,
    assertPassword,
    AVATAR_TYPES,
    AVATAR_MAX_BYTES,
    userAvatarResponse,
  };
};

export type Identity = ReturnType<typeof createIdentity>;
