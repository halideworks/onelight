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

describe("HDR takes precedence over the reference tone map", () => {
  /* The reference renderer tone-maps HDR onto an SDR canvas, and no browser
     will give it anything else: measured on shipped Chrome 150 and Safari
     26.5.2, WebGL cannot output HDR at all and the one canvas that can needs a
     display headroom that is unqueryable and slides with the brightness
     slider. So on a display that can show the grade, native is not merely
     preferred, it is the only way to see the thing being reviewed. */
  it("gives HDR to native wherever the display can show it", () => {
    for (const mode of ["automatic", "reference"] as const) {
      expect(
        shouldRequestReferencePlayback({
          mode,
          selfCheckOutcome: "pass",
          available: true,
          automaticQualified: true,
          hdrHandledNatively: true,
        }),
        `mode ${mode} must not take HDR from a display that can show it`,
      ).toBe(false);
    }
  });

  /* An SDR display cannot show the grade whoever draws it, so the tone map is
     happening either way -- and reference's is better than the browser's, and
     frame-accurate with it. HDR keeps reference there. */
  it("keeps HDR on reference where the display cannot show it", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "pass",
        available: true,
        automaticQualified: true,
        hdrHandledNatively: false,
      }),
    ).toBe(true);
  });

  /* An SDR proxy on an HDR display has no grade at stake, so nothing is being
     protected and reference stays the default. */
  it("still prefers reference for everything that is not HDR", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "pass",
        available: true,
        automaticQualified: true,
      }),
    ).toBe(true);
  });
});
