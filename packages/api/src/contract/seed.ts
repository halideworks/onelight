import { eq } from "drizzle-orm";
import { base64UrlEncode, days, randomBytes, sha256Hex } from "@onelight/core";
import {
  assetVersions,
  assets,
  projectMembers,
  renditions,
  sessions,
  uploadSessions,
  users,
  workspaces,
} from "@onelight/db/schema";
import type { ContractHarness } from "./harness.js";
import { cookieFrom, json, req } from "./harness.js";

let counter = 0;

export const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

export const uniqueEmail = (): string => {
  counter += 1;
  return `user-${counter}@contract.test`;
};

/** Distinct client IP per call, to keep per-IP rate limit buckets isolated. */
export const uniqueIp = (): string => {
  counter += 1;
  return `203.0.113.${counter % 200}.${counter}`;
};

export const PASSWORD = "contract-password-1";

export interface Actor {
  id: string;
  email: string;
  cookie: string;
}

export const createSessionCookie = async (
  h: ContractHarness,
  userId: string,
): Promise<string> => {
  const token = base64UrlEncode(randomBytes(32));
  const now = h.clock.now();
  await h.db
    .insert(sessions)
    .values({
      id: h.ids.ulid(),
      userId,
      tokenHash: await sha256Hex(token),
      createdAt: now,
      expiresAt: now + days(30),
      lastSeenAt: now,
      ip: null,
      userAgent: null,
    })
    .run();
  return `ol_session=${token}`;
};

export interface CreateUserOptions {
  workspaceId: string;
  role?: "admin" | "member";
  passwordHash: string | null;
  disabled?: boolean;
  email?: string;
  session?: boolean;
}

