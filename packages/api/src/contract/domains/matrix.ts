import { describe, expect, it } from "vitest";
import { cookieFrom, json, req } from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  createProject,
  createUser,
  grantRole,
  seedAssetVersion,
  unique,
} from "../seed.js";
import type { SeedState } from "../seed.js";
import type { SuiteContext } from "../context.js";

type RoleKey =
  | "admin"
  | "manager"
  | "editor"
  | "commenter"
  | "viewer"
  | "nograntee"
  | "guest";

const ROLES: RoleKey[] = [
  "admin",
  "manager",
  "editor",
  "commenter",
  "viewer",
  "nograntee",
  "guest",
];

const cookieFor = (seed: SeedState, role: RoleKey): string => seed[role].cookie;

/**
 * Phase-0 section 6 permission matrix, table-driven, every cell exercised
 * through a real HTTP call on both a non-restricted and a restricted
 * project. Denials read 403 when the caller can see the project and 404
 * when a restricted project is invisible to them.
 */
interface ProjectAction {
  name: string;
  run: (
    h: ContractHarness,
    seed: SeedState,
    role: RoleKey,
    projectId: string,
  ) => Promise<Response>;
  expected: (role: RoleKey, restricted: boolean) => number;
}

/* Ungranted guests cannot see the project at all, restricted or not; an
   ungranted member only loses sight of restricted projects. Invisible
   denials read 404 so existence does not leak. */
const invisible = (role: RoleKey, restricted: boolean): boolean =>
  role === "guest" || (role === "nograntee" && restricted);

const deniedStatus = (role: RoleKey, restricted: boolean): number =>
  invisible(role, restricted) ? 404 : 403;

const PROJECT_ACTIONS: ProjectAction[] = [
  {
    name: "read project",
    run: (h, seed, role, projectId) =>
      req(h, `/api/v1/projects/${projectId}`, {
        cookie: cookieFor(seed, role),
      }),
    expected: (role, restricted) => (invisible(role, restricted) ? 404 : 200),
  },
  {
    name: "rename project",
    run: (h, seed, role, projectId) =>
      req(h, `/api/v1/projects/${projectId}`, {
        method: "PATCH",
        cookie: cookieFor(seed, role),
        json: { name: unique("Matrix Rename") },
      }),
    expected: (role, restricted) =>
      role === "admin" || role === "manager"
        ? 200
        : deniedStatus(role, restricted),
  },
  {
    name: "set project palette",
    run: (h, seed, role, projectId) =>
      req(h, `/api/v1/projects/${projectId}`, {
        method: "PATCH",
        cookie: cookieFor(seed, role),
        json: { palette: "tetsukon" },
      }),
    expected: (role, restricted) =>
      role === "admin" || role === "manager"
        ? 200
        : deniedStatus(role, restricted),
  },
  {
    name: "archive project",
    run: async (h, seed, role, projectId) => {
      const response = await req(h, `/api/v1/projects/${projectId}`, {
        method: "PATCH",
        cookie: cookieFor(seed, role),
        json: { status: "archived" },
      });
      if (response.status === 200) {
        // Restore so later cells see an active project.
        const restore = await req(h, `/api/v1/projects/${projectId}`, {
          method: "PATCH",
          cookie: cookieFor(seed, role),
          json: { status: "active" },
        });
        expect(restore.status).toBe(200);
      }
      return response;
    },
    expected: (role, restricted) =>
      role === "admin" || role === "manager"
        ? 200
        : deniedStatus(role, restricted),
  },
  {
    name: "manage project members",
    run: (h, seed, role, projectId) =>
      req(h, `/api/v1/projects/${projectId}/members/${seed.scratch.id}`, {
        method: "PUT",
        cookie: cookieFor(seed, role),
        json: { role: "viewer" },
      }),
    expected: (role, restricted) =>
      role === "admin" || role === "manager"
        ? 200
        : deniedStatus(role, restricted),
  },
  {
    name: "create folder",
    run: (h, seed, role, projectId) =>
      req(h, `/api/v1/projects/${projectId}/folders`, {
        cookie: cookieFor(seed, role),
        json: { name: unique("Matrix Folder") },
      }),
    expected: (role, restricted) =>
      role === "admin" || role === "manager" || role === "editor"
        ? 201
        : deniedStatus(role, restricted),
  },
];

interface WorkspaceAction {
  name: string;
  run: (
    h: ContractHarness,
    seed: SeedState,
    role: RoleKey,
  ) => Promise<Response>;
  expected: (role: RoleKey) => number;
}

const WORKSPACE_ACTIONS: WorkspaceAction[] = [
  {
    name: "create project",
    run: (h, seed, role) =>
      req(h, "/api/v1/projects", {
        cookie: cookieFor(seed, role),
        json: { name: unique("Matrix Created") },
      }),
    expected: (role) => (role === "guest" ? 403 : 201),
  },
  {
    name: "workspace settings",
    run: (h, seed, role) =>
      req(h, "/api/v1/workspace", {
        method: "PATCH",
        cookie: cookieFor(seed, role),
        json: { name: "Contract Workspace" },
      }),
    expected: (role) => (role === "admin" ? 200 : 403),
  },
  {
    name: "list workspace users",
    run: (h, seed, role) =>
      req(h, "/api/v1/users", { cookie: cookieFor(seed, role) }),
    expected: (role) => (role === "admin" ? 200 : 403),
  },
  {
    name: "list invites",
    run: (h, seed, role) =>
      req(h, "/api/v1/invites", { cookie: cookieFor(seed, role) }),
    expected: (role) => (role === "admin" ? 200 : 403),
  },
  {
    name: "read audit log",
    run: (h, seed, role) =>
      req(h, "/api/v1/audit", { cookie: cookieFor(seed, role) }),
    expected: (role) => (role === "admin" ? 200 : 403),
  },
];

