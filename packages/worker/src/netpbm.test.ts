import { describe, expect, it } from "vitest";
import { readNetpbm } from "./netpbm.js";

const ppm = (
  width: number,
  height: number,
  maxValue: number,
  samples: number[],
  magic = "P6",
): Uint8Array => {
  const header = Buffer.from(
    `${magic}\n${String(width)} ${String(height)}\n${String(maxValue)}\n`,
    "ascii",
  );
  const wide = maxValue > 255;
  const body = Buffer.alloc(samples.length * (wide ? 2 : 1));
  samples.forEach((value, index) => {
    if (wide) body.writeUInt16BE(value, index * 2);
    else body[index] = value;
  });
  return Buffer.concat([header, body]);
};

describe("readNetpbm", () => {
  it("reads an 8-bit P6", () => {
    const image = readNetpbm(ppm(2, 1, 255, [10, 20, 30, 200, 210, 220]));
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect([...image.data]).toEqual([10, 20, 30, 200, 210, 220]);
  });

  it("reduces a 16-bit P6 to eight bits", () => {
    /* Big-endian samples, and the high byte is the answer. */
    const image = readNetpbm(ppm(1, 1, 65535, [0x1234, 0xabcd, 0xffff]));
    expect([...image.data]).toEqual([0x12, 0xab, 0xff]);
    expect(image.maxValue).toBe(65535);
  });

  it("reads a greyscale P5 as grey", () => {
    const image = readNetpbm(ppm(2, 1, 255, [7, 250], "P5"));
    expect([...image.data]).toEqual([7, 7, 7, 250, 250, 250]);
  });

  it("scales an odd maximum onto the full range", () => {
    const image = readNetpbm(ppm(1, 1, 100, [0, 50, 100]));
    expect([...image.data]).toEqual([0, 127, 255]);
  });

  it("skips comments in the header", () => {
    const bytes = Buffer.concat([
      Buffer.from("P6\n# written by something\n1 1\n255\n", "ascii"),
      Buffer.from([1, 2, 3]),
    ]);
    expect([...readNetpbm(bytes).data]).toEqual([1, 2, 3]);
  });

  it("refuses what it cannot read rather than returning half a picture", () => {
    expect(() =>
      readNetpbm(Buffer.from("P3\n1 1\n255\n0 0 0", "ascii")),
    ).toThrow(/magic/i);
    expect(() => readNetpbm(ppm(4, 4, 255, [1, 2, 3]))).toThrow(/shorter/i);
    expect(() => readNetpbm(Buffer.from("P6\n0 0\n255\n", "ascii"))).toThrow(
      /dimensions/i,
    );
    expect(() => readNetpbm(Buffer.from("P6\n1 1\n99999\n", "ascii"))).toThrow(
      /out of range/i,
    );
  });
});
