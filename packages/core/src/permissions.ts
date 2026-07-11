export type WorkspaceRole = "admin" | "member";
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
  return restricted ? undefined : "viewer";
};
