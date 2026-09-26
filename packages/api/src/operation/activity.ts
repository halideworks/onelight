import {
  auditLog,
  projects,
  projectEvents,
  projectMembers,
  notificationPreferences,
  notifications,
  comments,
  assets,
  assetVersions,
  users,
} from "@onelight/db/schema";
import { eq, and, inArray, or, isNull } from "drizzle-orm";
import { scheduleWebhookDeliveries } from "../webhooks.js";
import { parseJsonValue } from "../helpers.js";
import type { AppEnv } from "../types.js";

export const createActivity = (env: AppEnv) => {
  const audit = async (
    workspaceId: string,
    actorUserId: string | null,
    action: string,
    target: string | null,
    meta: unknown = {},
  ) => {
    await env.db
      .insert(auditLog)
      .values({
        id: env.ids.ulid(),
        workspaceId,
        actorUserId,
        action,
        target,
        metaJson: JSON.stringify(meta),
        at: env.clock.now(),
      })
      .run();
  };

  const projectEventWaiters = new Map<string, Set<() => void>>();

  const projectEventEpoch = new Map<string, number>();

  const wakeProjectEventStreams = (projectId: string): void => {
    projectEventEpoch.set(
      projectId,
      (projectEventEpoch.get(projectId) ?? 0) + 1,
    );
    const waiters = projectEventWaiters.get(projectId);
    if (!waiters) return;
    projectEventWaiters.delete(projectId);
    for (const wake of waiters) wake();
  };

  const waitForProjectEvent = (
    projectId: string,
    observedEpoch: number,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        const waiters = projectEventWaiters.get(projectId);
        waiters?.delete(finish);
        if (waiters?.size === 0) projectEventWaiters.delete(projectId);
        resolve();
      };
      const waiters = projectEventWaiters.get(projectId) ?? new Set();
      waiters.add(finish);
      projectEventWaiters.set(projectId, waiters);
      const timeout = setTimeout(finish, 15_000);
      signal.addEventListener("abort", finish, { once: true });
      if (
        signal.aborted ||
        (projectEventEpoch.get(projectId) ?? 0) !== observedEpoch
      )
        finish();
    });

  /**
   * Append a live-update event to the project stream (SSE replay via
   * GET /projects/:id/events) and schedule webhook deliveries for it.
   *
   * Web clients subscribe by these EXACT type strings; keep this list in
   * sync with every emitter:
   *   - "project.created"        {project_id, name}
   *   - "asset.created"          {asset_id, version_id, job_id}
   *   - "asset.version_created"  {asset_id, version_id, version_no, job_id}
   *   - "comment.created"        {comment_id, version_id, frame_in, parent_id?}
   *   - "comment.updated"        {comment_id, version_id, frame_in}
   *   - "comment.deleted"        {comment_id, version_id}
   * Comment payloads stay small on purpose: ids plus version_id/frame_in;
   * clients refetch the comment list for full bodies.
   */
  const appendProjectEvent = async (
    projectId: string,
    type: string,
    data: unknown,
  ) => {
    const project = (
      await env.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all()
    )[0];
    const eventId = env.ids.ulid();
    const now = env.clock.now();
    await env.db
      .insert(projectEvents)
      .values({
        id: eventId,
        projectId,
        type,
        payloadJson: JSON.stringify(data),
        createdAt: now,
      })
      .run();
    wakeProjectEventStreams(projectId);
    if (project)
      await scheduleWebhookDeliveries(
        env.db,
        project.workspaceId,
        eventId,
        type,
        data,
        now,
      );
  };

  /** First 140 characters of a comment body for notification payloads. */
  const notificationPreview = (text: string): string =>
    text.length > 140 ? text.slice(0, 140) : text;

  const projectManagerIds = async (projectId: string): Promise<string[]> =>
    (
      await env.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.role, "manager"),
          ),
        )
        .all()
    ).map((row: { userId: string }) => row.userId);

  /**
   * Insert one notification row per recipient. The actor never notifies
   * themselves and recipients who muted the project are skipped.
   * notification_preferences.mode (instant/hourly/daily) shapes future email
   * digests only; in-app rows are always created regardless of mode.
   */
  const createNotifications = async (options: {
    projectId: string;
    actorUserId: string | null;
    recipients: Iterable<string | null | undefined>;
    kind: string;
    payload: Record<string, unknown>;
  }) => {
    const recipients = new Set<string>();
    for (const candidate of options.recipients)
      if (candidate) recipients.add(candidate);
    if (options.actorUserId) recipients.delete(options.actorUserId);
    if (!recipients.size) return;
    // Re-authorize every recipient against the project's CURRENT visibility.
    // A historical uploader who has since lost access (the project became
    // restricted, or they were removed or disabled) must never receive a row
    // carrying a content preview. Managers are already live-derived, but this
    // filter also covers them idempotently.
    const authorized = new Set(
      await visibleMentionIds(options.projectId, [...recipients]),
    );
    for (const userId of [...recipients])
      if (!authorized.has(userId)) recipients.delete(userId);
    if (!recipients.size) return;
    const prefRows = await env.db
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, [...recipients]))
      .all();
    const mutedByUser = new Map<string, string[]>(
      prefRows.map((row: typeof notificationPreferences.$inferSelect) => {
        const parsed = parseJsonValue(row.mutedProjectsJson);
        return [
          row.userId,
          Array.isArray(parsed) ? (parsed as string[]) : [],
        ] as const;
      }),
    );
    const now = env.clock.now();
    /* Which job this is about, put in once here rather than at each of the
       call sites that would have to remember. It is the first thing a person
       reading a notification needs and the mail had no way to say it: every
       message about every project looked the same in an inbox. */
    const named = options.payload.project_name
      ? options.payload
      : {
          ...options.payload,
          project_name:
            (
              await env.db
                .select({ name: projects.name })
                .from(projects)
                .where(eq(projects.id, options.projectId))
                .limit(1)
                .all()
            )[0]?.name ?? "",
        };
    const payloadJson = JSON.stringify(named);
    // One multi-row insert instead of a round trip per recipient.
    const values = [];
    for (const userId of recipients) {
      if (mutedByUser.get(userId)?.includes(options.projectId)) continue;
      values.push({
        id: env.ids.ulid(),
        userId,
        kind: options.kind,
        /* As a column, so the badge on a project card is a counted answer
           rather than whatever the browser had loaded. */
        projectId: options.projectId,
        payloadJson,
        readAt: null,
        createdAt: now,
      });
    }
    if (values.length) await env.db.insert(notifications).values(values).run();
  };

  /** Distinct registered-user authors of a thread (parent plus replies). */
  const threadParticipantIds = async (parentId: string): Promise<string[]> => {
    const rows = await env.db
      .select({ authorUserId: comments.authorUserId })
      .from(comments)
      .where(
        and(
          or(eq(comments.id, parentId), eq(comments.parentId, parentId)),
          isNull(comments.deletedAt),
        ),
      )
      .all();
    return [
      ...new Set(
        rows
          .map((row: { authorUserId: string | null }) => row.authorUserId)
          .filter((id: string | null): id is string => Boolean(id)),
      ),
    ];
  };

  /** The owning project id of a version, for event emission. */
  const projectIdForVersion = async (
    versionId: string,
  ): Promise<string | undefined> => {
    const rows = await env.db
      .select({ projectId: assets.projectId })
      .from(assetVersions)
      .innerJoin(assets, eq(assetVersions.assetId, assets.id))
      .where(eq(assetVersions.id, versionId))
      .limit(1)
      .all();
    return rows[0]?.projectId;
  };

  /**
   * Mentioned user ids that can actually see the project: enabled workspace
   * users for non-restricted projects; members and workspace admins for
   * restricted ones. Ids that fail the check are dropped silently (the
   * comment itself is never rejected over a bad mention).
   */
  const visibleMentionIds = async (
    projectId: string,
    candidates: string[] | undefined,
  ): Promise<string[]> => {
    const uniqueIds = [...new Set(candidates ?? [])].filter(Boolean);
    if (!uniqueIds.length) return [];
    const project = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .all()
    )[0];
    if (!project) return [];
    const userRows = await env.db
      .select({ id: users.id, role: users.role, guest: users.guest })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, project.workspaceId),
          inArray(users.id, uniqueIds),
          isNull(users.disabledAt),
        ),
      )
      .all();
    /* Admins see everything; members see unrestricted projects; guests
       and restricted projects both require an explicit grant. Same rule
       as implicitProjectRole, expressed over a batch. */
    const visible = new Set(
      userRows
        .filter(
          (row: { role: string; guest: boolean }) =>
            row.role === "admin" ||
            (!project.restricted && row.role === "member" && !row.guest),
        )
        .map((row: { id: string }) => row.id),
    );
    const memberRows = await env.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          inArray(projectMembers.userId, uniqueIds),
        ),
      )
      .all();
    for (const row of memberRows as Array<{ userId: string }>)
      if (userRows.some((user: { id: string }) => user.id === row.userId))
        visible.add(row.userId);
    return [...visible];
  };

  /** Approval changes notify the current version uploader and the project
      managers (never the actor who changed the status). */
  const notifyApprovalChange = async (options: {
    asset: typeof assets.$inferSelect;
    status: string;
    actorUserId: string | null;
    actorName: string;
  }) => {
    const currentVersion = options.asset.currentVersionId
      ? (
          await env.db
            .select({ uploadedBy: assetVersions.uploadedBy })
            .from(assetVersions)
            .where(eq(assetVersions.id, options.asset.currentVersionId))
            .limit(1)
            .all()
        )[0]
      : undefined;
    await createNotifications({
      projectId: options.asset.projectId,
      actorUserId: options.actorUserId,
      recipients: [
        currentVersion?.uploadedBy,
        ...(await projectManagerIds(options.asset.projectId)),
      ],
      kind: "approval.updated",
      payload: {
        project_id: options.asset.projectId,
        asset_id: options.asset.id,
        asset_name: options.asset.name,
        ...(options.asset.currentVersionId
          ? { version_id: options.asset.currentVersionId }
          : {}),
        status: options.status,
        actor_name: options.actorName,
        preview: `Status set to ${options.status.replace(/_/g, " ")}`,
      },
    });
  };

  return {
    audit,
    projectEventEpoch,
    waitForProjectEvent,
    appendProjectEvent,
    notificationPreview,
    projectManagerIds,
    createNotifications,
    threadParticipantIds,
    projectIdForVersion,
    visibleMentionIds,
    notifyApprovalChange,
  };
};

export type Activity = ReturnType<typeof createActivity>;
