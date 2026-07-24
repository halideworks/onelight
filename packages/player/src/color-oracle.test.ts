import { describe, expect, it } from "vitest";
import {
  COLOR_ORACLE_PATCHES,
  compareColorOracle,
  type ColorPatchReading,
} from "./color-oracle.js";

const canonicalReadings = (): ColorPatchReading[] =>
  COLOR_ORACLE_PATCHES.map((patch) => ({
    name: patch.name,
    rgb: [...patch.srgb],
  }));

const replaceReading = (
  readings: ColorPatchReading[],
  name: string,
  rgb: [number, number, number],
): void => {
  const index = readings.findIndex((reading) => reading.name === name);
  if (index < 0) throw new Error(`Unknown oracle patch ${name}.`);
  readings[index] = { name, rgb };
};

describe("color oracle", () => {
  it("pins the canonical fixture geometry and encoded reference bytes", () => {
    expect(COLOR_ORACLE_PATCHES).toMatchInlineSnapshot(`
      [
        {
          "name": "grey40_left",
          "nominal": [
            102,
            102,
            102,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 70,
            "y": 200,
          },
          "srgb": [
            102,
            102,
            102,
          ],
          "tolerance": [
            2,
            2,
            2,
          ],
        },
        {
          "name": "white75",
          "nominal": [
            191,
            191,
            191,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 218,
            "y": 200,
          },
          "srgb": [
            191,
            191,
            191,
          ],
          "tolerance": [
            2,
            2,
            2,
          ],
        },
        {
          "name": "yellow75",
          "nominal": [
            191,
            191,
            0,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 357,
            "y": 200,
          },
          "srgb": [
            191,
            191,
            0,
          ],
          "tolerance": [
            2,
            2,
            12,
          ],
        },
        {
          "name": "cyan75",
          "nominal": [
            0,
            191,
            191,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 493,
            "y": 200,
          },
          "srgb": [
            0,
            191,
            190,
          ],
          "tolerance": [
            2,
            2,
            12,
          ],
        },
        {
          "name": "green75",
          "nominal": [
            0,
            191,
            0,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 632,
            "y": 200,
          },
          "srgb": [
            0,
            191,
            0,
          ],
          "tolerance": [
            2,
            2,
            12,
          ],
        },
        {
          "name": "magenta75",
          "nominal": [
            191,
            0,
            191,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 771,
            "y": 200,
          },
          "srgb": [
            191,
            0,
            192,
          ],
          "tolerance": [
            2,
            2,
            12,
          ],
        },
        {
          "name": "red75",
          "nominal": [
            191,
            0,
            0,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 908,
            "y": 200,
          },
          "srgb": [
            191,
            0,
            1,
          ],
          "tolerance": [
            2,
            2,
            12,
          ],
        },
        {
          "name": "blue75",
          "nominal": [
            0,
            0,
            191,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 1048,
            "y": 200,
          },
          "srgb": [
            0,
            0,
            191,
          ],
          "tolerance": [
            2,
            2,
            12,
          ],
        },
        {
          "name": "grey40_right",
          "nominal": [
            102,
            102,
            102,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 1193,
            "y": 200,
          },
          "srgb": [
            102,
            102,
            102,
          ],
          "tolerance": [
            2,
            2,
            2,
          ],
        },
        {
          "name": "black0",
          "nominal": [
            0,
            0,
            0,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 784,
            "y": 620,
          },
          "srgb": [
            0,
            0,
            0,
          ],
          "tolerance": [
            2,
            2,
            2,
          ],
        },
        {
          "name": "white100",
          "nominal": [
            255,
            255,
            255,
          ],
          "rect": {
            "h": 20,
            "w": 20,
            "x": 496,
            "y": 620,
          },
          "srgb": [
            255,
            255,
            255,
          ],
          "tolerance": [
            2,
            2,
            2,
          ],
        },
      ]
    `);
  });

  it("passes the canonical readings and returns every measured delta", () => {
    const result = compareColorOracle(canonicalReadings());
    expect(result.status).toBe("pass");
    expect(result.deviation).toBe("none");
    expect(result.failures).toEqual([]);
    expect(result.deltas).toHaveLength(COLOR_ORACLE_PATCHES.length);
  });

  it("collects every failing channel instead of stopping at the first", () => {
    const readings = canonicalReadings();
    replaceReading(readings, "yellow75", [170, 160, 20]);
    replaceReading(readings, "black0", [16, 16, 16]);
    const result = compareColorOracle(readings);
    expect(result.failures.map((failure) => failure.message)).toEqual([
      "yellow75 channel 0: got 170,160,20, reference 191,191,0 (nominal 191,191,0, tolerance 2)",
      "yellow75 channel 1: got 170,160,20, reference 191,191,0 (nominal 191,191,0, tolerance 2)",
      "yellow75 channel 2: got 170,160,20, reference 191,191,0 (nominal 191,191,0, tolerance 12)",
      "black0 channel 0: got 16,16,16, reference 0,0,0 (nominal 0,0,0, tolerance 2)",
      "black0 channel 1: got 16,16,16, reference 0,0,0 (nominal 0,0,0, tolerance 2)",
      "black0 channel 2: got 16,16,16, reference 0,0,0 (nominal 0,0,0, tolerance 2)",
    ]);
  });

  it("requires pinned engine deviations to remain byte-exact", () => {
    const readings = canonicalReadings();
    replaceReading(readings, "white75", [188, 188, 188]);
    expect(
      compareColorOracle(readings, {
        pinned: { white75: [188, 188, 188] },
      }).failures,
    ).toEqual([]);
    replaceReading(readings, "white75", [189, 188, 188]);
    expect(
      compareColorOracle(readings, {
        pinned: { white75: [188, 188, 188] },
      }).failures.map((failure) => failure.message),
    ).toEqual([
      "white75: got 189,188,188, pinned deviation 188,188,188 (reference 191,191,191); the decoder changed, re-derive or delete the pin",
    ]);
  });

  it("classifies diagnostic families without applying a correction", () => {
    const range = canonicalReadings();
    replaceReading(range, "black0", [16, 16, 16]);
    replaceReading(range, "white100", [235, 235, 235]);
    expect(compareColorOracle(range).deviation).toBe("range");

    const transfer = canonicalReadings();
    replaceReading(transfer, "grey40_left", [90, 90, 90]);
    replaceReading(transfer, "grey40_right", [90, 90, 90]);
    replaceReading(transfer, "white75", [175, 175, 175]);
    expect(compareColorOracle(transfer).deviation).toBe("transfer");

    const matrix = canonicalReadings();
    replaceReading(matrix, "yellow75", [170, 180, 0]);
    replaceReading(matrix, "cyan75", [0, 170, 180]);
    expect(compareColorOracle(matrix).deviation).toBe("matrix");

    const incomplete = canonicalReadings().filter(
      (reading) => reading.name !== "white100",
    );
    expect(compareColorOracle(incomplete).deviation).toBe("incomplete");
  });
});
