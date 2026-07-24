import { describe, expect, it, vi } from "vitest";
import {
  COLOR_PLAYBACK_MODE_KEY,
  colorContractFrom,
  colorContractValue,
  colorMaximumDelta,
  readColorPlaybackMode,
  renditionColorContracts,
  writeColorPlaybackMode,
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

  it("stores only supported playback preferences", () => {
    const setItem = vi.fn();
    writeColorPlaybackMode({ setItem }, "native");
    expect(setItem).toHaveBeenCalledWith(COLOR_PLAYBACK_MODE_KEY, "native");

    expect(readColorPlaybackMode({ getItem: () => "reference" })).toBe(
      "reference",
    );
    expect(readColorPlaybackMode({ getItem: () => "future" })).toBe(
      "automatic",
    );
    expect(readColorPlaybackMode(null)).toBe("automatic");
  });

  it("survives storage access failures", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readColorPlaybackMode(storage)).toBe("automatic");
    expect(() => writeColorPlaybackMode(storage, "automatic")).not.toThrow();
  });
});
