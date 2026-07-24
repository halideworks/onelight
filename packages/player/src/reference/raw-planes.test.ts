import { describe, expect, it } from "vitest";
import type { ReferenceColorContract } from "./protocol.js";
import { copyRawFramePlanes, UnsupportedRawPlaneError } from "./raw-planes.js";

const BT709_LIMITED: ReferenceColorContract = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  range: "tv",
};

type FrameStub = {
  frame: VideoFrame;
  allocatedWith: () => VideoFrameCopyToOptions | undefined;
  copiedWith: () => VideoFrameCopyToOptions | undefined;
  closeCount: () => number;
};

const frameStub = (
  format: VideoPixelFormat | null,
  layout: readonly PlaneLayout[],
  overrides: {
    codedRect?: DOMRectReadOnly | null;
    visibleRect?: DOMRectReadOnly | null;
    colorSpace?: VideoColorSpaceInit;
  } = {},
): FrameStub => {
  let allocationOptions: VideoFrameCopyToOptions | undefined;
  let copyOptions: VideoFrameCopyToOptions | undefined;
  let closes = 0;
  const byteLength = 24;
  const frame = {
    format,
    codedWidth: 4,
    codedHeight: 4,
    displayWidth: 4,
    displayHeight: 4,
    codedRect:
      overrides.codedRect ??
      ({ x: 0, y: 0, width: 4, height: 4 } as DOMRectReadOnly),
    visibleRect:
      overrides.visibleRect ??
      ({ x: 0, y: 0, width: 4, height: 4 } as DOMRectReadOnly),
    timestamp: 1_000_000,
    duration: 40_000,
    colorSpace: overrides.colorSpace ?? {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false,
    },
    allocationSize: (options?: VideoFrameCopyToOptions): number => {
      allocationOptions = options;
      return byteLength;
    },
    copyTo: (
      destination: AllowSharedBufferSource,
      options?: VideoFrameCopyToOptions,
    ): Promise<PlaneLayout[]> => {
      copyOptions = options;
      new Uint8Array(destination as ArrayBuffer).fill(128);
      return Promise.resolve(layout.map((plane) => ({ ...plane })));
    },
    close: (): void => {
      closes += 1;
    },
  } as unknown as VideoFrame;
  return {
    frame,
    allocatedWith: () => allocationOptions,
    copiedWith: () => copyOptions,
    closeCount: () => closes,
  };
};

describe("raw reference plane transfer", () => {
  it("copies all coded I420 planes without requesting RGB conversion", async () => {
    const stub = frameStub("I420", [
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ]);

    const result = await copyRawFramePlanes(stub.frame, BT709_LIMITED, "left");

    expect(result.format).toBe("I420");
    expect(result.layout).toEqual([
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ]);
    expect(result.codedRect).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(result.chromaLocation).toBe("left");
    expect(stub.allocatedWith()).toEqual({
      rect: { x: 0, y: 0, width: 4, height: 4 },
    });
    expect(stub.copiedWith()).toEqual(stub.allocatedWith());
    expect(stub.copiedWith()).not.toHaveProperty("format");
    expect(stub.closeCount()).toBe(0);
  });

  it("accepts a bounded non-overlapping NV12 layout", async () => {
    const stub = frameStub("NV12", [
      { offset: 0, stride: 4 },
      { offset: 16, stride: 4 },
    ]);

    const result = await copyRawFramePlanes(stub.frame, BT709_LIMITED, "left");

    expect(result.format).toBe("NV12");
    expect(result.buffer.byteLength).toBe(24);
  });

  it("reuses only an exact-size returned plane buffer", async () => {
    const layout = [
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ];
    const exact = new ArrayBuffer(24);
    const reused = await copyRawFramePlanes(
      frameStub("I420", layout).frame,
      BT709_LIMITED,
      "left",
      exact,
    );
    expect(reused.buffer).toBe(exact);

    const wrongSize = new ArrayBuffer(12);
    const replaced = await copyRawFramePlanes(
      frameStub("I420", layout).frame,
      BT709_LIMITED,
      "left",
      wrongSize,
    );
    expect(replaced.buffer).not.toBe(wrongSize);
    expect(replaced.buffer.byteLength).toBe(24);
  });

  it("rejects browser-converted RGB before allocating a buffer", async () => {
    const stub = frameStub("BGRX", [{ offset: 0, stride: 16 }]);

    await expect(
      copyRawFramePlanes(stub.frame, BT709_LIMITED, "left"),
    ).rejects.toThrow(
      new UnsupportedRawPlaneError(
        "Decoded pixel format BGRX is not I420 or NV12.",
      ),
    );
    expect(stub.allocatedWith()).toBeUndefined();
  });

  it("rejects conflicting or incomplete color metadata", async () => {
    const layout = [
      { offset: 0, stride: 4 },
      { offset: 16, stride: 2 },
      { offset: 20, stride: 2 },
    ];
    const conflicting = frameStub("I420", layout, {
      colorSpace: {
        primaries: "bt470bg",
        transfer: "bt709",
        matrix: "bt709",
        fullRange: false,
      },
    });
    const incomplete = frameStub("I420", layout, {
      colorSpace: {
        primaries: null,
        transfer: "bt709",
        matrix: "bt709",
        fullRange: false,
      },
    });

    await expect(
      copyRawFramePlanes(conflicting.frame, BT709_LIMITED, "left"),
    ).rejects.toThrow(/conflicts/);
    await expect(
      copyRawFramePlanes(incomplete.frame, BT709_LIMITED, "left"),
    ).rejects.toThrow(/incomplete/);
  });

  it("rejects missing, overlapping, short-stride, and out-of-bounds planes", async () => {
    const cases: Array<readonly PlaneLayout[]> = [
      [
        { offset: 0, stride: 4 },
        { offset: 16, stride: 2 },
      ],
      [
        { offset: 0, stride: 4 },
        { offset: 12, stride: 2 },
        { offset: 20, stride: 2 },
      ],
      [
        { offset: 0, stride: 3 },
        { offset: 16, stride: 2 },
        { offset: 20, stride: 2 },
      ],
      [
        { offset: 0, stride: 4 },
        { offset: 16, stride: 2 },
        { offset: 23, stride: 2 },
      ],
    ];

    for (const layout of cases)
      await expect(
        copyRawFramePlanes(
          frameStub("I420", layout).frame,
          BT709_LIMITED,
          "left",
        ),
      ).rejects.toBeInstanceOf(UnsupportedRawPlaneError);
  });
});
