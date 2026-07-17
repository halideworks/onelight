import { describe, expect, it } from "vitest";
import { errorCode, req } from "../harness.js";
import type { SuiteContext } from "../context.js";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

/**
 * Every authenticated endpoint documented in the phase 0-3 specs, asserted
 * to return the canonical 401 envelope when called with no credentials.
 * Public endpoints (setup, login, invite lookup/accept, oidc, healthz,
 * openapi, docs, /s/* viewer flows) are covered in their own domains.
 */
const AUTHED_ENDPOINTS: Array<[string, string]> = [
  ["POST", "/api/v1/auth/logout"],
  ["GET", "/api/v1/auth/session"],
  ["GET", "/api/v1/workspace"],
  ["PATCH", "/api/v1/workspace"],
  ["GET", "/api/v1/users"],
  ["GET", "/api/v1/users/me"],
  ["PATCH", "/api/v1/users/me"],
  ["PATCH", `/api/v1/users/${ID}`],
  ["DELETE", `/api/v1/users/${ID}`],
  ["POST", "/api/v1/invites"],
  ["GET", "/api/v1/invites"],
  ["DELETE", `/api/v1/invites/${ID}`],
  ["GET", "/api/v1/tokens"],
  ["POST", "/api/v1/tokens"],
  ["DELETE", `/api/v1/tokens/${ID}`],
  ["GET", "/api/v1/projects"],
  ["POST", "/api/v1/projects"],
  ["GET", `/api/v1/projects/${ID}`],
  ["PATCH", `/api/v1/projects/${ID}`],
  ["POST", `/api/v1/projects/${ID}/cover`],
  ["GET", `/api/v1/projects/${ID}/covers`],
  ["DELETE", `/api/v1/projects/${ID}/covers/${ID}`],
  ["DELETE", `/api/v1/projects/${ID}`],
  ["GET", `/api/v1/projects/${ID}/events`],
  ["GET", `/api/v1/projects/${ID}/members`],
  ["PUT", `/api/v1/projects/${ID}/members/${ID}`],
  ["DELETE", `/api/v1/projects/${ID}/members/${ID}`],
  ["GET", `/api/v1/projects/${ID}/folders`],
  ["POST", `/api/v1/projects/${ID}/folders`],
  ["PATCH", `/api/v1/folders/${ID}`],
  ["DELETE", `/api/v1/folders/${ID}`],
  ["GET", "/api/v1/audit"],
  ["POST", "/api/v1/uploads"],
  ["POST", `/api/v1/uploads/${ID}/multipart`],
  ["GET", `/api/v1/uploads/${ID}/parts`],
  ["GET", `/api/v1/uploads/${ID}/parts/1/url`],
  ["PUT", `/api/v1/uploads/${ID}/parts/1`],
  ["POST", `/api/v1/uploads/${ID}/complete`],
  ["DELETE", `/api/v1/uploads/${ID}`],
  ["POST", `/api/v1/uploads/${ID}/abort`],
  ["GET", `/api/v1/projects/${ID}/assets`],
  ["POST", `/api/v1/projects/${ID}/assets`],
  ["GET", `/api/v1/assets/${ID}`],
  ["PATCH", `/api/v1/assets/${ID}`],
  ["DELETE", `/api/v1/assets/${ID}`],
  ["GET", `/api/v1/assets/${ID}/versions`],
  ["POST", `/api/v1/assets/${ID}/versions`],
  ["POST", `/api/v1/assets/${ID}/trash`],
  ["POST", `/api/v1/assets/${ID}/restore`],
  ["PATCH", `/api/v1/assets/${ID}/approval`],
  ["GET", `/api/v1/versions/${ID}`],
  ["GET", `/api/v1/versions/${ID}/renditions`],
  ["PATCH", `/api/v1/versions/${ID}/stack`],
  ["POST", `/api/v1/versions/${ID}/carry-forward`],
  ["GET", `/api/v1/versions/${ID}/comments`],
  ["POST", `/api/v1/versions/${ID}/comments`],
  ["POST", `/api/v1/versions/${ID}/comments/import`],
  ["PATCH", `/api/v1/comments/${ID}`],
  ["DELETE", `/api/v1/comments/${ID}`],
  ["POST", `/api/v1/comments/${ID}/replies`],
  ["POST", `/api/v1/comments/${ID}/complete`],
  ["POST", `/api/v1/comments/${ID}/reactions`],
  ["DELETE", `/api/v1/comments/${ID}/reactions/thumbs_up`],
  ["POST", `/api/v1/comments/${ID}/attachments`],
  ["GET", `/api/v1/comments/${ID}/attachments/${ID}`],
  ["DELETE", `/api/v1/comments/${ID}/attachments/${ID}`],
  ["GET", "/api/v1/notifications"],
  ["POST", "/api/v1/notifications/read"],
  ["GET", "/api/v1/notifications/preferences"],
  ["PATCH", "/api/v1/notifications/preferences"],
  ["GET", "/api/v1/sessions"],
  ["DELETE", `/api/v1/sessions/${ID}`],
  ["GET", "/api/v1/search?q=anything"],
  ["POST", "/api/v1/shares"],
  ["GET", "/api/v1/shares"],
  ["GET", `/api/v1/shares/${ID}`],
  ["PATCH", `/api/v1/shares/${ID}`],
  ["POST", `/api/v1/shares/${ID}/assets`],
  ["DELETE", `/api/v1/shares/${ID}`],
  ["GET", `/api/v1/shares/${ID}/viewers`],
  ["POST", `/api/v1/shares/${ID}/export`],
  ["POST", `/api/v1/projects/${ID}/export`],
  ["GET", `/api/v1/exports/${ID}`],
  ["GET", `/api/v1/exports/${ID}/download`],
  ["POST", "/api/v1/webhooks"],
  ["GET", "/api/v1/webhooks"],
  ["DELETE", `/api/v1/webhooks/${ID}`],
  ["GET", `/api/v1/jobs/${ID}`],
  ["GET", "/api/v1/admin/jobs"],
  ["GET", "/api/v1/admin/system"],
  ["GET", "/api/v1/media/some/key.mp4"],
];

export const registerEndpointInventory = (ctx: SuiteContext): void => {
  describe("endpoint inventory", () => {
    it("returns the canonical 401 envelope for every authed endpoint", async () => {
      const h = ctx.h();
      for (const [method, path] of AUTHED_ENDPOINTS) {
        const response = await req(h, path, { method, origin: false });
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(await errorCode(response), `${method} ${path}`).toBe(
          "unauthorized",
        );
      }
    });

    it("returns the JSON not_found envelope for unknown routes", async () => {
      const h = ctx.h();
      const response = await req(h, "/api/v1/does-not-exist");
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
    });
  });
};