export const registerMatrixDomain = (ctx: SuiteContext): void => {
  describe("phase-0 permission matrix", () => {
    for (const restricted of [false, true]) {
      const label = restricted
        ? "restricted project"
        : "non-restricted project";
      for (const action of PROJECT_ACTIONS) {
        it(`${action.name} on a ${label} matches every role cell`, async () => {
          const h = ctx.h();
          const seed = ctx.seed();
          const projectId = restricted ? seed.restricted.id : seed.project.id;
          for (const role of ROLES) {
            const response = await action.run(h, seed, role, projectId);
            expect(response.status, `${action.name} / ${role} / ${label}`).toBe(
              action.expected(role, restricted),
            );
          }
        });
      }
      it(`project list visibility on a ${label} matches every role cell`, async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        const projectId = restricted ? seed.restricted.id : seed.project.id;
        for (const role of ROLES) {
          const response = await req(h, "/api/v1/projects?limit=200", {
            cookie: cookieFor(seed, role),
          });
          expect(response.status).toBe(200);
          const body = await json<{ items: Array<{ id: string }> }>(response);
          const visible = body.items.some((item) => item.id === projectId);
          const expected = !invisible(role, restricted);
          expect(visible, `list / ${role} / ${label}`).toBe(expected);
        }
      });
    }
    for (const action of WORKSPACE_ACTIONS) {
      it(`${action.name} matches every role cell`, async () => {
        const h = ctx.h();
        const seed = ctx.seed();
        for (const role of ROLES) {
          const response = await action.run(h, seed, role);
          expect(response.status, `${action.name} / ${role}`).toBe(
            action.expected(role),
          );
        }
      });
    }

    it("a grant gives a guest exactly the granted ladder role", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const guest = await createUser(h, {
        workspaceId: seed.workspaceId,
        role: "guest",
        passwordHash: seed.passwordHash,
      });
      const project = await createProject(h, seed.admin, {
        name: unique("Guest Grant"),
      });
      const media = await seedAssetVersion(h, {
        workspaceId: seed.workspaceId,
        projectId: project.id,
        userId: seed.admin.id,
      });

      // Before the grant: invisible, in the list and to a direct read.
      const before = await req(h, `/api/v1/projects/${project.id}`, {
        cookie: guest.cookie,
      });
      expect(before.status).toBe(404);

      await grantRole(h, seed.admin, project.id, guest.id, "commenter");
      const after = await json<{ my_role: string }>(
        await req(h, `/api/v1/projects/${project.id}`, {
          cookie: guest.cookie,
        }),
      );
      expect(after.my_role).toBe("commenter");
      const listed = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/projects?limit=200", { cookie: guest.cookie }),
      );
      expect(listed.items.some((item) => item.id === project.id)).toBe(true);

      // The ladder holds: a commenter guest comments but cannot upload.
      const comment = await req(
        h,
        `/api/v1/versions/${media.versionId}/comments`,
        {
          cookie: guest.cookie,
          json: { body_text: "A guest note", frame_in: 1 },
        },
      );
      expect(comment.status).toBe(201);
      const folder = await req(h, `/api/v1/projects/${project.id}/folders`, {
        cookie: guest.cookie,
        json: { name: unique("Guest Folder") },
      });
      expect(folder.status).toBe(403);

      // Other unrestricted projects stay invisible: containment is the
      // default, not a per-project flag someone remembered to set.
      const other = await req(h, `/api/v1/projects/${seed.project.id}`, {
        cookie: guest.cookie,
      });
      expect(other.status).toBe(404);
    });

    it("invites carry the guest role through acceptance", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const email = unique("guest-invite").toLowerCase() + "@example.com";
      const invited = await json<{ accept_url?: string; token?: string }>(
        await req(h, "/api/v1/invites", {
          cookie: seed.admin.cookie,
          json: {
            email,
            role: "guest",
            project_grants: [{ project_id: seed.project.id, role: "viewer" }],
          },
        }),
      );
      const token =
        invited.token ??
        /\/invite\/([A-Za-z0-9_-]+)/.exec(invited.accept_url ?? "")?.[1] ??
        "";
      expect(token.length).toBeGreaterThan(0);
      const accepted = await req(h, "/api/v1/invites/accept", {
        json: { token, name: "Invited Guest", password: "guest-password-1" },
      });
      expect(accepted.status).toBe(201);
      const cookie = cookieFrom(accepted);
      const session = await json<{ user: { role: string } }>(
        await req(h, "/api/v1/auth/session", { cookie }),
      );
      expect(session.user.role).toBe("guest");
      // The invite's grant is the only thing this account can see.
      const listed = await json<{ items: Array<{ id: string }> }>(
        await req(h, "/api/v1/projects?limit=200", { cookie }),
      );
      expect(listed.items.map((item) => item.id)).toEqual([seed.project.id]);
    });
  });
};
