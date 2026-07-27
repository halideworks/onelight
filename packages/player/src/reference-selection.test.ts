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
  /* The reference renderer tone-maps HDR onto an SDR canvas. That is right
     for a display that cannot show the range and wrong for one that can, so
     automatic must not quietly swap a native HDR grade for a tone-mapped
     copy. Observed on a real HDR display: HDR clips played back looking like
     BT.709. */
  it("leaves a qualified native HDR rendition alone in automatic", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "pass",
        available: true,
        automaticQualified: true,
        nativeHdrQualified: true,
      }),
    ).toBe(false);
  });

  it("still prefers reference for everything that is not HDR", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "pass",
        available: true,
        automaticQualified: true,
        nativeHdrQualified: false,
      }),
    ).toBe(true);
  });

  /* Asking for it by name is still honoured: a reviewer who wants the
     frame-accurate path on HDR material can have it, tone map and all. */
  it("honours an explicit reference choice even on HDR", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "reference",
        selfCheckOutcome: null,
        available: true,
        automaticQualified: true,
        nativeHdrQualified: true,
      }),
    ).toBe(true);
  });
});
