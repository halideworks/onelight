import { describe, expect, it } from "vitest";
import { isShareLandingPath } from "./share-shell.js";

describe("isShareLandingPath", () => {
  it("claims the share landing page, with or without a trailing slash", () => {
    expect(isShareLandingPath("/s/AHqGL7RclTDTU6H35qss7l")).toBe(true);
    expect(isShareLandingPath("/s/AHqGL7RclTDTU6H35qss7l/")).toBe(true);
  });

  it("leaves the download target to the API", () => {
    /* The regression: a top-level navigation to this path sends
       Accept: text/html, so an Accept-only test handed it the SPA shell and
       the viewer got a 404 instead of their file. */
    expect(
      isShareLandingPath("/s/AHqGL7RclTDTU6H35qss7l/assets/01H/media/file"),
    ).toBe(false);
  });

  it("leaves every other nested share endpoint to the API", () => {
    for (const nested of [
      "/s/slug/access",
      "/s/slug/assets",
      "/s/slug/assets/01H",
      "/s/slug/assets/01H/download",
      "/s/slug/assets/01H/comments",
      "/s/slug/approval",
    ])
      expect(isShareLandingPath(nested)).toBe(false);
  });

  it("does not claim paths that only look like shares", () => {
    for (const other of ["/s", "/s/", "/settings", "/shares/slug", "/"])
      expect(isShareLandingPath(other)).toBe(false);
  });
});
