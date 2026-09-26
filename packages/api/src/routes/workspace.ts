import { requireAuth } from "../auth.js";
import {
  parseJsonObject,
  userFromContext,
  jsonBody,
  getLimit,
  cursorParam,
} from "../helpers.js";
import {
  errors,
  parseSmtpConfig,
  mailSettingsToInput,
  isSmtpConfigError,
  seal,
  base64UrlEncode,
  randomBytes,
} from "@onelight/core";
import {
  projects,
  assets,
  assetVersions,
  renditions,
  jobs,
  exportJobs,
  webhookDeliveries,
  webhooks,
  appSettings,
  workspaces,
  auditLog,
} from "@onelight/db/schema";
import { eq, sql, and, isNull, lt, desc, isNotNull } from "drizzle-orm";
import { bodies } from "../schemas.js";
import type { StoredMailSettings } from "@onelight/core";
import { assertWebhookUrlAllowed } from "../webhooks.js";
import type { AppEnv, ApiRouter } from "../types.js";
import type { Access } from "../operation/access.js";
import type { Mail } from "../operation/mail.js";
import type { Activity } from "../operation/activity.js";
import { jobWire, pageResult } from "../wire.js";

export const registerWorkspaceRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    access,
    mail,
    activity,
  }: { access: Access; mail: Mail; activity: Activity },
) => {
  const { currentWorkspace, requireProject } = access;
  const {
    mailStatus,
    mailControl,
    mailSettingsResponse,
    readMailPolicy,
    writeMailPolicy,
    readStoredMail,
    MAIL_SETTINGS_KEY,
  } = mail;
  const { audit } = activity;

  api.get("/workspace", requireAuth, async (c) => {
    const workspace = await currentWorkspace(c);
    return c.json({
      id: workspace.id,
      name: workspace.name,
      settings: parseJsonObject(workspace.settingsJson),
      oidc_enabled: Boolean(env.config.OIDC_ISSUER),
    });
  });

  // What the workspace weighs on disk, summed from the sizes the DB already
  // tracks -- no blob walk, so it answers instantly at any library size.
  // Originals include trashed assets, whose bytes stay on disk until the
  // purge sweep collects them; asset_count is live assets only.
  api.get("/workspace/usage", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const projectRows = await env.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.workspaceId, actor.workspaceId))
      .all();
    const originalRows = await env.db
      .select({
        projectId: assets.projectId,
        bytes: sql<number>`coalesce(sum(${assetVersions.size}), 0)`,
        versions: sql<number>`count(*)`,
      })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(eq(projects.workspaceId, actor.workspaceId))
      .groupBy(assets.projectId)
      .all();
    const renditionRows = await env.db
      .select({
        projectId: assets.projectId,
        bytes: sql<number>`coalesce(sum(${renditions.size}), 0)`,
      })
      .from(renditions)
      .innerJoin(assetVersions, eq(renditions.versionId, assetVersions.id))
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(eq(projects.workspaceId, actor.workspaceId))
      .groupBy(assets.projectId)
      .all();
    const assetRows = await env.db
      .select({
        projectId: assets.projectId,
        count: sql<number>`count(*)`,
      })
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          isNull(assets.deletedAt),
        ),
      )
      .groupBy(assets.projectId)
      .all();
    const originalsBy = new Map(
      originalRows.map((row) => [row.projectId, row]),
    );
    const renditionsBy = new Map(
      renditionRows.map((row) => [row.projectId, row.bytes]),
    );
    const assetsBy = new Map(
      assetRows.map((row) => [row.projectId, row.count]),
    );
    const perProject = projectRows.map((project) => ({
      id: project.id,
      name: project.name,
      originals_bytes: originalsBy.get(project.id)?.bytes ?? 0,
      renditions_bytes: renditionsBy.get(project.id) ?? 0,
      asset_count: assetsBy.get(project.id) ?? 0,
      version_count: originalsBy.get(project.id)?.versions ?? 0,
    }));
    return c.json({
      totals: {
        originals_bytes: perProject.reduce(
          (sum, row) => sum + row.originals_bytes,
          0,
        ),
        renditions_bytes: perProject.reduce(
          (sum, row) => sum + row.renditions_bytes,
          0,
        ),
        asset_count: perProject.reduce((sum, row) => sum + row.asset_count, 0),
        version_count: perProject.reduce(
          (sum, row) => sum + row.version_count,
          0,
        ),
      },
      // Null on object storage, where capacity is not a meaningful number.
      disk: env.diskInfo ? await env.diskInfo() : null,
      projects: perProject,
    });
  });

  /* One admin page's worth of operational truth: version and uptime, the
     database and its snapshots, blob capacity, and every queue's depth. The
     host-only facts (db size, backups) come through env.systemInfo and are
     null where the host cannot know them (Workers). */
  api.get("/admin/system", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const countBy = <T extends string>(
      rows: Array<{ status: T; count: number }>,
    ): Record<string, number> =>
      Object.fromEntries(rows.map((row) => [row.status, row.count]));
    const jobRows = await env.db
      .select({ status: jobs.status, count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        sql`json_extract(${jobs.payloadJson}, '$.workspace_id') = ${actor.workspaceId}`,
      )
      .groupBy(jobs.status)
      .all();
    const exportRows = await env.db
      .select({ status: exportJobs.status, count: sql<number>`count(*)` })
      .from(exportJobs)
      .where(eq(exportJobs.workspaceId, actor.workspaceId))
      .groupBy(exportJobs.status)
      .all();
    const deliveryRows = await env.db
      .select({
        status: webhookDeliveries.status,
        count: sql<number>`count(*)`,
      })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .where(eq(webhooks.workspaceId, actor.workspaceId))
      .groupBy(webhookDeliveries.status)
      .all();
    const host = env.systemInfo
      ? await env.systemInfo()
      : { db_size_bytes: null, backups: null };
    return c.json({
      version: env.version,
      started_at: env.startedAt ?? null,
      db_size_bytes: host.db_size_bytes,
      backups: host.backups,
      disk: env.diskInfo ? await env.diskInfo() : null,
      mail: await mailStatus(),
      media_jobs: countBy(jobRows),
      export_jobs: countBy(exportRows),
      webhook_deliveries: countBy(deliveryRows),
    });
  });

  /* What the server is ACTUALLY running with, subsystem by subsystem.
     Compose passes only the keys it names, so an operator can set a variable,
     read it back from their own .env, and still be looking at a feature that
     never turned on. This answers "is it on, and if not, what is missing"
     without anyone reading container logs. Values are reported; secrets are
     reported only as set or unset, because the question is never what the
     client secret is. */
  api.get("/admin/system/config", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const report = env.effectiveConfig?.();
    if (!report)
      return c.json({
        available: false,
        scope: null,
        subsystems: [],
        issues: [],
      });

    /* Mail is the one subsystem the environment does not decide. Stored admin
       settings take precedence over it, so the report has to defer to the same
       resolution the mail card uses, or one page states two things: a working
       stored transport would read as inactive because no SMTP_* is set, and a
       broken stored one would read as active because the environment is fine.
       The source travels with it so the variables below make sense. */
    const mail = await mailStatus();
    /* Every name a mail complaint can be filed under: the variables
       themselves, plus the group's own name. */
    const mailNames = new Set<string>([
      "mail",
      ...(report.subsystems
        .find((subsystem) => subsystem.name === "mail")
        ?.vars.map((entry) => entry.name) ?? []),
    ]);
    const mailDetail =
      mail.source === "settings"
        ? mail.state === "ready"
          ? "Active from the admin mail settings, which take precedence over these variables."
          : (mail.detail ??
            "The stored mail settings are in use and cannot send.")
        : mail.detail;

    return c.json({
      available: true,
      scope: report.scope,
      subsystems: report.subsystems.map((subsystem) => ({
        name: subsystem.name,
        title: subsystem.title,
        active:
          subsystem.name === "mail" ? mail.state === "ready" : subsystem.active,
        detail:
          subsystem.name === "mail"
            ? (mailDetail ?? subsystem.detail)
            : subsystem.detail,
        vars: subsystem.vars.map((entry) => ({
          name: entry.name,
          set: entry.set,
          source: entry.source,
          value: entry.value,
          secret: entry.secret,
          summary: entry.summary,
          /* An unused environment value cannot be what is wrong: with stored
             settings in force, SMTP_PORT=oops is a stale line nobody reads,
             and flagging it warns that a working transport is broken. */
          issue:
            mail.source === "settings" && mailNames.has(entry.name)
              ? null
              : (entry.issue ?? null),
        })),
      })),
      /* Environment-derived mail complaints are dropped once the stored
         settings are what the server actually uses. Otherwise the page shows
         "set MAIL_FROM or email stays disabled" as an alert directly above a
         mail subsystem it just reported as active, and both cannot be true. */
      issues: report.issues
        .filter(
          (issue) => !(mail.source === "settings" && mailNames.has(issue.name)),
        )
        .map((issue) => ({ name: issue.name, message: issue.message })),
    });
  });

  /* A test email is the only way an operator can tell a configured
     transport from a working one without waiting for a notification to
     fail silently. It goes to the caller's own address on purpose: the
     admin pressing the button is the person watching the inbox. */
  api.post("/admin/system/test-email", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const status = await mailStatus();
    if (!mailControl || status.state !== "ready")
      throw errors.conflict(
        status.state === "error" && status.detail
          ? `Email is misconfigured: ${status.detail}`
          : "Email is not configured: set it up under Settings, or set SMTP_URL plus MAIL_FROM in the environment.",
      );
    try {
      await mailControl.send({
        to: actor.email,
        subject: "Onelight test email",
        text: [
          "This is a test email from your Onelight instance.",
          "",
          "If you are reading it, outgoing email works.",
        ].join("\n"),
      });
    } catch (caught) {
      throw errors.conflict(
        `The mail transport refused the message: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    return c.json({ sent: true, to: actor.email });
  });

  api.get("/admin/settings/mail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    return mailSettingsResponse(c);
  });

  api.put("/admin/settings/mail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    /* SMTP credentials are as sensitive as a second factor: an API token
       must not be able to redirect the instance's outgoing mail. */
    if (c.get("authType") !== "session") throw errors.forbidden();
    const body = await jsonBody(c, bodies.mailSettingsPut);
    if (body.policy) {
      const prior = await readMailPolicy();
      await writeMailPolicy(
        {
          invites: body.policy.invites ?? prior.invites,
          digests: body.policy.digests ?? prior.digests,
        },
        actor.id,
      );
      /* A policy-only PUT leaves the transport untouched. */
      if (
        body.smtp_url === undefined &&
        body.host === undefined &&
        body.mail_from === undefined &&
        body.port === undefined &&
        body.user === undefined &&
        body.pass === undefined &&
        body.secure === undefined
      ) {
        await audit(
          actor.workspaceId,
          actor.id,
          "settings.mail.update",
          "settings:mail",
        );
        return mailSettingsResponse(c);
      }
    }
    const prior = await readStoredMail();
    const next: StoredMailSettings = {
      smtp_url: body.smtp_url ?? null,
      host: body.host ?? null,
      port: body.port ?? null,
      user: body.user ?? null,
      /* An omitted password keeps the stored one, so editing the host does
         not force retyping the secret; explicit null clears it. */
      pass: body.pass === undefined ? (prior?.pass ?? null) : body.pass,
      secure: body.secure ?? null,
      mail_from: body.mail_from ?? null,
    };
    const parsed = parseSmtpConfig(mailSettingsToInput(next));
    if (parsed === null)
      throw errors.validation(
        "Provide SMTP_URL or SMTP_HOST together with MAIL_FROM; to fall back to the environment, remove the settings instead.",
      );
    if (isSmtpConfigError(parsed)) throw errors.validation(parsed.error);
    const now = env.clock.now();
    /* Sealed on the way in, so what lands in the row -- and therefore in every
       backup and every dump of it -- is not the password an admin typed. The
       config was validated above against the plaintext, because what is being
       checked is whether these settings work. */
    const key = env.config.SECRET_KEY;
    const atRest: StoredMailSettings = {
      ...next,
      pass: next.pass === null ? null : await seal(key, next.pass),
      smtp_url: next.smtp_url === null ? null : await seal(key, next.smtp_url),
    };
    const valueJson = JSON.stringify(atRest);
    await env.db
      .insert(appSettings)
      .values({
        key: MAIL_SETTINGS_KEY,
        valueJson,
        updatedAt: now,
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { valueJson, updatedAt: now, updatedBy: actor.id },
      })
      .run();
    env.mail?.reload();
    await audit(
      actor.workspaceId,
      actor.id,
      "settings.mail.update",
      "settings:mail",
    );
    return mailSettingsResponse(c);
  });

  api.delete("/admin/settings/mail", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    if (c.get("authType") !== "session") throw errors.forbidden();
    await env.db
      .delete(appSettings)
      .where(eq(appSettings.key, MAIL_SETTINGS_KEY))
      .run();
    env.mail?.reload();
    await audit(
      actor.workspaceId,
      actor.id,
      "settings.mail.clear",
      "settings:mail",
    );
    return c.body(null, 204);
  });

  api.patch("/workspace", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.workspacePatch);
    if (body.settings && Object.keys(body.settings).length)
      throw errors.validation(
        "Workspace settings are not available in this phase.",
      );
    await env.db
      .update(workspaces)
      .set({ ...(body.name ? { name: body.name.trim() } : {}) })
      .where(eq(workspaces.id, user.workspaceId))
      .run();
    await audit(
      user.workspaceId,
      user.id,
      "workspace.update",
      `workspace:${user.workspaceId}`,
    );
    const workspace = await currentWorkspace(c);
    return c.json({
      id: workspace.id,
      name: workspace.name,
      settings: parseJsonObject(workspace.settingsJson),
      oidc_enabled: Boolean(env.config.OIDC_ISSUER),
    });
  });

  api.post("/webhooks", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const body = await jsonBody(c, bodies.webhookCreate);
    assertWebhookUrlAllowed(body.url);
    const id = env.ids.ulid();
    const secret = body.secret ?? base64UrlEncode(randomBytes(32));
    await env.db
      .insert(webhooks)
      .values({
        id,
        workspaceId: actor.workspaceId,
        url: body.url,
        secret,
        eventsJson: JSON.stringify(body.events),
        active: true,
        createdAt: env.clock.now(),
      })
      .run();
    return c.json({ id, url: body.url, events: body.events, secret }, 201);
  });

  api.get("/webhooks", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const rows = await env.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.workspaceId, actor.workspaceId))
      .all();
    return c.json({
      items: rows.map((hook: typeof webhooks.$inferSelect) => ({
        id: hook.id,
        url: hook.url,
        events: JSON.parse(hook.eventsJson),
        active: Boolean(hook.active),
        created_at: hook.createdAt,
      })),
    });
  });

  api.delete("/webhooks/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    await env.db
      .delete(webhooks)
      .where(
        and(
          eq(webhooks.id, c.req.param("id")),
          eq(webhooks.workspaceId, actor.workspaceId),
        ),
      )
      .run();
    return c.body(null, 204);
  });

  api.get("/jobs/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const job = (
      await env.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!job) throw errors.notFound();
    const payload = parseJsonObject(job.payloadJson);
    if (payload.workspace_id !== actor.workspaceId) throw errors.notFound();
    /* A job's status and error string belong to whoever can see its project,
       not to the whole workspace: without this a guest could read the state
       and failure message of any job in any project. Jobs that carry a
       project scope are checked against it; the few workspace-level jobs
       (no project_id) stay workspace-scoped as before. */
    if (typeof payload.project_id === "string")
      await requireProject(payload.project_id, actor, "viewer");
    return c.json(jobWire(job));
  });

  api.get("/admin/jobs", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const requestedStatus = c.req.query("status");
    const status =
      requestedStatus &&
      ["queued", "processing", "complete", "failed", "dead"].includes(
        requestedStatus,
      )
        ? (requestedStatus as typeof jobs.$inferSelect.status)
        : undefined;
    if (requestedStatus && !status)
      throw errors.validation("Job status is invalid.");
    const rows = await env.db
      .select()
      .from(jobs)
      .where(
        and(
          // Jobs carry workspace scope in their validated payload (phase-1
          // section 2); without this filter admins would see every
          // workspace's jobs.
          sql`json_extract(${jobs.payloadJson}, '$.workspace_id') = ${actor.workspaceId}`,
          cursor ? lt(jobs.id, cursor) : undefined,
          status ? eq(jobs.status, status) : undefined,
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(rows, limit, (job: typeof jobs.$inferSelect) => jobWire(job)),
    );
  });

  /* What is in the trash, workspace-wide: names and when, for the restore
     button. The purge sweep keeps this bounded. */
  api.get("/trash", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const rows = (await env.db
      .select({ asset: assets, projectName: projects.name })
      .from(assets)
      .innerJoin(projects, eq(assets.projectId, projects.id))
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          isNotNull(assets.deletedAt),
        ),
      )
      .orderBy(desc(assets.deletedAt))
      .limit(500)
      .all()) as Array<{
      asset: typeof assets.$inferSelect;
      projectName: string;
    }>;
    return c.json({
      items: rows.map((row) => ({
        id: row.asset.id,
        name: row.asset.name,
        kind: row.asset.kind,
        project_id: row.asset.projectId,
        project_name: row.projectName,
        deleted_at: row.asset.deletedAt,
      })),
    });
  });

  api.get("/audit", requireAuth, async (c) => {
    const actor = userFromContext(c);
    if (actor.role !== "admin") throw errors.forbidden();
    const limit = getLimit(c.req.query("limit"));
    const cursor = cursorParam(c.req.query("cursor"));
    const action = c.req.query("action");
    const rows = await env.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, actor.workspaceId),
          action ? eq(auditLog.action, action) : undefined,
          cursor ? lt(auditLog.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(limit + 1)
      .all();
    return c.json(
      pageResult(rows, limit, (entry: typeof auditLog.$inferSelect) => ({
        id: entry.id,
        actor_user_id: entry.actorUserId,
        action: entry.action,
        target: entry.target,
        meta: parseJsonObject(entry.metaJson),
        at: entry.at,
      })),
    );
  });
};
