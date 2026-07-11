import { describe, expect, it } from "vitest";
import { workspaces } from "@onelight/db/schema";
import {
  assertSnakeCaseKeys,
  errorCode,
  forbiddenKeysIn,
  json,
  req,
  travel,
} from "../harness.js";
import type { ContractHarness } from "../harness.js";
import {
  PASSWORD,
  createProject,
  createUser,
  unique,
  uniqueEmail,
  uniqueIp,
} from "../seed.js";
import type { Actor } from "../seed.js";
import type { SuiteContext } from "../context.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * A throwaway workspace with a single admin, for last-admin guard tests
 * that need full control of the admin population.
 */
const createIsolatedWorkspace = async (
  h: ContractHarness,
  passwordHash: string,
): Promise<{ workspaceId: string; admin: Actor }> => {
  const workspaceId = h.ids.ulid();
  await h.db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: unique("Guard Workspace"),
      settingsJson: "{}",
      createdAt: h.clock.now(),
    })
    .run();
  const admin = await createUser(h, {
    workspaceId,
    role: "admin",
    passwordHash,
  });
  return { workspaceId, admin };
};

export const registerWorkspaceUsersDomain = (ctx: SuiteContext): void => {
  describe("workspace", () => {
    it("returns the workspace wire shape and requires auth", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const anonymous = await req(h, "/api/v1/workspace");
      expect(anonymous.status).toBe(401);
      const response = await req(h, "/api/v1/workspace", {
        cookie: seed.viewer.cookie,
      });
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.id).toBe(seed.workspaceId);
      expect(body.settings).toEqual({});
      expect(body.oidc_enabled).toBe(false);
      expect(assertSnakeCaseKeys(body)).toEqual([]);
    });

    it("PATCH is admin-only, renames, and rejects non-empty settings", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const forbidden = await req(h, "/api/v1/workspace", {
        method: "PATCH",
        cookie: seed.manager.cookie,
        json: { name: "Nope" },
      });
      expect(forbidden.status).toBe(403);
      const badSettings = await req(h, "/api/v1/workspace", {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { settings: { theme: "dark" } },
      });
      expect(badSettings.status).toBe(400);
      const renamed = await req(h, "/api/v1/workspace", {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { name: "Contract Workspace" },
      });
      expect(renamed.status).toBe(200);
      expect((await json(renamed)).name).toBe("Contract Workspace");
    });
  });

  describe("users", () => {
    it("lists users admin-only with cursor pagination", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const forbidden = await req(h, "/api/v1/users", {
        cookie: seed.editor.cookie,
      });
      expect(forbidden.status).toBe(403);
      const firstPage = await req(h, "/api/v1/users?limit=2", {
        cookie: seed.admin.cookie,
      });
      expect(firstPage.status).toBe(200);
      const first = await json<{
        items: Array<{ id: string }>;
        next_cursor: string | null;
      }>(firstPage);
      expect(first.items).toHaveLength(2);
      expect(first.next_cursor).toBeTruthy();
      expect(forbiddenKeysIn(first)).toEqual([]);
      const secondPage = await req(
        h,
        `/api/v1/users?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
        { cookie: seed.admin.cookie },
      );
      const second = await json<{ items: Array<{ id: string }> }>(secondPage);
      const firstIds = new Set(first.items.map((item) => item.id));
      for (const item of second.items)
        expect(firstIds.has(item.id)).toBe(false);
      const malformed = await req(h, "/api/v1/users?cursor=%%%", {
        cookie: seed.admin.cookie,
      });
      expect(malformed.status).toBe(400);
      expect(await errorCode(malformed)).toBe("validation_failed");
      const badLimit = await req(h, "/api/v1/users?limit=999", {
        cookie: seed.admin.cookie,
      });
      expect(badLimit.status).toBe(400);
    });

    it("updates profile fields via PATCH /users/me", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const me = await req(h, "/api/v1/users/me", { cookie: user.cookie });
      expect(me.status).toBe(200);
      const renamed = await req(h, "/api/v1/users/me", {
        method: "PATCH",
        cookie: user.cookie,
        json: { name: "Renamed Person" },
      });
      expect(renamed.status).toBe(200);
      expect((await json(renamed)).name).toBe("Renamed Person");
    });

    it("changes roles and toggles disabled via PATCH /users/:id", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const user = await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
      });
      const notAdmin = await req(h, `/api/v1/users/${user.id}`, {
        method: "PATCH",
        cookie: seed.manager.cookie,
        json: { role: "admin" },
      });
      expect(notAdmin.status).toBe(403);
      const promoted = await req(h, `/api/v1/users/${user.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { role: "admin" },
      });
      expect(promoted.status).toBe(200);
      expect((await json(promoted)).role).toBe("admin");
      const demoted = await req(h, `/api/v1/users/${user.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { role: "member", disabled: true },
      });
      expect(demoted.status).toBe(200);
      const body = await json(demoted);
      expect(body.role).toBe("member");
      expect(body.disabled_at).toBeTruthy();
      const enabled = await req(h, `/api/v1/users/${user.id}`, {
        method: "PATCH",
        cookie: seed.admin.cookie,
        json: { disabled: false },
      });
      expect((await json(enabled)).disabled_at).toBeNull();
    });

    it("guards the last admin against demote, disable, and delete", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const { admin } = await createIsolatedWorkspace(h, seed.passwordHash);
      const demote = await req(h, `/api/v1/users/${admin.id}`, {
        method: "PATCH",
        cookie: admin.cookie,
        json: { role: "member" },
      });
      expect(demote.status).toBe(409);
      expect(await errorCode(demote)).toBe("conflict");
      const disable = await req(h, `/api/v1/users/${admin.id}`, {
        method: "PATCH",
        cookie: admin.cookie,
        json: { disabled: true },
      });
      expect(disable.status).toBe(409);
      const selfDelete = await req(h, `/api/v1/users/${admin.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      });
      expect(selfDelete.status).toBe(409);
      const stillAdmin = await req(h, "/api/v1/users/me", {
        cookie: admin.cookie,
      });
      expect((await json(stillAdmin)).role).toBe("admin");
    });

    it("deletes unreferenced users and 409s referenced ones", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const { workspaceId, admin } = await createIsolatedWorkspace(
        h,
        seed.passwordHash,
      );
      const disposable = await createUser(h, {
        workspaceId,
        passwordHash: seed.passwordHash,
      });
      const removed = await req(h, `/api/v1/users/${disposable.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      });
      expect(removed.status).toBe(204);
      const creator = await createUser(h, {
        workspaceId,
        passwordHash: seed.passwordHash,
      });
      await createProject(h, creator);
      const referenced = await req(h, `/api/v1/users/${creator.id}`, {
        method: "DELETE",
        cookie: admin.cookie,
      });
      expect(referenced.status).toBe(409);
      const missing = await req(h, "/api/v1/users/01ARZ3NDEKTSV4RRFFQ69G5FAV", {
        method: "DELETE",
        cookie: admin.cookie,
      });
      expect(missing.status).toBe(404);
    });
  });

  describe("invites", () => {
    const validGrantInvite = async (h: ContractHarness, ctx2: SuiteContext) => {
      const seed = ctx2.seed();
      const email = uniqueEmail();
      const response = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: {
          email,
          role: "member",
          project_grants: [
            { project_id: seed.restricted.id, role: "commenter" },
          ],
        },
      });
      expect(response.status).toBe(201);
      const body = await json<{
        invite: Record<string, unknown> & { id: string };
        accept_url: string;
      }>(response);
      const token = body.accept_url.split("/invite/")[1] ?? "";
      expect(token.startsWith("oli_")).toBe(true);
      return { email, token, invite: body.invite };
    };

    it("runs the full lifecycle: create, lookup, accept with grants applied", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const { email, token, invite } = await validGrantInvite(h, ctx);
      expect(assertSnakeCaseKeys(invite)).toEqual([]);
      expect(invite).not.toHaveProperty("token_hash");
      const lookup = await req(h, "/api/v1/invites/lookup", {
        json: { token },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(lookup.status).toBe(200);
      const lookupBody = await json(lookup);
      expect(lookupBody.email).toBe(email);
      expect(lookupBody.workspace_name).toBe("Contract Workspace");
      const weak = await req(h, "/api/v1/invites/accept", {
        json: { token, name: "Weak", password: "short" },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(weak.status).toBe(400);
      const accepted = await req(h, "/api/v1/invites/accept", {
        json: { token, name: "Invited Person", password: PASSWORD },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(accepted.status).toBe(201);
      const cookie = accepted.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toContain("ol_session=");
      const restrictedRead = await req(
        h,
        `/api/v1/projects/${seed.restricted.id}`,
        { cookie },
      );
      expect(restrictedRead.status).toBe(200);
      expect((await json(restrictedRead)).my_role).toBe("commenter");
      const reused = await req(h, "/api/v1/invites/lookup", {
        json: { token },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(reused.status).toBe(404);
    });

    it("rejects invites for existing users, duplicates, and bad grants", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const existing = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email: seed.editor.email, role: "member" },
      });
      expect(existing.status).toBe(409);
      const email = uniqueEmail();
      const first = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email, role: "member" },
      });
      expect(first.status).toBe(201);
      const duplicate = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email, role: "member" },
      });
      expect(duplicate.status).toBe(409);
      const badGrant = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: {
          email: uniqueEmail(),
          role: "member",
          project_grants: [
            { project_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "viewer" },
          ],
        },
      });
      expect(badGrant.status).toBe(400);
      const notAdmin = await req(h, "/api/v1/invites", {
        cookie: seed.manager.cookie,
        json: { email: uniqueEmail(), role: "member" },
      });
      expect(notAdmin.status).toBe(403);
    });

    it("409s acceptance when the email gained an account since the invite", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const email = uniqueEmail();
      const created = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email, role: "member" },
      });
      const body = await json<{ accept_url: string }>(created);
      const token = body.accept_url.split("/invite/")[1] ?? "";
      await createUser(h, {
        workspaceId: seed.workspaceId,
        passwordHash: seed.passwordHash,
        email,
        session: false,
      });
      const accepted = await req(h, "/api/v1/invites/accept", {
        json: { token, name: "Too Late", password: PASSWORD },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(accepted.status).toBe(409);
    });

    it("expires invites after seven days", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email: uniqueEmail(), role: "member" },
      });
      const body = await json<{ accept_url: string }>(created);
      const token = body.accept_url.split("/invite/")[1] ?? "";
      await travel(h.clock, 7 * DAY + 60_000, async () => {
        const lookup = await req(h, "/api/v1/invites/lookup", {
          json: { token },
          headers: { "x-forwarded-for": uniqueIp() },
        });
        expect(lookup.status).toBe(404);
        const accept = await req(h, "/api/v1/invites/accept", {
          json: { token, name: "Late", password: PASSWORD },
          headers: { "x-forwarded-for": uniqueIp() },
        });
        expect(accept.status).toBe(404);
      });
    });

    it("lists pending invites with pagination and revokes them", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email: uniqueEmail(), role: "member" },
      });
      const body = await json<{
        invite: { id: string };
        accept_url: string;
      }>(created);
      const token = body.accept_url.split("/invite/")[1] ?? "";
      const list = await req(h, "/api/v1/invites?limit=1", {
        cookie: seed.admin.cookie,
      });
      expect(list.status).toBe(200);
      const listBody = await json<{ items: Array<{ id: string }> }>(list);
      expect(listBody.items).toHaveLength(1);
      const notAdmin = await req(h, "/api/v1/invites", {
        cookie: seed.viewer.cookie,
      });
      expect(notAdmin.status).toBe(403);
      const revoked = await req(h, `/api/v1/invites/${body.invite.id}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
      expect(revoked.status).toBe(204);
      const lookup = await req(h, "/api/v1/invites/lookup", {
        json: { token },
        headers: { "x-forwarded-for": uniqueIp() },
      });
      expect(lookup.status).toBe(404);
      const missing = await req(h, `/api/v1/invites/${body.invite.id}`, {
        method: "DELETE",
        cookie: seed.admin.cookie,
      });
      expect(missing.status).toBe(404);
    });

    it("rate limits invite lookup and accept per IP with window reset", async () => {
      const h = ctx.h();
      const lookupIp = uniqueIp();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await req(h, "/api/v1/invites/lookup", {
          json: { token: "oli_not-a-real-token" },
          headers: { "x-forwarded-for": lookupIp },
        });
        expect(response.status).toBe(404);
      }
      const limited = await req(h, "/api/v1/invites/lookup", {
        json: { token: "oli_not-a-real-token" },
        headers: { "x-forwarded-for": lookupIp },
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      await travel(h.clock, 5 * 60 * 1000 + 1000, async () => {
        const reset = await req(h, "/api/v1/invites/lookup", {
          json: { token: "oli_not-a-real-token" },
          headers: { "x-forwarded-for": lookupIp },
        });
        expect(reset.status).toBe(404);
      });
      const acceptIp = uniqueIp();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await req(h, "/api/v1/invites/accept", {
          json: { token: "oli_bogus", name: "N", password: PASSWORD },
          headers: { "x-forwarded-for": acceptIp },
        });
        expect(response.status).toBe(404);
      }
      const acceptLimited = await req(h, "/api/v1/invites/accept", {
        json: { token: "oli_bogus", name: "N", password: PASSWORD },
        headers: { "x-forwarded-for": acceptIp },
      });
      expect(acceptLimited.status).toBe(429);
    });

    it("keeps invite admin surfaces out of the other workspace", async () => {
      const h = ctx.h();
      const seed = ctx.seed();
      const created = await req(h, "/api/v1/invites", {
        cookie: seed.admin.cookie,
        json: { email: uniqueEmail(), role: "member" },
      });
      const body = await json<{ invite: { id: string } }>(created);
      const foreignRevoke = await req(h, `/api/v1/invites/${body.invite.id}`, {
        method: "DELETE",
        cookie: seed.other.admin.cookie,
      });
      expect(foreignRevoke.status).toBe(404);
    });
  });
};
