import { describe, expect, it, vi, beforeEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookup(...args),
}));

const { resolveWebhookHost } = await import("./webhook-fetch.js");

describe("resolving a webhook host before connecting", () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  /* The whole point: the URL is public, the name is public, and the answer
     is not. Nothing in the URL string can catch this. */
  it("refuses a public name that answers with a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const result = await resolveWebhookHost("hooks.example.com");
    expect(result).toHaveProperty("problem");
    expect((result as { problem: string }).problem).toMatch(/10\.0\.0\.5/);
  });

  it("refuses loopback and link-local answers too", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::1"]) {
      lookup.mockResolvedValue([
        { address, family: address.includes(":") ? 6 : 4 },
      ]);
      expect(
        await resolveWebhookHost("hooks.example.com"),
        address,
      ).toHaveProperty("problem");
    }
  });

  /* One private answer condemns the name. Picking the public one out of a
     mixed set trusts whichever record happened to be read first. */
  it("refuses a mixed answer rather than choosing the public address", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);
    const result = await resolveWebhookHost("hooks.example.com");
    expect(result).toHaveProperty("problem");
    expect((result as { problem: string }).problem).toMatch(/192\.168\.1\.10/);
  });

  it("accepts a name that answers only with public addresses", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const result = await resolveWebhookHost("hooks.example.com");
    expect(result).not.toHaveProperty("problem");
    expect(
      (result as { addresses: Array<{ address: string }> }).addresses,
    ).toHaveLength(2);
  });

  it("refuses a name that resolves to nothing at all", async () => {
    lookup.mockResolvedValue([]);
    expect(await resolveWebhookHost("hooks.example.com")).toHaveProperty(
      "problem",
    );
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await resolveWebhookHost("hooks.example.com")).toHaveProperty(
      "problem",
    );
  });
});

describe("delivering to a real endpoint", () => {
  /* A 204 is the most ordinary answer a webhook receiver gives, and building
     a Response with a body at that status throws. */
  it("handles a no-content answer", async () => {
    const { createServer } = await import("node:http");
    const { pinnedWebhookFetch } = await import("./webhook-fetch.js");
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      // A literal address skips resolution, which is what lets this run
      // against a loopback server at all.
      const response = await pinnedWebhookFetch(
        `http://127.0.0.1:${String(port)}/hook`,
        { method: "POST", body: "{}", headers: {} },
      );
      expect(response.status).toBe(204);
      expect(response.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns the status and body for an ordinary answer", async () => {
    const { createServer } = await import("node:http");
    const { pinnedWebhookFetch } = await import("./webhook-fetch.js");
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("nope");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      const response = await pinnedWebhookFetch(
        `http://127.0.0.1:${String(port)}/hook`,
        { method: "POST", body: "{}", headers: {} },
      );
      expect(response.status).toBe(500);
      expect(response.ok).toBe(false);
      expect(await response.text()).toBe("nope");
    } finally {
      server.close();
    }
  });
});
