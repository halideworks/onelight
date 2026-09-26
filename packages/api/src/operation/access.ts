import {
  workspaces,
  projectMembers,
  projects,
  assets,
  shares,
  assetVersions,
  folders,
  uploadSessions,
} from "@onelight/db/schema";
import { eq, and } from "drizzle-orm";
import {
  errors,
  implicitProjectRole,
  projectRoleAtLeast,
  randomBytes,
} from "@onelight/core";
import type { AppEnv, ActorUser } from "../types.js";

export const createAccess = (env: AppEnv) => {
  const workspaceFor = async (workspaceId: string) => {
    const rows = await env.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .all();
    const workspace = rows[0];
    if (!workspace) throw errors.notFound("Workspace was not found.");
    return workspace;
  };

  const grantFor = async (projectId: string, userId: string) => {
    const rows = await env.db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1)
      .all();
    return rows[0]?.role;
  };

  const requireProject = async (
    projectId: string,
    user: ActorUser,
    minimum?: "manager" | "editor" | "commenter" | "viewer",
    options?: { allowArchived?: boolean },
  ) => {
    const rows = await env.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .all();
    const project = rows[0];
    if (!project || project.workspaceId !== user.workspaceId)
      throw errors.notFound("Project was not found.");
    const role = implicitProjectRole(
      user.role,
      Boolean(project.restricted),
      (await grantFor(project.id, user.id)) ?? undefined,
    );
    // Projects invisible to the caller (restricted without a grant, or any
    // project a guest holds no grant on) 404 rather than 403, so existence
    // does not leak.
    if (!role) throw errors.notFound("Project was not found.");
    if (
      project.status === "archived" &&
      minimum &&
      minimum !== "viewer" &&
      !options?.allowArchived
    )
      throw errors.forbidden("Archived projects are read-only.");
    if (minimum && !projectRoleAtLeast(role, minimum)) throw errors.forbidden();
    return { project, role };
  };

  /* Short random URL identity: 10 lowercase hex characters, 40 random bits.
     Random rather than derived, so addresses neither collide with names nor
     enumerate; the unique index is the arbiter and a clash just redraws. */
  const newPublicId = async (
    exists: (candidate: string) => Promise<boolean>,
  ): Promise<string> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = Array.from(randomBytes(5))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (!(await exists(candidate))) return candidate;
    }
    throw errors.internal("Could not allocate a public id.");
  };

  const newProjectPublicId = () =>
    newPublicId(
      async (candidate) =>
        (
          await env.db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.publicId, candidate))
            .limit(1)
            .all()
        ).length > 0,
    );

  const newAssetPublicId = () =>
    newPublicId(
      async (candidate) =>
        (
          await env.db
            .select({ id: assets.id })
            .from(assets)
            .where(eq(assets.publicId, candidate))
            .limit(1)
            .all()
        ).length > 0,
    );

  const newSharePublicId = () =>
    newPublicId(
      async (candidate) =>
        (
          await env.db
            .select({ id: shares.id })
            .from(shares)
            .where(eq(shares.publicId, candidate))
            .limit(1)
            .all()
        ).length > 0,
    );

  /* URL params arrive as either the canonical ULID or the short public id.
     Resolution happens ONCE, at the entity's own GET: every other endpoint
     and every mutation takes canonical ids only, so an alias can never be
     written into a row. A ULID is exactly 26 characters and a public id is
     not, so the forms cannot collide. */
  const projectParam = async (param: string): Promise<string> => {
    if (param.length === 26) return param;
    const row = (
      await env.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.publicId, param))
        .limit(1)
        .all()
    )[0];
    return row?.id ?? param;
  };

  const assetParam = async (param: string): Promise<string> => {
    if (param.length === 26) return param;
    const row = (
      await env.db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.publicId, param))
        .limit(1)
        .all()
    )[0];
    return row?.id ?? param;
  };

  const shareParam = async (param: string): Promise<string> => {
    if (param.length === 26) return param;
    const row = (
      await env.db
        .select({ id: shares.id })
        .from(shares)
        .where(eq(shares.publicId, param))
        .limit(1)
        .all()
    )[0];
    return row?.id ?? param;
  };

  const currentWorkspace = async (c: { get: (key: "user") => ActorUser }) =>
    workspaceFor(c.get("user").workspaceId);

  const versionForActor = async (
    id: string,
    actor: ActorUser,
    minimum: "viewer" | "commenter" | "editor" | "manager" = "viewer",
  ) => {
    const version = (
      await env.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, id))
        .limit(1)
        .all()
    )[0];
    if (!version) throw errors.notFound("Version was not found.");
    await assetForActor(version.assetId, actor, minimum);
    return version;
  };

  /** The destination folder must be a live assets folder of the project. */
  const requireDestinationFolder = async (
    projectId: string,
    folderId: string,
  ): Promise<void> => {
    const folder = (
      await env.db
        .select()
        .from(folders)
        .where(eq(folders.id, folderId))
        .limit(1)
        .all()
    )[0];
    if (!folder || folder.projectId !== projectId || folder.kind !== "assets")
      throw errors.validation(
        "The destination folder must belong to the project.",
      );
  };

  const findUpload = async (
    id: string,
    actor: ActorUser,
    role: "editor" | "viewer" = "editor",
  ) => {
    const upload = (
      await env.db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, id))
        .limit(1)
        .all()
    )[0];
    if (!upload || upload.workspaceId !== actor.workspaceId)
      throw errors.notFound("Upload was not found.");
    await requireProject(upload.projectId, actor, role);
    return upload;
  };

  const assetForActor = async (
    id: string,
    actor: ActorUser,
    minimum: "viewer" | "commenter" | "editor" | "manager" = "viewer",
  ) => {
    const asset = (
      await env.db.select().from(assets).where(eq(assets.id, id)).limit(1).all()
    )[0];
    if (!asset) throw errors.notFound("Asset was not found.");
    await requireProject(asset.projectId, actor, minimum);
    return asset;
  };

  return {
    workspaceFor,
    grantFor,
    requireProject,
    newProjectPublicId,
    newAssetPublicId,
    newSharePublicId,
    projectParam,
    assetParam,
    shareParam,
    currentWorkspace,
    versionForActor,
    requireDestinationFolder,
    findUpload,
    assetForActor,
  };
};

export type Access = ReturnType<typeof createAccess>;