export const createUser = async (
  h: ContractHarness,
  options: CreateUserOptions,
): Promise<Actor> => {
  const id = h.ids.ulid();
  const email = options.email ?? uniqueEmail();
  const now = h.clock.now();
  await h.db
    .insert(users)
    .values({
      id,
      workspaceId: options.workspaceId,
      email,
      name: `Contract ${email}`,
      role: options.role ?? "member",
      passwordHash: options.passwordHash,
      disabledAt: options.disabled ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const cookie =
    options.session === false ? "" : await createSessionCookie(h, id);
  return { id, email, cookie };
};

export const createProject = async (
  h: ContractHarness,
  creator: Actor,
  options: { name?: string; restricted?: boolean } = {},
): Promise<{ id: string }> => {
  const response = await req(h, "/api/v1/projects", {
    cookie: creator.cookie,
    json: {
      name: options.name ?? unique("Project"),
      restricted: options.restricted ?? false,
    },
  });
  if (response.status !== 201)
    throw new Error(`Seed project creation failed: ${response.status}`);
  const body = await json<{ id: string }>(response);
  return { id: body.id };
};

export const grantRole = async (
  h: ContractHarness,
  admin: Actor,
  projectId: string,
  userId: string,
  role: "manager" | "editor" | "commenter" | "viewer",
): Promise<void> => {
  const response = await req(
    h,
    `/api/v1/projects/${projectId}/members/${userId}`,
    { method: "PUT", cookie: admin.cookie, json: { role } },
  );
  if (response.status !== 200)
    throw new Error(`Seed grant failed: ${response.status}`);
};

export interface SeededVersion {
  uploadSessionId: string;
  assetId: string;
  versionId: string;
  blobKey: string;
}

/**
 * Seed a completed upload plus an asset with one version directly in the
 * database (there is no versioned-media fixture endpoint; the app's own
 * upload path is exercised separately in the uploads domain).
 */
export const seedAssetVersion = async (
  h: ContractHarness,
  options: {
    workspaceId: string;
    projectId: string;
    userId: string;
    name?: string;
    durationFrames?: number | null;
    folderId?: string | null;
  },
): Promise<SeededVersion> => {
  const uploadSessionId = h.ids.ulid();
  const assetId = h.ids.ulid();
  const versionId = h.ids.ulid();
  const now = h.clock.now();
  const name = options.name ?? unique("Asset");
  const blobKey = `${options.workspaceId}/${options.projectId}/uploads/${uploadSessionId}/${name}.mp4`;
  await h.db
    .insert(uploadSessions)
    .values({
      id: uploadSessionId,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      createdBy: options.userId,
      clientFilename: `${name}.mp4`,
      relativePath: "",
      size: 10,
      checksumCrc32c: "abc",
      blobKey,
      uploadId: null,
      partSize: null,
      status: "completed",
      createdAt: now,
      completedAt: now,
    })
    .run();
  await h.db
    .insert(assets)
    .values({
      id: assetId,
      projectId: options.projectId,
      folderId: options.folderId ?? null,
      name,
      kind: "video",
      currentVersionId: versionId,
      status: "in_review",
      description: "",
      tagsJson: "[]",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await h.db
    .insert(assetVersions)
    .values({
      id: versionId,
      assetId,
      uploadSessionId,
      versionNo: 1,
      originalBlobKey: blobKey,
      originalFilename: `${name}.mp4`,
      size: 10,
      checksumCrc32c: "abc",
      uploadedBy: options.userId,
      mediaInfoJson: "{}",
      sourceTimecodeStart: null,
      sourceStartFrame: null,
      frameRateNum: 24,
      frameRateDen: 1,
      dropFrame: false,
      durationFrames:
        options.durationFrames === undefined ? 100 : options.durationFrames,
      colorJson: "{}",
      transcodeStatus: "ready",
      deletedAt: null,
      createdAt: now,
    })
    .run();
  return { uploadSessionId, assetId, versionId, blobKey };
};

/** Add another version (with its own completed upload) to an existing asset. */
export const seedExtraVersion = async (
  h: ContractHarness,
  options: {
    workspaceId: string;
    projectId: string;
    userId: string;
    assetId: string;
    versionNo: number;
    makeCurrent?: boolean;
  },
): Promise<{ versionId: string; uploadSessionId: string }> => {
  const uploadSessionId = h.ids.ulid();
  const versionId = h.ids.ulid();
  const now = h.clock.now();
  const blobKey = `${options.workspaceId}/${options.projectId}/uploads/${uploadSessionId}/v${options.versionNo}.mp4`;
  await h.db
    .insert(uploadSessions)
    .values({
      id: uploadSessionId,
      workspaceId: options.workspaceId,
      projectId: options.projectId,
      createdBy: options.userId,
      clientFilename: `v${options.versionNo}.mp4`,
      relativePath: "",
      size: 10,
      checksumCrc32c: "abc",
      blobKey,
      uploadId: null,
      partSize: null,
      status: "completed",
      createdAt: now,
      completedAt: now,
    })
    .run();
  await h.db
    .insert(assetVersions)
    .values({
      id: versionId,
      assetId: options.assetId,
      uploadSessionId,
      versionNo: options.versionNo,
      originalBlobKey: blobKey,
      originalFilename: `v${options.versionNo}.mp4`,
      size: 10,
      checksumCrc32c: "abc",
      uploadedBy: options.userId,
      mediaInfoJson: "{}",
      sourceTimecodeStart: null,
      sourceStartFrame: null,
      frameRateNum: 24,
      frameRateDen: 1,
      dropFrame: false,
      durationFrames: 100,
      colorJson: "{}",
      transcodeStatus: "ready",
      deletedAt: null,
      createdAt: now,
    })
    .run();
  if (options.makeCurrent) {
    await h.db
      .update(assets)
      .set({ currentVersionId: versionId })
      .where(eq(assets.id, options.assetId))
      .run();
  }
  return { versionId, uploadSessionId };
};

/** Seed a rendition row plus (when a store exists) its backing blob. */
export const seedRendition = async (
  h: ContractHarness,
  options: {
    versionId: string;
    kind?: string;
    content?: string;
  },
): Promise<{ id: string; blobKey: string; bytes: Uint8Array }> => {
  const id = h.ids.ulid();
  const blobKey = `renditions/${id}.mp4`;
  const bytes = new TextEncoder().encode(
    options.content ?? "proxy-bytes-0123456789",
  );
  await h.db
    .insert(renditions)
    .values({
      id,
      versionId: options.versionId,
      kind: (options.kind ?? "proxy_1080") as "proxy_1080",
      blobKey,
      metaJson: "{}",
      size: bytes.byteLength,
      checksumSha256: "",
      shareId: null,
      createdAt: h.clock.now(),
    })
    .run();
  if (h.blobStore) {
    const body = new Response(bytes.slice().buffer).body;
    if (body) await h.blobStore.putStream(blobKey, body, {});
  }
  return { id, blobKey, bytes };
};

export interface SeedState {
  workspaceId: string;
  workspaceName: string;
  passwordHash: string;
  admin: Actor;
  manager: Actor;
  editor: Actor;
  commenter: Actor;
  viewer: Actor;
  nograntee: Actor;
  /** Extra user used as a membership target in the permission matrix. */
  scratch: Actor;
  project: { id: string };
  restricted: { id: string };
  media: SeededVersion;
  other: {
    workspaceId: string;
    admin: Actor;
    projectId: string;
    media: SeededVersion;
  };
}

export const buildSeed = async (h: ContractHarness): Promise<SeedState> => {
  const setup = await req(h, "/api/v1/setup", {
    json: {
      workspace_name: "Contract Workspace",
      name: "Contract Admin",
      email: "admin@contract.test",
      password: PASSWORD,
    },
  });
  if (setup.status !== 201)
    throw new Error(`Seed setup failed: ${setup.status}`);
  const setupBody = await json<{ user: { id: string } }>(setup);
  const admin: Actor = {
    id: setupBody.user.id,
    email: "admin@contract.test",
    cookie: cookieFrom(setup),
  };
  const workspaceResponse = await req(h, "/api/v1/workspace", {
    cookie: admin.cookie,
  });
  const workspace = await json<{ id: string; name: string }>(workspaceResponse);

  const passwordHash = await h.hasher.hash(PASSWORD);
  const mk = () => createUser(h, { workspaceId: workspace.id, passwordHash });
  const [manager, editor, commenter, viewer, nograntee, scratch] =
    await Promise.all([mk(), mk(), mk(), mk(), mk(), mk()]);

  const project = await createProject(h, admin, { name: unique("Base") });
  const restricted = await createProject(h, admin, {
    name: unique("Restricted"),
    restricted: true,
  });
  for (const target of [project.id, restricted.id]) {
    await grantRole(h, admin, target, manager.id, "manager");
    await grantRole(h, admin, target, editor.id, "editor");
    await grantRole(h, admin, target, commenter.id, "commenter");
    await grantRole(h, admin, target, viewer.id, "viewer");
  }

  const media = await seedAssetVersion(h, {
    workspaceId: workspace.id,
    projectId: project.id,
    userId: admin.id,
  });

  // Second workspace, seeded directly: /setup only runs once.
  const otherWorkspaceId = h.ids.ulid();
  await h.db
    .insert(workspaces)
    .values({
      id: otherWorkspaceId,
      name: "Other Workspace",
      settingsJson: "{}",
      createdAt: h.clock.now(),
    })
    .run();
  const otherAdmin = await createUser(h, {
    workspaceId: otherWorkspaceId,
    role: "admin",
    passwordHash,
  });
  const otherProject = await createProject(h, otherAdmin, {
    name: unique("OtherWs"),
  });
  const otherMedia = await seedAssetVersion(h, {
    workspaceId: otherWorkspaceId,
    projectId: otherProject.id,
    userId: otherAdmin.id,
  });

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    passwordHash,
    admin,
    manager,
    editor,
    commenter,
    viewer,
    nograntee,
    scratch,
    project,
    restricted,
    media,
    other: {
      workspaceId: otherWorkspaceId,
      admin: otherAdmin,
      projectId: otherProject.id,
      media: otherMedia,
    },
  };
};

/** Ensure project_members rows exist even for direct-DB projects. */
export const addMembership = async (
  h: ContractHarness,
  projectId: string,
  userId: string,
  role: "manager" | "editor" | "commenter" | "viewer",
): Promise<void> => {
  await h.db
    .insert(projectMembers)
    .values({ projectId, userId, role, createdAt: h.clock.now() })
    .onConflictDoNothing()
    .run();
};
