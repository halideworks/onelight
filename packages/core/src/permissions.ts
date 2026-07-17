/* Workspace tiers:
   - admin: the operators; implicit manager on every project plus the
     system surfaces.
   - member: the team; implicit viewer on every unrestricted project.
   - guest: accounts you hand outward (freelancers, client-side producers,
     vendors). A guest sees NOTHING it has not been explicitly granted:
     no default visibility, restricted or not. Containment is the default
     instead of something an admin has to remember per project. Grants
     give a guest exactly the ladder role granted, nothing more.
   Share viewers sit below all of these with no account at all. */
export type WorkspaceRole = "admin" | "member" | "guest";
export type ProjectRole = "manager" | "editor" | "commenter" | "viewer";

const rank: Record<ProjectRole, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  manager: 4,
};

export const projectRoleAtLeast = (
  role: ProjectRole | undefined,
  minimum: ProjectRole,
): boolean => role !== undefined && rank[role] >= rank[minimum];

export const implicitProjectRole = (
  workspaceRole: WorkspaceRole,
  restricted: boolean,
  grant: ProjectRole | undefined,
): ProjectRole | undefined => {
  if (workspaceRole === "admin") return "manager";
  if (grant) return grant;
  if (workspaceRole === "guest") return undefined;
  return restricted ? undefined : "viewer";
};
