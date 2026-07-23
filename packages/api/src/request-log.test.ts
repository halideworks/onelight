import { describe, expect, it } from "vitest";
import { redactBearerPath } from "./request-log.js";

describe("request log path redaction", () => {
  it("redacts public share and transfer bearer slugs", () => {
    expect(redactBearerPath("/api/v1/s/client-secret/comments")).toBe(
      "/api/v1/s/[redacted]/comments",
    );
    expect(redactBearerPath("/api/v1/t/drop-secret/uploads/one")).toBe(
      "/api/v1/t/[redacted]/uploads/one",
    );
    expect(redactBearerPath("/s/client-secret")).toBe("/s/[redacted]");
    expect(redactBearerPath("/t/drop-secret/access")).toBe(
      "/t/[redacted]/access",
    );
  });

  it("leaves ordinary application paths intact", () => {
    expect(redactBearerPath("/api/v1/projects/one")).toBe(
      "/api/v1/projects/one",
    );
  });
});
