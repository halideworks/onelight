import { describe, expect, it } from "vitest";
import { shouldRequestReferencePlayback } from "./reference-selection.js";

describe("reference playback selection", () => {
  it("keeps automatic mode native until the platform matrix is qualified", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "warning",
        available: true,
        automaticQualified: false,
      }),
    ).toBe(false);
  });

  it("selects an available qualified reference path for a warning", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "automatic",
        selfCheckOutcome: "warning",
        available: true,
        automaticQualified: true,
      }),
    ).toBe(true);
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

  it("never requests an unavailable path", () => {
    expect(
      shouldRequestReferencePlayback({
        mode: "reference",
        selfCheckOutcome: "warning",
        available: false,
        automaticQualified: true,
      }),
    ).toBe(false);
  });
});
