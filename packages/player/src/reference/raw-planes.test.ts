import { describe, expect, it } from "vitest";
import type { ReferenceColorContract } from "./protocol.js";
import {
  copyRawFramePlanes,
  reconcileDecodedColor,
  UnsupportedRawPlaneError,
} from "./raw-planes.js";

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
        "Decoded pixel format BGRX is not I420, NV12 or I420P10.",
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

  /*
   * Safari 26 on Apple Silicon, measured against 720p, 1080p, 608x1080 and
   * 2160p BT.709 limited-range proxies at every hardwareAcceleration
   * preference: VideoToolbox returns NV12 whose luma matches ffmpeg's
   * full-range conversion byte for byte (45/44/47 where the limited-range
   * plane reads 55/54/56), tagged fullRange:true and iec61966-2-1. The frame
   * is the picture the rendition promised, so it must be accepted and
   * rendered as what it is.
   */
  it("accepts a platform-converted surface and keeps the decoder's range", async () => {
    const stub = frameStub(
      "NV12",
      [
        { offset: 0, stride: 4 },
        { offset: 16, stride: 4 },
      ],
      {
        colorSpace: {
          primaries: "bt709",
          transfer: "iec61966-2-1",
          matrix: "bt709",
          fullRange: true,
        },
      },
    );

    const planes = await copyRawFramePlanes(stub.frame, BT709_LIMITED, "left");

    expect(planes.format).toBe("NV12");
    expect(planes.color).toEqual({
      primaries: "bt709",
      transfer: "iec61966-2-1",
      matrix: "bt709",
      range: "pc",
    });
  });

  it("reconciles a decoded color against the rendition contract", () => {
    // The decoder's own range and tag survive; they are what the samples are.
    const converted = {
      ...BT709_LIMITED,
      transfer: "iec61966-2-1",
      range: "pc",
    } as const;
    expect(reconcileDecodedColor(converted, BT709_LIMITED)).toEqual(converted);
    expect(reconcileDecodedColor(BT709_LIMITED, BT709_LIMITED)).toEqual(
      BT709_LIMITED,
    );
    // Matrix and primaries are the decoder's to report, never to change.
    expect(() =>
      reconcileDecodedColor(
        { ...BT709_LIMITED, matrix: "smpte170m" },
        BT709_LIMITED,
      ),
    ).toThrow(/conflicts/);
    expect(() =>
      reconcileDecodedColor(
        { ...BT709_LIMITED, primaries: "bt2020" },
        BT709_LIMITED,
      ),
    ).toThrow(/conflicts/);
    /* HLG against an SDR contract is a decoder disagreeing about the picture,
       not a label difference: PQ and HLG describe different code values and
       the renderer decodes them differently, so they are only accepted when
       the container declared them too. */
    expect(() =>
      reconcileDecodedColor(
        { ...BT709_LIMITED, transfer: "hlg" },
        BT709_LIMITED,
      ),
    ).toThrow(/conflicts with the rendition/);
    /* A transfer that is neither SDR nor an HDR curve we implement is still
       refused outright. */
    expect(() =>
      reconcileDecodedColor(
        { ...BT709_LIMITED, transfer: "linear" },
        BT709_LIMITED,
      ),
    ).toThrow(/outside the SDR BT.709 family/);
    /* Matching HDR on both sides passes, and the frame's own tag wins. */
    expect(
      reconcileDecodedColor(
        {
          ...BT709_LIMITED,
          transfer: "smpte2084",
          primaries: "bt2020",
          matrix: "bt2020-ncl",
        },
        {
          ...BT709_LIMITED,
          transfer: "pq",
          primaries: "bt2020",
          matrix: "bt2020-ncl",
        },
      ).transfer,
    ).toBe("smpte2084");
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
