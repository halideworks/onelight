import { describe, expect, it } from "vitest";
import { shouldRequestReferencePlayback } from "./reference-selection.js";

describe("reference playback selection", () => {
  /* The accurate renderer is what automatic means. It used to wait for the
     decode self-check to report a problem first, which left every reviewer on
     a browser whose decode merely looked fine watching the browser's picture
     instead of the file's. */
  it("selects reference in automatic mode whenever the path is available", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "pass",
        available: true,
        automaticQualified: true,
      }),
    ).toBe(true);
  });

  it("selects reference in automatic mode for a warning as well", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "warning",
        available: true,
        automaticQualified: true,
      }),
    ).toBe(true);
  });

  /* The per-platform-class switch survives so the default can be withdrawn
     from a hardware class that turns out to need it, without reaching back
     into the decode path. */
  it("leaves automatic mode native when the platform class is unqualified", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "warning",
        available: true,
        automaticQualified: false,
      }),
    ).toBe(false);
  });

  it("allows an explicit reference choice without automatic qualification", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "reference",
        selfCheckOutcome: null,
        available: true,
        automaticQualified: false,
      }),
    ).toBe(true);
  });

  /* Availability is the fail-closed contract -- complete, agreeing colour
     metadata and a runtime that passed its capability checks. Nothing here
     may override it. */
  it("never requests an unavailable path", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "reference",
        selfCheckOutcome: "warning",
        available: false,
        automaticQualified: true,
      }),
    ).toBe(false);
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "pass",
        available: false,
        automaticQualified: true,
      }),
    ).toBe(false);
  });
});
