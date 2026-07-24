import { describe, expect, it } from "vitest";
import {
  COLOR_CHECK_SCOPE,
  colorCheckPresentation,
  colorContractFrom,
  colorContractValue,
  colorMaximumDelta,
  renditionColorContracts,
} from "./color-playback.js";

describe("color playback presentation", () => {
  it("reads the source and output contracts without inventing missing tags", () => {
    expect(
      renditionColorContracts({
        source_color: {
          primaries: "bt2020",
          transfer: "smpte2084",
          matrix: "bt2020nc",
          range: "tv",
          assumed: false,
        },
        output_color: {
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          range: "tv",
        },
      }),
    ).toEqual({
      source: {
        primaries: "bt2020",
        transfer: "smpte2084",
        matrix: "bt2020nc",
        range: "tv",
        assumed: false,
        assumption: null,
      },
      output: {
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        range: "tv",
        assumed: false,
        assumption: null,
      },
    });
    expect(colorContractFrom({ assumed: true })).toBeNull();
    expect(colorContractValue(null)).toBe("Not reported");
  });

  it("formats the measured maximum channel deltas", () => {
    expect(colorMaximumDelta([1, 3, 2])).toBe("1 R, 3 G, 2 B");
    expect(colorMaximumDelta(null)).toBe("Not measured");
  });

  it("describes a pass as decode readback, not color verification", () => {
    expect(
      colorCheckPresentation({
        outcome: "pass",
        stage: "complete",
        deviation: "none",
        failure: null,
      }),
    ).toEqual({
      label: "Decode check passed",
      state: "passed",
      summary: "Passed at canvas readback",
      detail: "No decode-to-canvas discrepancy was measured.",
    });
    expect(COLOR_CHECK_SCOPE).toContain("A pass is not display calibration.");
    expect(COLOR_CHECK_SCOPE).toContain("ColorSync or ICC transforms");
  });

  it("distinguishes warning, unavailable, and in-flight states", () => {
    expect(colorCheckPresentation(null)).toMatchObject({
      label: "Checking decode",
      state: "checking",
    });
    expect(
      colorCheckPresentation({
        outcome: "warning",
        stage: "complete",
        deviation: "transfer",
        failure: null,
      }),
    ).toMatchObject({
      label: "Decode check warning",
      state: "warning",
      summary: "Warning: transfer deviation",
    });
    expect(
      colorCheckPresentation({
        outcome: "unsupported",
        stage: "canvas",
        deviation: "unclassified",
        failure: "Canvas readback is unavailable.",
      }),
    ).toEqual({
      label: "Decode check unavailable",
      state: "unavailable",
      summary: "Unavailable at canvas",
      detail: "Canvas readback is unavailable.",
    });
  });
});
