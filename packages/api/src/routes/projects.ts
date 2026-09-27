import { requireAuth } from "../auth.js";
import {
  userFromContext,
  getLimit,
  cursorParam,
  encodeCursor,
  jsonBody,
  parseJsonObject,
} from "../helpers.js";
import {
  projects,
  projectMembers,
  projectVisits,
  projectEvents,
  projectCoverUploads,
  assets,
  users,
  folders,
} from "@onelight/db/schema";
import { and, eq, lt, desc, gt, asc, isNull, sql, inArray } from "drizzle-orm";
import { errors, PALETTES } from "@onelight/core";
import { bodies } from "../schemas.js";
import { streamSSE } from "hono/streaming";
import type { AppEnv, ApiRouter, ActorUser } from "../types.js";
import type { Projects } from "../operation/projects.js";
import type { Access } from "../operation/access.js";
import type { Activity } from "../operation/activity.js";
import type { Uploads } from "../operation/uploads.js";
import type { Media } from "../operation/media.js";
import type { Blobs } from "../operation/blobs.js";
import { userWire, folderWire } from "../wire.js";

export const registerProjectsRoutes = (
  api: ApiRouter,
  env: AppEnv,
  {
    projectsOps,
    access,
    activity,
    uploads,
    media,
    blobs,
  }: {
    projectsOps: Projects;
    access: Access;
    activity: Activity;
    uploads: Uploads;
    media: Media;
    blobs: Blobs;
  },
) => {
  const { projectWire, projectListContext } = projectsOps;
  const { newProjectPublicId, requireProject, projectParam, findUpload } =
    access;
  const { appendProjectEvent, audit, projectEventEpoch, waitForProjectEvent } =
    activity;
  const { isImageFilename } = uploads;
  const { privateMediaUrl } = media;
  const { deleteProjectBlobs } = blobs;

  api.get("/projects", requireAuth, async (c) => {
    const user = userFromContext(c);
    const limit = getLimit(c.req.query("limit"));
    const status = c.req.query("status") === "archived" ? "archived" : "active";
    // Scan in batches: restricted projects invisible to the caller must not
    // consume page slots or terminate pagination early, so keep fetching
    // until the page fills or the table is exhausted.
    let cursor = cursorParam(c.req.query("cursor"));
    const items: Array<Awaited<ReturnType<typeof projectWire>>> = [];
    let nextCursor: string | null = null;
    scan: for (;;) {
      const rows = await env.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, user.workspaceId),
            eq(projects.status, status),
            cursor ? lt(projects.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(projects.id))
        .limit(limit + 1)
        .all();
      const more = rows.length > limit;
      const batch = rows.slice(0, limit);
      const facts = await projectListContext(batch, user.id);
      for (const [index, project] of batch.entries()) {
        const wire = await projectWire(
          project,
          user.id,
          user.role,
          facts.get(project.id),
        );
        if (!wire.my_role) continue;
        items.push(wire);
        if (items.length === limit) {
          if (more || index < batch.length - 1)
            nextCursor = encodeCursor(project.id);
          break scan;
        }
      }
      if (!more) break;
      cursor = batch[batch.length - 1]?.id;
    }
    return c.json({ items, next_cursor: nextCursor });
  });

  api.post("/projects", requireAuth, async (c) => {
    const user = userFromContext(c);
    /* Guests work inside what they were granted; they do not open rooms. */
    if (user.role === "guest") throw errors.forbidden();
    const body = await jsonBody(c, bodies.projectCreate);
    const existing = await env.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, user.workspaceId))
      .all();
    const palette =
      body.palette ??
      PALETTES[existing.length % PALETTES.length] ??
      PALETTES[0];
    const now = env.clock.now();
    const id = env.ids.ulid();
    await env.db
      .insert(projects)
      .values({
        id,
        publicId: await newProjectPublicId(),
        workspaceId: user.workspaceId,
        name: body.name.trim(),
        status: "active",
        palette,
        restricted: body.restricted,
        settingsJson: "{}",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await env.db
      .insert(projectMembers)
      .values({
        projectId: id,
        userId: user.id,
        role: "manager",
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    const project = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.internal();
    await appendProjectEvent(id, "project.created", {
      project_id: id,
      name: project.name,
    });
    await audit(user.workspaceId, user.id, "project.create", `project:${id}`);
    return c.json(await projectWire(project, user.id, user.role), 201);
  });

  api.get("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    const { project } = await requireProject(
      await projectParam(c.req.param("id")),
      user,
      "viewer",
    );
    return c.json(await projectWire(project, user.id, user.role));
  });

  /* "I opened this." Recorded on purpose rather than inferred from a GET,
     because a GET happens for a hundred reasons -- a poll, a prefetch, a
     search result, another tab -- and a recent shelf built out of those is a
     record of the software's behaviour rather than the person's. It also
     clears the project's badge, which is what a badge means: a count of what
     you have not looked at yet. */
  api.post("/projects/:id/opened", requireAuth, async (c) => {
    const user = userFromContext(c);
    const { project } = await requireProject(
      await projectParam(c.req.param("id")),
      user,
      "viewer",
    );
    const now = env.clock.now();
    await env.db
      .insert(projectVisits)
      .values({ userId: user.id, projectId: project.id, openedAt: now })
      .onConflictDoUpdate({
        target: [projectVisits.userId, projectVisits.projectId],
        set: { openedAt: now },
      })
      .run();
    return c.body(null, 204);
  });

  /* A connection carrying Last-Event-ID is catching up and gets everything it
     missed. A connection without one is a new subscriber that has just loaded
     its state over REST, and replaying the log to it re-announces every asset
     ever created as though it were news. That is how a trashed asset climbed
     back into the browser's list on every page load: the original
     asset.created replayed, and the client added the row back.

     So a first connection is handed a cursor and nothing else: the id of the
     newest event, which the browser stores and echoes back as Last-Event-ID
     when the stream reconnects, putting it on the catch-up path above with
     nothing missed in between. The cursor is an event type no client
     subscribes to, since its only job is to seed that buffer. "0" sorts below
     every ULID, so a project with no events yet still receives what comes
     next rather than being pinned to an id that never arrives. */
  api.get("/projects/:id/events", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const projectId = c.req.param("id");
    await requireProject(projectId, actor, "viewer");
    const lastEventId = c.req.header("last-event-id");
    const eventsAfter = (cursor: string) =>
      env.db
        .select()
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, projectId),
            gt(projectEvents.id, cursor),
          ),
        )
        .orderBy(asc(projectEvents.id))
        .limit(500)
        .all();
    const rows = lastEventId ? await eventsAfter(lastEventId) : [];
    const cursor = lastEventId
      ? null
      : ((
          await env.db
            .select({ id: projectEvents.id })
            .from(projectEvents)
            .where(eq(projectEvents.projectId, projectId))
            .orderBy(desc(projectEvents.id))
            .limit(1)
            .all()
        )[0]?.id ?? "0");
    const live = c.req.header("accept")?.includes("text/event-stream") ?? false;
    return streamSSE(c, async (stream) => {
      let sentCursor = lastEventId ?? cursor ?? "0";
      if (cursor !== null)
        await stream.writeSSE({
          id: cursor,
          event: "stream.cursor",
          data: "{}",
        });
      for (const event of rows) {
        await stream.writeSSE({
          id: event.id,
          event: event.type,
          data: event.payloadJson,
        });
        sentCursor = event.id;
      }
      if (!live) return;
      while (!stream.closed && !c.req.raw.signal.aborted) {
        const observedEpoch = projectEventEpoch.get(projectId) ?? 0;
        const nextRows = await eventsAfter(sentCursor);
        for (const event of nextRows) {
          await stream.writeSSE({
            id: event.id,
            event: event.type,
            data: event.payloadJson,
          });
          sentCursor = event.id;
        }
        if (nextRows.length === 500) continue;
        await stream.write(": keepalive\n\n");
        await waitForProjectEvent(projectId, observedEpoch, c.req.raw.signal);
      }
    });
  });

  api.patch("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    // allowArchived: the read-only rule applies to project content, not the
    // project record itself; without it an archived project could never be
    // unarchived.
    const { project } = await requireProject(
      c.req.param("id"),
      user,
      "manager",
      {
        allowArchived: true,
      },
    );
    const body = await jsonBody(c, bodies.projectPatch);
    if (body.cover_asset_id && body.cover_upload_id)
      throw errors.validation(
        "A project has one cover: set cover_asset_id or cover_upload_id, not both.",
      );
    let coverUpload: typeof projectCoverUploads.$inferSelect | undefined;
    if (body.cover_upload_id) {
      coverUpload = (
        await env.db
          .select()
          .from(projectCoverUploads)
          .where(
            and(
              eq(projectCoverUploads.id, body.cover_upload_id),
              eq(projectCoverUploads.projectId, project.id),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!coverUpload)
        throw errors.validation(
          "cover_upload_id must name a picture uploaded to this project.",
        );
    }
    if (body.cover_asset_id) {
      // Validated here rather than trusted: the wire read filters a bad cover
      // out silently, which would turn a typo into a cover that never appears
      // and never explains itself.
      const cover = (
        await env.db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.id, body.cover_asset_id),
              eq(assets.projectId, project.id),
              isNull(assets.deletedAt),
            ),
          )
          .limit(1)
          .all()
      )[0];
      if (!cover)
        throw errors.validation(
          "cover_asset_id must name an asset in this project.",
        );
    }
    await env.db
      .update(projects)
      .set({
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.palette ? { palette: body.palette } : {}),
        /* "auto" is how a caller clears the house standard, the same way it
           clears an asset's override. */
        ...(body.display_transfer === undefined
          ? {}
          : {
              displayTransfer:
                body.display_transfer === "auto" ? null : body.display_transfer,
            }),
        // The kinds of cover are alternatives, so setting one clears the
        // others; without this, clearing a picked asset would silently fall
        // back to an upload chosen weeks ago.
        ...(body.cover_asset_id === undefined
          ? {}
          : { coverAssetId: body.cover_asset_id, coverBlobKey: null }),
        ...(coverUpload
          ? { coverBlobKey: coverUpload.blobKey, coverAssetId: null }
          : {}),
        ...(body.restricted === undefined
          ? {}
          : { restricted: body.restricted }),
        ...(body.status ? { status: body.status } : {}),
        /* Merged into whatever else the settings blob holds rather than
           replacing it: this is one switch among however many the project
           grows, and a write that clobbered its neighbours would be a bug
           waiting for the second setting to exist. */
        ...(body.record_transfer_ips === undefined
          ? {}
          : {
              settingsJson: JSON.stringify({
                ...parseJsonObject(project.settingsJson),
                record_transfer_ips: body.record_transfer_ips,
              }),
            }),
        updatedAt: env.clock.now(),
      })
      .where(eq(projects.id, project.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, project.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      user.workspaceId,
      user.id,
      body.status === "archived" ? "project.archive" : "project.update",
      `project:${project.id}`,
    );
    return c.json(await projectWire(updated, user.id, user.role));
  });

  /* Set an uploaded picture as the project's cover.
     Deliberately not an asset: a cover is not a deliverable, nobody filed it in
     the project, and it should not appear in the file list, in search, or in a
     share. It also skips the transcode entirely -- the poster pipeline exists to
     make a still out of footage, and this is already a still. */
  api.post("/projects/:id/cover", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "manager",
    );
    const body = await jsonBody(c, bodies.projectCoverPut);
    const upload = await findUpload(body.upload_id, actor);
    if (upload.projectId !== project.id || upload.status !== "completed")
      throw errors.validation("Upload must be completed for this project.");
    if (!isImageFilename(upload.clientFilename))
      throw errors.validation("A cover must be an image.");
    const now = env.clock.now();
    /* Shelve it as well as use it: an uploaded picture stays an option after
       something else is chosen, instead of having to be uploaded again. The
       unique index makes re-uploading the same blob a no-op rather than a
       duplicate option. */
    await env.db
      .insert(projectCoverUploads)
      .values({
        id: env.ids.ulid(),
        projectId: project.id,
        blobKey: upload.blobKey,
        filename: upload.clientFilename,
        createdBy: actor.id,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    await env.db
      .update(projects)
      .set({
        coverBlobKey: upload.blobKey,
        coverAssetId: null,
        updatedAt: now,
      })
      .where(eq(projects.id, project.id))
      .run();
    const updated = (
      await env.db
        .select()
        .from(projects)
        .where(eq(projects.id, project.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      actor.workspaceId,
      actor.id,
      "project.update",
      `project:${project.id}`,
    );
    return c.json(await projectWire(updated, actor.id, actor.role));
  });

  /* The pictures uploaded for this project, current one included. */
  api.get("/projects/:id/covers", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "viewer",
    );
    const rows = await env.db
      .select()
      .from(projectCoverUploads)
      .where(eq(projectCoverUploads.projectId, project.id))
      .orderBy(desc(projectCoverUploads.id))
      .all();
    return c.json({
      items: await Promise.all(
        rows.map(async (row: typeof projectCoverUploads.$inferSelect) => ({
          id: row.id,
          filename: row.filename,
          url: await privateMediaUrl({ projectId: project.id }, row.blobKey),
          current: row.blobKey === project.coverBlobKey,
          created_at: row.createdAt,
        })),
      ),
    });
  });

  /* Forget an uploaded picture. If it is the cover in force, the project falls
     back to its generated one rather than keeping a cover whose file is about
     to be swept. */
  api.delete("/projects/:id/covers/:uploadId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const { project } = await requireProject(
      c.req.param("id"),
      actor,
      "manager",
    );
    const row = (
      await env.db
        .select()
        .from(projectCoverUploads)
        .where(
          and(
            eq(projectCoverUploads.id, c.req.param("uploadId")),
            eq(projectCoverUploads.projectId, project.id),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!row) throw errors.notFound("That cover was not found.");
    await env.db
      .delete(projectCoverUploads)
      .where(eq(projectCoverUploads.id, row.id))
      .run();
    if (project.coverBlobKey === row.blobKey)
      await env.db
        .update(projects)
        .set({ coverBlobKey: null, updatedAt: env.clock.now() })
        .where(eq(projects.id, project.id))
        .run();
    return c.body(null, 204);
  });

  api.delete("/projects/:id", requireAuth, async (c) => {
    const user = userFromContext(c);
    if (user.role !== "admin") throw errors.forbidden();
    const project = (
      await env.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, c.req.param("id")),
            eq(projects.workspaceId, user.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!project) throw errors.notFound();
    /* Free the project's blobs before the row cascade removes the columns that
       name them. The FK cascade deletes the rows; nothing deletes the objects,
       so without this a project delete stranded every original, proxy, poster,
       sprite, cover and logo on disk until a GC that is off by default caught
       up. Deletes are best-effort; the GC remains the backstop for any miss. */
    await deleteProjectBlobs(project);
    await env.db.delete(projects).where(eq(projects.id, project.id)).run();
    await audit(
      user.workspaceId,
      user.id,
      "project.delete",
      `project:${project.id}`,
    );
    return c.body(null, 204);
  });

  api.get("/projects/:id/members", requireAuth, async (c) => {
    const user = userFromContext(c);
    await requireProject(c.req.param("id"), user, "viewer");
    const rows = await env.db
      .select({ user: users, member: projectMembers })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, c.req.param("id")))
      .all();
    return c.json({
      items: rows.map(
        (row: {
          user: ActorUser;
          member: typeof projectMembers.$inferSelect;
        }) => ({ user: userWire(row.user), role: row.member.role }),
      ),
    });
  });

  api.put("/projects/:id/members/:userId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "manager");
    const body = await jsonBody(c, bodies.memberPut);
    const target = (
      await env.db
        .select()
        .from(users)
        .where(
          and(
            eq(users.id, c.req.param("userId")),
            eq(users.workspaceId, actor.workspaceId),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!target) throw errors.notFound("User was not found.");
    const existing = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, c.req.param("id")),
          eq(projectMembers.userId, target.id),
        ),
      )
      .limit(1)
      .all();
    /* Demoting the current manager: guard atomically inside the UPDATE (see the
       member-remove path) so two concurrent demotes cannot both pass a separate
       count check and strip the project of every manager. A workspace admin
       bypasses it. Any other transition (a plain add, or a promotion) takes the
       normal upsert. */
    const guardDemote =
      existing[0]?.role === "manager" &&
      body.role !== "manager" &&
      actor.role !== "admin";
    if (guardDemote) {
      await env.db
        .update(projectMembers)
        .set({ role: body.role })
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.userId, target.id),
            sql`(select count(*) from ${projectMembers} where ${projectMembers.projectId} = ${c.req.param("id")} and ${projectMembers.role} = 'manager') > 1`,
          ),
        )
        .run();
      const stillManager = await env.db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.userId, target.id),
          ),
        )
        .limit(1)
        .all();
      if (stillManager[0]?.role === "manager")
        throw errors.conflict("The last project manager cannot be demoted.");
    } else {
      await env.db
        .insert(projectMembers)
        .values({
          projectId: c.req.param("id"),
          userId: target.id,
          role: body.role,
          createdAt: env.clock.now(),
        })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: { role: body.role },
        })
        .run();
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "project.member_set",
      `project:${c.req.param("id")}`,
      { user_id: target.id, role: body.role },
    );
    return c.json({ user: userWire(target), role: body.role });
  });

  api.delete("/projects/:id/members/:userId", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "manager");
    const existing = (
      await env.db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, c.req.param("id")),
            eq(projectMembers.userId, c.req.param("userId")),
          ),
        )
        .limit(1)
        .all()
    )[0];
    if (!existing) throw errors.notFound();
    /* The last-manager guard lives inside the DELETE, not in a separate SELECT
       before it: SQLite serializes writes and re-evaluates the correlated count
       per statement, so two concurrent removals of the two remaining managers
       cannot both pass a check-then-act and leave the project with zero. A
       workspace admin bypasses the guard. */
    const guardManager = existing.role === "manager" && actor.role !== "admin";
    await env.db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, existing.projectId),
          eq(projectMembers.userId, existing.userId),
          guardManager
            ? sql`(select count(*) from ${projectMembers} where ${projectMembers.projectId} = ${existing.projectId} and ${projectMembers.role} = 'manager') > 1`
            : undefined,
        ),
      )
      .run();
    if (guardManager) {
      const survivor = await env.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, existing.projectId),
            eq(projectMembers.userId, existing.userId),
          ),
        )
        .limit(1)
        .all();
      // The guard blocked the delete: the row is still there, so this was the
      // last manager.
      if (survivor.length)
        throw errors.conflict("The last project manager cannot be removed.");
    }
    await audit(
      actor.workspaceId,
      actor.id,
      "project.member_remove",
      `project:${existing.projectId}`,
      { user_id: existing.userId },
    );
    return c.body(null, 204);
  });

  const folderDepth = async (
    projectId: string,
    parentId: string | null,
  ): Promise<number> => {
    let depth = 1;
    let current = parentId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current))
        throw errors.validation("Folder parent cycle detected.");
      seen.add(current);
      const parent = (
        await env.db
          .select()
          .from(folders)
          .where(eq(folders.id, current))
          .limit(1)
          .all()
      )[0];
      if (!parent || parent.projectId !== projectId)
        throw errors.validation(
          "Folder parent must belong to the same project.",
        );
      depth += 1;
      current = parent.parentId;
      if (depth > 10)
        throw errors.validation("Folder depth cannot exceed 10 levels.");
    }
    return depth;
  };

  /**
   * Height of a folder's subtree (the folder itself counts 1). Moves must
   * respect the depth cap for the DEEPEST descendant, not just the moved
   * node; capped at the limit since anything deeper already fails.
   */
  const folderSubtreeHeight = async (folderId: string): Promise<number> => {
    let height = 1;
    let frontier = [folderId];
    while (frontier.length) {
      const children = await env.db
        .select({ id: folders.id })
        .from(folders)
        .where(inArray(folders.parentId, frontier))
        .all();
      if (!children.length) break;
      height += 1;
      if (height > 10) break;
      frontier = children.map((child: { id: string }) => child.id);
    }
    return height;
  };

  api.get("/projects/:id/folders", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "viewer");
    const parent = c.req.query("parent_id") ?? null;
    // Two trees share this table; a caller asking for one must never be handed
    // rows from the other.
    const kind = c.req.query("kind") === "shares" ? "shares" : "assets";
    const rows = await env.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.projectId, c.req.param("id")),
          eq(folders.kind, kind),
          parent ? eq(folders.parentId, parent) : isNull(folders.parentId),
        ),
      )
      .orderBy(asc(folders.name))
      .all();
    return c.json({
      items: rows.map(folderWire),
    });
  });

  api.get("/folders/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const [folder] = await env.db
      .select()
      .from(folders)
      .where(eq(folders.id, c.req.param("id")))
      .limit(1)
      .all();
    if (!folder) throw errors.notFound();
    await requireProject(folder.projectId, actor, "viewer");
    return c.json(folderWire(folder));
  });

  api.post("/projects/:id/folders", requireAuth, async (c) => {
    const actor = userFromContext(c);
    await requireProject(c.req.param("id"), actor, "editor");
    const body = await jsonBody(c, bodies.folderCreate);
    await folderDepth(c.req.param("id"), body.parent_id ?? null);
    // A child inherits its parent's tree: nothing may straddle the two, and a
    // caller should not have to restate what the parent already decides.
    const parentKind = body.parent_id
      ? (
          await env.db
            .select({ kind: folders.kind })
            .from(folders)
            .where(eq(folders.id, body.parent_id))
            .limit(1)
            .all()
        )[0]?.kind
      : undefined;
    const kind = parentKind ?? body.kind ?? "assets";
    const now = env.clock.now();
    const id = env.ids.ulid();
    try {
      await env.db
        .insert(folders)
        .values({
          id,
          projectId: c.req.param("id"),
          parentId: body.parent_id ?? null,
          kind,
          name: body.name.trim(),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw errors.conflict(
          "A sibling folder with that name already exists.",
        );
      throw error;
    }
    await audit(actor.workspaceId, actor.id, "folder.create", `folder:${id}`);
    return c.json(
      {
        id,
        project_id: c.req.param("id"),
        parent_id: body.parent_id ?? null,
        kind,
        name: body.name.trim(),
        created_at: now,
      },
      201,
    );
  });

  api.patch("/folders/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const folder = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!folder) throw errors.notFound();
    await requireProject(folder.projectId, actor, "editor");
    const body = await jsonBody(c, bodies.folderPatch);
    const parentId =
      body.parent_id === undefined ? folder.parentId : body.parent_id;
    if (parentId === folder.id)
      throw errors.validation("A folder cannot be its own parent.");
    if (parentId) {
      const parent = (
        await env.db
          .select({ kind: folders.kind })
          .from(folders)
          .where(eq(folders.id, parentId))
          .limit(1)
          .all()
      )[0];
      if (!parent)
        throw errors.validation("That parent folder does not exist.");
      // Moving a share folder into the asset tree would put shares somewhere
      // only assets are read from: they would simply vanish from the rail.
      if (parent.kind !== folder.kind)
        throw errors.validation(
          "A folder cannot be moved into the other tree.",
        );
    }
    const newDepth = await folderDepth(folder.projectId, parentId ?? null);
    // The cap applies to the deepest DESCENDANT after the move, not just
    // the moved folder itself.
    if (newDepth + (await folderSubtreeHeight(folder.id)) - 1 > 10)
      throw errors.validation("Folder depth cannot exceed 10 levels.");
    let current = parentId;
    while (current) {
      if (current === folder.id)
        throw errors.validation(
          "A folder cannot be moved into its own subtree.",
        );
      const parent = (
        await env.db
          .select({ parentId: folders.parentId })
          .from(folders)
          .where(eq(folders.id, current))
          .limit(1)
          .all()
      )[0];
      current = parent?.parentId ?? null;
    }
    try {
      await env.db
        .update(folders)
        .set({
          ...(body.name ? { name: body.name.trim() } : {}),
          parentId: parentId ?? null,
          updatedAt: env.clock.now(),
        })
        .where(eq(folders.id, folder.id))
        .run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw errors.conflict(
          "A sibling folder with that name already exists.",
        );
      throw error;
    }
    const updated = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, folder.id))
        .limit(1)
        .all()
    )[0];
    if (!updated) throw errors.notFound();
    await audit(
      actor.workspaceId,
      actor.id,
      body.parent_id === undefined ? "folder.rename" : "folder.move",
      `folder:${folder.id}`,
    );
    return c.json(folderWire(updated));
  });

  api.delete("/folders/:id", requireAuth, async (c) => {
    const actor = userFromContext(c);
    const folder = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, c.req.param("id")))
        .limit(1)
        .all()
    )[0];
    if (!folder) throw errors.notFound();
    await requireProject(folder.projectId, actor, "editor");
    await env.db.delete(folders).where(eq(folders.id, folder.id)).run();
    await audit(
      actor.workspaceId,
      actor.id,
      "folder.delete",
      `folder:${folder.id}`,
    );
    return c.body(null, 204);
  });
};
