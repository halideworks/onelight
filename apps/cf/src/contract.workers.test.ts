import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

describe("Workers and D1 contract", () => {
  it("serves health and runs setup against the D1 binding", async () => {
    const health = await SELF.fetch("http://example.com/healthz");
    expect(health.status).toBe(200);
    const setup = await SELF.fetch("http://example.com/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_name: "D1 test",
        name: "Admin",
        email: "admin@example.com",
        password: "a-strong-test-password",
      }),
    });
    expect(setup.status).toBe(201);
  });
});
