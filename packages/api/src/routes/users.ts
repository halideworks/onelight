import {
  requireAuth,
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
} from "../auth.js";
import {
  userFromContext,
  jsonBody,
  readBodyBytes,
  getLimit,
  cursorParam,
  clientIp,
} from "../helpers.js";
import {
  errors,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
  generateBackupCodes,
  sha256Hex,
  base64UrlEncode,
  randomBytes,
  days,
  renderEmail,
} from "@onelight/core";
import {
  users,
  sessions,
  apiTokens,
  projects,
  invites,
  projectMembers,
} from "@onelight/db/schema";
import { eq, and, lt, desc, ne, isNull, gt } from "drizzle-orm";
import { bodies } from "../schemas.js";
import { getCookie } from "hono/cookie";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Identity } from "../operation/identity.js";
import type { Activity } from "../operation/activity.js";
import type { Blobs } from "../operation/blobs.js";
import { pageResult, userWire } from "../wire.js";
import type { Mail } from "../operation/mail.js";
import type { Access } from "../operation/access.js";

export const registerUsersRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    identity,
    activity,
    blobs,
    mail,
    access,
  }: {
    identity: Identity;
    activity: Activity;
    blobs: Blobs;
    mail: Mail;
    access: Access;
  },
) => {
  const {
    hitRateLimit,
    AVATAR_TYPES,
    AVATAR_MAX_BYTES,
    userAvatarResponse,
    assertPassword,
  } = identity;
  const { audit } = activity;
  const { deleteBlobQuietly } = blobs;
  const { mailControl, mailStatus, readMailPolicy } = mail;
  const { workspaceFor } = access;

  /* TOTP enrolment. Beginning (or re-beginning) stores an unverified secret
     that changes nothing about login until a code proves the authenticator
     has it; verification activates the factor and hands over the backup
     codes exactly once. Session auth only: an API token must not be able to
     rotate the account's second factor. */
  api.post("/users/me/totp", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    if (user.totpVerifiedAt)
      throw errors.validation(
        "Two-factor is already on. Turn it off before re-enrolling.",
      );
    const secret = generateTotpSecret();
    await env.db
      .update(users)
      .set({ totpSecret: secret, totpVerifiedAt: null })
      .where(eq(users.id, user.id))
      .run();
    return c.json({ secret, otpauth_url: otpauthUrl(secret, user.email) }, 201);
  });

  api.post("/users/me/totp/verify", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    await hitRateLimit(`totp_manage:${user.id}`, 10, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.totpCode);
    if (!user.totpSecret || user.totpVerifiedAt)
      throw errors.validation("There is no enrolment waiting for a code.");
    if (!(await verifyTotp(user.totpSecret, body.code, env.clock.now())))
      throw errors.validation("That code does not match. Try the next one.");
    const backupCodes = generateBackupCodes();
    const hashed = await Promise.all(
      backupCodes.map((code) => sha256Hex(code)),
    );
    await env.db
      .update(users)
      .set({
        totpVerifiedAt: env.clock.now(),
        totpBackupCodesJson: JSON.stringify(hashed),
      })
      .where(eq(users.id, user.id))
      .run();
    await audit(
      user.workspaceId,
      user.id,
      "user.totp_enabled",
      `user:${user.id}`,
    );
    return c.json({ backup_codes: backupCodes });
  });

  api.delete("/users/me/totp", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    await hitRateLimit(`totp_manage:${user.id}`, 10, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.totpCode);
    if (!user.totpSecret || !user.totpVerifiedAt)
      throw errors.validation("Two-factor is not on.");
    let passed = await verifyTotp(user.totpSecret, body.code, env.clock.now());
    if (!passed && /^[A-Za-z2-7]{10}$/.test(body.code.trim())) {
      const stored = JSON.parse(user.totpBackupCodesJson) as string[];
      passed = stored.includes(await sha256Hex(body.code.trim().toUpperCase()));
    }
    if (!passed)
      throw errors.validation("Turning two-factor off needs a valid code.");
    await env.db
      .update(users)
      .set({
        totpSecret: null,
        totpVerifiedAt: null,
        totpBackupCodesJson: "[]",
      })
      .where(eq(users.id, user.id))
      .run();
    await audit(
      user.workspaceId,
      user.id,
      "user.totp_disabled",
      `user:${user.id}`,
    );
    return c.body(null, 204);
  });

  api.put("/users/me/avatar", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (!env.blobStore)
      throw errors.internal("Blob storage is not configured.");
    const contentType =
      (c.req.header("content-type") ?? "").split(";")[0] ?? "";
    const extension = AVATAR_TYPES[contentType];
    if (!extension)
      throw errors.validation("The avatar must be a PNG, JPEG, or WebP.");
    const bytes = await readBodyBytes(c, AVATAR_MAX_BYTES);
    if (bytes.byteLength === 0) throw errors.validation("The avatar is empty.");
    // One key per user and format; a format change strands the old blob,
    // which the GC reconciliation is for.
    const key = `avatars/${user.id}.${extension}`;
    await env.blobStore.putStream(
      key,
      new Response(bytes).body as ReadableStream,
      {
        contentType,
        size: bytes.byteLength,
      },
    );
    const now = env.clock.now();
    await env.db
      .update(users)
      .set({ avatarKey: key, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    return c.json({
      avatar_url: `/api/v1/users/${user.id}/avatar?v=${String(now)}`,
    });
  });

  api.delete("/users/me/avatar", requireAuth, async (c) => {
    const user = userFromContext(c);
    await deleteBlobQuietly(user.avatarKey);
    await env.db
      .update(users)
      .set({ avatarKey: null, updatedAt: env.clock.now() })
      .where(eq(users.id, user.id))
      .run();
    return c.body(null, 204);
  });

  api.get("/users/:id/avatar", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, c.req.param("id")),
            eq(users.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound();
    return userAvatarResponse(target);
  });

  api.get("/users", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const rows = await env.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.workspaceId, user.workspaceId),
          cursor ? lt(users.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(users.id))
      .limit(limit + 1)
      .all();
    return c.json(pageResult(rows, limit, userWire));
  });

  api.get("/users/me", requireAuth, (c) =>
    c.json(userWire(userFromContext(c))),
  );

  api.patch("/users/me", requireAuth, async (c) => {
    const user = userFromContext(c);
    const body = await jsonBody(c, bodies.usersMePatch);
    const update: {
      name?: string;
      email?: string;
      passwordHash?: string;
      updatedAt: number;
    } = { updatedAt: env.clock.now() };
    if (body.name) update.name = body.name.trim();
    if (body.email) {
      /* The address is the credential's name, so changing it takes the
         credential. SSO accounts have no password and keep the address the
         identity provider asserts. */
      if (c.get("authType") !== "session") throw errors.forbidden();
      if (!user.passwordHash)
        throw errors.validation(
          "This account signs in through SSO; its address belongs to the identity provider.",
        );
      if (!(await env.hasher.verify(body.email.password, user.passwordHash)))
        throw errors.invalidCredentials();
      const nextEmail = body.email.value.trim().toLowerCase();
      if (nextEmail !== user.email) {
        const taken = (
          await env.db
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.workspaceId, user.workspaceId),
                eq(users.email, nextEmail),
                ne(users.id, user.id),
              ),
            )
            .limit(1)
            .all()
        )[0];
        if (taken)
          throw errors.validation(
            "That address already belongs to another account here.",
          );
        update.email = nextEmail;
        await audit(
          user.workspaceId,
          user.id,
          "user.email_changed",
          `user:${user.id}`,
          { from: user.email, to: nextEmail },
        );
      }
    }
    if (body.password) {
      assertPassword(body.password.new);
      if (
        user.passwordHash &&
        !(await env.hasher.verify(body.password.current, user.passwordHash))
      )
        throw errors.invalidCredentials();
      update.passwordHash = await env.hasher.hash(body.password.new);
      const sessionToken = getCookie(c, SESSION_COOKIE);
      if (sessionToken)
        await env.db
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, user.id),
              ne(sessions.tokenHash, await sha256Hex(sessionToken)),
            ),
          )
          .run();
    }
    await env.db.update(users).set(update).where(eq(users.id, user.id)).run();
    const updated = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(user.workspaceId, user.id, "user.update", `user:${user.id}`);
    return c.json(userWire(updated));
  });

  /* Deactivation, self-service: the account stops signing in and its
     sessions and API tokens die, but the rows stay -- notes keep their
     author, and an admin can re-enable from Members. The last active admin
     cannot deactivate; a workspace must always have someone with the keys. */
  api.delete("/users/me", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (c.get("authType") !== "session") throw errors.forbidden();
    const body = await jsonBody(c, bodies.usersMeDelete);
    if (!user.passwordHash)
      throw errors.validation(
        "This account signs in through SSO; ask an admin to disable it.",
      );
    if (!(await env.hasher.verify(body.password, user.passwordHash)))
      throw errors.invalidCredentials();
    if (user.totpVerifiedAt && user.totpSecret) {
      const code = (body.code ?? "").trim();
      let passed = await verifyTotp(user.totpSecret, code, env.clock.now());
      if (!passed && /^[A-Za-z2-7]{10}$/.test(code)) {
        const stored = JSON.parse(user.totpBackupCodesJson) as string[];
        passed = stored.includes(await sha256Hex(code.toUpperCase()));
      }
      if (!passed)
        throw errors.validation(
          "Deactivating this account needs a two-factor code.",
        );
    }
    if (user.role === "admin") {
      const otherAdmin = (
        await env.db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.workspaceId, user.workspaceId),
              eq(users.role, "admin"),
              isNull(users.disabledAt),
              ne(users.id, user.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!otherAdmin)
        throw errors.validation(
          "You are the last active admin; the workspace needs one.",
        );
    }
    const now = env.clock.now();
    await env.db
      .update(users)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    await env.db.delete(sessions).where(eq(sessions.userId, user.id)).run();
    await env.db.delete(apiTokens).where(eq(apiTokens.userId, user.id)).run();
    await audit(
      user.workspaceId,
      user.id,
      "user.deactivated_self",
      `user:${user.id}`,
    );
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  api.patch("/users/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.userPatch);
    const targetId = c.req.param("id");
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(eq(users.id, targetId), eq(users.workspaceId, actor.workspaceId)),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound();
    if (
      ((body.role !== undefined && body.role !== "admin") ||
        body.disabled === true) &&
      target.role === "admin"
    ) {
      const admins = await env.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.workspaceId, actor.workspaceId),
            eq(users.role, "admin"),
            isNull(users.disabledAt),
          ),
        )
        .all();
      if (admins.length <= 1)
        throw errors.conflict(
          "The last administrator cannot be demoted or disabled.",
        );
    }
    await env.db
      .update(users)
      .set({
        ...(body.role
          ? {
              role: body.role === "guest" ? ("member" as const) : body.role,
              guest: body.role === "guest",
            }
          : {}),
        ...(body.disabled === undefined
          ? {}
          : { disabledAt: body.disabled ? env.clock.now() : null }),
        updatedAt: env.clock.now(),
      })
      .where(eq(users.id, target.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, target.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      actor.workspaceId,
      actor.id,
      body.disabled ? "user.disable" : "user.update",
      `user:${target.id}`,
    );
    return c.json(userWire(updated));
  });

  api.delete("/users/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const targetId = c.req.param("id");
    if (targetId === actor.id)
      throw errors.conflict("You cannot delete your own account.");
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(eq(users.id, targetId), eq(users.workspaceId, actor.workspaceId)),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound();
    if (target.role === "admin") {
      const admins = await env.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.workspaceId, actor.workspaceId),
            eq(users.role, "admin"),
            isNull(users.disabledAt),
          ),
        )
        .all();
      if (admins.length <= 1)
        throw errors.conflict("The last administrator cannot be deleted.");
    }
    const created = await env.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.createdBy, target.id))
      .limit(1)
      .all();
    const invited = await env.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.invitedBy, target.id))
      .limit(1)
      .all();
    if (created.length || invited.length)
      throw errors.conflict(
        "This user is referenced by project or invite records. Disable the user instead.",
      );
    /* Free the avatar before the row goes: the avatar-delete route frees it,
       but user delete did not, leaking one blob per deleted user. */
    await deleteBlobQuietly(target.avatarKey);
    await env.db.delete(users).where(eq(users.id, target.id)).run();
    await audit(
      actor.workspaceId,
      actor.id,
      "user.delete",
      `user:${target.id}`,
    );
    return c.body(null, 204);
  });

  api.post("/invites", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.inviteCreate);
    const email = body.email.trim().toLowerCase();
    const existingUser = await env.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.workspaceId, actor.workspaceId), eq(users.email, email)),
      )
      .limit(1)
      .all();
    if (existingUser.length)
      throw errors.conflict("A user with that email already exists.");
    const projectGrants = body.project_grants ?? [];
    const projectsForGrant = projectGrants.length
      ? await env.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.workspaceId, actor.workspaceId))
          .all()
      : [];
    if (projectsForGrant.length !== projectGrants.length) {
      const valid = new Set(
        projectsForGrant.map((project: { id: string }) => project.id),
      );
      if (projectGrants.some((grant) => !valid.has(grant.project_id)))
        throw errors.validation(
          "Every project grant must reference a project in this workspace.",
        );
    }
    const pending = await env.db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, actor.workspaceId),
          eq(invites.email, email),
          isNull(invites.acceptedAt),
        ),
      )
      .limit(1)
      .all();
    if (pending.length)
      throw errors.conflict("An invite for that email is already pending.");
    const rawToken = `oli_${base64UrlEncode(randomBytes(24))}`;
    const now = env.clock.now();
    const inviteId = env.ids.ulid();
    await env.db
      .insert(invites)
      .values({
        id: inviteId,
        workspaceId: actor.workspaceId,
        email,
        /* Guests are stored as members plus the flag; the wire speaks the
           three-role vocabulary (see the users schema note). */
        role: body.role === "guest" ? "member" : body.role,
        guest: body.role === "guest",
        tokenHash: await sha256Hex(rawToken),
        invitedBy: actor.id,
        projectGrantsJson: JSON.stringify(projectGrants),
        createdAt: now,
        expiresAt: now + days(7),
        acceptedAt: null,
      })
      .run();
    await audit(
      actor.workspaceId,
      actor.id,
      "invite.create",
      `invite:${inviteId}`,
    );
    const acceptUrl = `${env.config.PUBLIC_URL.replace(/\/$/, "")}/invite/${rawToken}`;
    /* The invitation goes to the invitee when the transport works and the
       policy allows; the link stays in the response either way, because
       the admin may be the delivery channel. */
    let emailed = false;
    if (mailControl && (await mailStatus()).state === "ready") {
      const policy = await readMailPolicy();
      if (policy.invites) {
        const workspace = await workspaceFor(actor.workspaceId);
        try {
          await mailControl.send({
            to: email,
            ...renderEmail({
              subject: `${actor.name} invited you to ${workspace?.name ?? "Onelight"}`,
              preheader: `Review work with ${actor.name}. The invitation is good for seven days.`,
              heading: `${actor.name} invited you to ${workspace?.name ?? "Onelight"}`,
              intro:
                "Onelight is where this team reviews cuts, stills and deliveries: you watch the actual file, leave notes on the frame, and approve when it is right.",
              ...(workspace?.name ? { workspace: workspace.name } : {}),
              sections: [],
              action: { label: "Create your account", href: acceptUrl },
              footer: [
                "The invitation is good for seven days. It only works for this address.",
                "If you were not expecting it, you can ignore it and nothing happens.",
              ],
            }),
          });
          emailed = true;
        } catch {
          /* Undeliverable is not a failed invite: the link still works. */
        }
      }
    }
    return c.json(
      {
        invite: {
          id: inviteId,
          email,
          role: body.role,
          project_grants: projectGrants,
          invited_by: actor.id,
          created_at: now,
          expires_at: now + days(7),
        },
        accept_url: acceptUrl,
        emailed,
      },
      201,
    );
  });

  api.get("/invites", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const now = env.clock.now();
    const rows = await env.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, actor.workspaceId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
          cursor ? lt(invites.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(invites.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(rows, limit, (invite: typeof invites.$inferSelect) => ({
        id: invite.id,
        email: invite.email,
        role: invite.guest ? "guest" : invite.role,
        project_grants: JSON.parse(invite.projectGrantsJson),
        invited_by: invite.invitedBy,
        created_at: invite.createdAt,
        expires_at: invite.expiresAt,
      })),
    );
  });

  api.delete("/invites/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const invite = (
      await env.db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.id, c.req.param("id")),
            eq(invites.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!invite) throw errors.notFound();
    await env.db.delete(invites).where(eq(invites.id, invite.id)).run();
    await audit(
      actor.workspaceId,
      actor.id,
      "invite.revoke",
      `invite:${invite.id}`,
    );
    return c.body(null, 204);
  });

  const inviteByToken = async (token: string) => {
    const rows = await env.db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, await sha256Hex(token)))
      .limit(1)
      .all();
    const invite = rows[0];
    if (!invite || invite.acceptedAt || invite.expiresAt <= env.clock.now())
      throw errors.notFound("Invite is expired or no longer available.");
    return invite;
  };

  api.post("/invites/lookup", async (c) => {
    const ip = clientIp(c, env);
    await hitRateLimit(`invite_lookup:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.inviteLookup);
    const invite = await inviteByToken(body.token);
    const workspace = await workspaceFor(invite.workspaceId);
    return c.json({ email: invite.email, workspace_name: workspace.name });
  });

  api.post("/invites/accept", async (c) => {
    const ip = clientIp(c, env);
    await hitRateLimit(`invite_accept:${ip}`, 20, 5 * 60 * 1000);
    const body = await jsonBody(c, bodies.inviteAccept);
    assertPassword(body.password);
    const invite = await inviteByToken(body.token);
    const existing = await env.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, invite.workspaceId),
          eq(users.email, invite.email),
        ),
      )
      .limit(1)
      .all();
    if (existing.length)
      throw errors.conflict("An account already exists for this invite email.");
    const now = env.clock.now();
    const userId = env.ids.ulid();
    await env.db
      .insert(users)
      .values({
        id: userId,
        workspaceId: invite.workspaceId,
        email: invite.email,
        name: body.name.trim(),
        role: invite.role,
        guest: invite.guest,
        passwordHash: await env.hasher.hash(body.password),
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const grants = JSON.parse(invite.projectGrantsJson) as Array<{
      project_id: string;
      role: "manager" | "editor" | "commenter" | "viewer";
    }>;
    for (const grant of grants) {
      await env.db
        .insert(projectMembers)
        .values({
          projectId: grant.project_id,
          userId,
          role: grant.role,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    await env.db
      .update(invites)
      .set({ acceptedAt: now })
      .where(eq(invites.id, invite.id))
      .run();
    await audit(
      invite.workspaceId,
      userId,
      "invite.accept",
      `invite:${invite.id}`,
    );
    const user = (
      await env.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .all()
    )[0];
    if (!user) throw errors.internal();
    c.set("user", user);
    c.set("authType", "session");
    await createSession(env, userId, c);
    return c.json({ user: userWire(user) }, 201);
  });
};
