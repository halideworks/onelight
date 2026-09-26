import { requireAuth } from "../auth.js";
import {
  userFromContext,
  getLimit,
  cursorParam,
  parseJsonObject,
  jsonBody,
} from "../helpers.js";
import {
  assetVersions,
  assets,
  projects,
  notifications,
  notificationPreferences,
} from "@onelight/db/schema";
import { eq, and, isNull, desc, lt, or, sql, isNotNull } from "drizzle-orm";
import { bodies } from "../schemas.js";
import { errors, unsubscribeSubject } from "@onelight/core";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Activity } from "../operation/activity.js";
import { pageResult } from "../wire.js";

export const registerNotificationsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  { activity }: { activity: Activity },
) => {
  const { createNotifications, projectManagerIds } = activity;

  api.get("/notifications", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    // Transcode failures are recorded by the out-of-process worker pump,
    // which sets transcode_status='failed' but writes no notification rows.
    // On the first read that observes a newly failed version in the actor's
    // workspace, materialize real notification rows ONCE for the uploader and
    // current managers, then stamp failure_notified_at so the work never
    // repeats (no per-request json_extract scan). The scan is index-served
    // (asset_versions_failed_idx) and failed versions are rare.
    const newlyFailed = await env.db
      .select({ version: assetVersions, asset: assets })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          eq(assetVersions.transcodeStatus, "failed"),
          isNull(assetVersions.failureNotifiedAt),
          isNull(assets.deletedAt),
          isNull(assetVersions.deletedAt),
        ),
      )
      .orderBy(desc(assetVersions.id))
      .limit(100)
      .all();
    for (const row of newlyFailed as Array<{
      version: typeof assetVersions.$inferSelect;
      asset: typeof assets.$inferSelect;
    }>) {
      await createNotifications({
        projectId: row.asset.projectId,
        actorUserId: null,
        recipients: [
          row.version.uploadedBy,
          ...(await projectManagerIds(row.asset.projectId)),
        ],
        kind: "transcode.failed",
        payload: {
          project_id: row.asset.projectId,
          asset_id: row.asset.id,
          asset_name: row.asset.name,
          version_id: row.version.id,
          /* Why, where the worker managed to say why: the difference between
             a message somebody can act on and one they forward to support. */
          ...(row.version.transcodeError
            ? { reason: row.version.transcodeError }
            : {}),
          preview: `Transcode failed for ${row.asset.name}`,
        },
      });
      await env.db
        .update(assetVersions)
        .set({ failureNotifiedAt: env.clock.now() })
        .where(eq(assetVersions.id, row.version.id))
        .run();
    }
    const rows = await env.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, actor.id),
          cursor ? lt(notifications.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(
        rows,
        limit,
        (notification: typeof notifications.$inferSelect) => ({
          id: notification.id,
          kind: notification.kind,
          payload: parseJsonObject(notification.payloadJson),
          read_at: notification.readAt,
          created_at: notification.createdAt,
        }),
      ),
    );
  });

  api.post("/notifications/read", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.notificationsRead);
    /* Either a list of rows, or a whole project. The project form exists
       because clearing a badge from a list of ids only clears the ids the
       browser had, and the badge counts everything: the two disagreed, so the
       count came back the moment anything reloaded. */
    const scope =
      body.project_id === undefined
        ? or(...(body.ids ?? []).map((id) => eq(notifications.id, id)))
        : eq(notifications.projectId, body.project_id);
    if (!scope) throw errors.validation("Nothing to mark read.");
    await env.db
      .update(notifications)
      .set({ readAt: env.clock.now() })
      .where(
        and(
          eq(notifications.userId, actor.id),
          isNull(notifications.readAt),
          scope,
        ),
      )
      .run();
    return c.body(null, 204);
  });

  /* Unread per project, counted. This is what the badges on the projects list
     are drawn from; the whole point is that it does not depend on how much of
     the notification list the browser has fetched. */
  api.get("/notifications/badges", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const rows = await env.db
      .select({
        projectId: notifications.projectId,
        unread: sql<number>`count(*)`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, actor.id),
          isNull(notifications.readAt),
          isNotNull(notifications.projectId),
        ),
      )
      .groupBy(notifications.projectId)
      .all();
    return c.json({
      total: rows.reduce((sum, row) => sum + Number(row.unread), 0),
      projects: rows.map((row) => ({
        project_id: row.projectId as string,
        unread: Number(row.unread),
      })),
    });
  });

  api.get("/notifications/preferences", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const existing = (
      await env.db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, actor.id))
        .limit(1)
        .all()
    )[0];
    return c.json(
      existing
        ? {
            mode: existing.mode,
            kind_modes: parseJsonObject(existing.kindModesJson),
            digest_hour: existing.digestHour,
            utc_offset_minutes: existing.utcOffsetMinutes,
            muted_projects: JSON.parse(existing.mutedProjectsJson),
          }
        : {
            mode: "instant",
            kind_modes: {},
            digest_hour: 8,
            utc_offset_minutes: 0,
            muted_projects: [],
          },
    );
  });

  api.patch("/notifications/preferences", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const body = await jsonBody(c, bodies.notificationPreferencesPatch);
    const values = {
      mode: body.mode,
      kindModesJson: JSON.stringify(body.kind_modes),
      digestHour: body.digest_hour,
      utcOffsetMinutes: body.utc_offset_minutes,
      mutedProjectsJson: JSON.stringify(body.muted_projects),
      updatedAt: env.clock.now(),
    };
    await env.db
      .insert(notificationPreferences)
      .values({ userId: actor.id, ...values })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: values,
      })
      .run();
    return c.json({
      mode: body.mode,
      kind_modes: body.kind_modes,
      digest_hour: body.digest_hour,
      utc_offset_minutes: body.utc_offset_minutes,
      muted_projects: body.muted_projects,
    });
  });

  /* One click, no session.

     Gmail and Outlook render their own unsubscribe control when a message
     carries List-Unsubscribe plus List-Unsubscribe-Post, and they POST to the
     URL with no cookies at all. Somebody who cannot find an unsubscribe reports
     the message as spam instead, and that is what actually damages delivery for
     everybody else on the instance.

     So the authority is a signed token naming the user, not a session, and the
     only thing it can do is turn email off. Notifications keep arriving in the
     app: unsubscribing from mail is not resigning from the project. */
  api.post("/notifications/unsubscribe", async (c) => {
    const token = c.req.query("t") ?? "";
    const userId = await unsubscribeSubject(env.config.SECRET_KEY, token);
    if (!userId) throw errors.forbidden("That unsubscribe link is not valid.");
    const now = env.clock.now();
    await env.db
      .insert(notificationPreferences)
      .values({ userId, mode: "off", updatedAt: now })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: { mode: "off", updatedAt: now },
      })
      .run();
    return c.body(null, 204);
  });
};
