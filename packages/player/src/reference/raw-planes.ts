import type {
  PlaneLayoutTransfer,
  PlaneTransfer,
  ReferenceChromaLocation,
  ReferenceColorContract,
} from "./protocol.js";

export class UnsupportedRawPlaneError extends Error {}

export const referenceColorFrom = (
  value: VideoColorSpace | VideoColorSpaceInit,
): ReferenceColorContract | null => {
  const primaries = value.primaries;
  const transfer = value.transfer;
  const matrix = value.matrix;
  const fullRange = value.fullRange;
  if (
    typeof primaries !== "string" ||
    typeof transfer !== "string" ||
    typeof matrix !== "string" ||
    typeof fullRange !== "boolean"
  )
    return null;
  return {
    primaries,
    transfer,
    matrix,
    range: fullRange ? "pc" : "tv",
  };
};

export const referenceColorsAgree = (
  actual: ReferenceColorContract,
  expected: ReferenceColorContract,
): boolean =>
  actual.primaries === expected.primaries &&
  actual.transfer === expected.transfer &&
  actual.matrix === expected.matrix &&
  actual.range === expected.range;

const exactRect = (rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } => {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (
    values.some((value) => !Number.isSafeInteger(value)) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    throw new UnsupportedRawPlaneError(
      "Decoded frame has an invalid coded rectangle.",
    );
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
};

const planeGeometry = (
  format: "I420" | "NV12",
  width: number,
  height: number,
): Array<{ rowBytes: number; rows: number }> => {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  if (format === "I420")
    return [
      { rowBytes: width, rows: height },
      { rowBytes: chromaWidth, rows: chromaHeight },
      { rowBytes: chromaWidth, rows: chromaHeight },
    ];
  return [
    { rowBytes: width, rows: height },
    { rowBytes: chromaWidth * 2, rows: chromaHeight },
  ];
};

const validatePlaneLayouts = (
  format: "I420" | "NV12",
  width: number,
  height: number,
  byteLength: number,
  layout: readonly PlaneLayoutTransfer[],
): void => {
  const geometry = planeGeometry(format, width, height);
  if (layout.length !== geometry.length)
    throw new UnsupportedRawPlaneError(
      `Decoded ${format} frame returned ${layout.length} planes instead of ${geometry.length}.`,
    );

  const spans = layout.map((plane, index) => {
    const shape = geometry[index];
    if (!shape)
      throw new UnsupportedRawPlaneError("Plane geometry is missing.");
    if (
      !Number.isSafeInteger(plane.offset) ||
      plane.offset < 0 ||
      !Number.isSafeInteger(plane.stride) ||
      plane.stride < shape.rowBytes
    )
      throw new UnsupportedRawPlaneError(
        `Decoded ${format} plane ${index} has an invalid layout.`,
      );
    const end = plane.offset + plane.stride * (shape.rows - 1) + shape.rowBytes;
    if (!Number.isSafeInteger(end) || end > byteLength)
      throw new UnsupportedRawPlaneError(
        `Decoded ${format} plane ${index} exceeds its transfer buffer.`,
      );
    return { start: plane.offset, end };
  });

  for (let left = 0; left < spans.length; left += 1) {
    const a = spans[left];
    if (!a) continue;
    for (let right = left + 1; right < spans.length; right += 1) {
      const b = spans[right];
      if (b && a.start < b.end && b.start < a.end)
        throw new UnsupportedRawPlaneError(
          `Decoded ${format} plane layouts overlap.`,
        );
    }
  }
};

export const copyRawFramePlanes = async (
  frame: VideoFrame,
  expectedColor: ReferenceColorContract,
  chromaLocation: ReferenceChromaLocation,
  reusableBuffer?: ArrayBuffer,
): Promise<PlaneTransfer> => {
  if (frame.format !== "I420" && frame.format !== "NV12")
    throw new UnsupportedRawPlaneError(
      `Decoded pixel format ${frame.format ?? "unknown"} is not I420 or NV12.`,
    );
  const color = referenceColorFrom(frame.colorSpace);
  if (!color)
    throw new UnsupportedRawPlaneError(
      "Decoded frame color metadata is incomplete.",
    );
  if (!referenceColorsAgree(color, expectedColor))
    throw new UnsupportedRawPlaneError(
      "Decoded frame color metadata conflicts with rendition metadata.",
    );

  const codedRect = exactRect(
    frame.codedRect ?? {
      x: 0,
      y: 0,
      width: frame.codedWidth,
      height: frame.codedHeight,
    },
  );
  const copyOptions: VideoFrameCopyToOptions = {
    rect: codedRect,
  };
  const allocationSize = frame.allocationSize(copyOptions);
  const buffer =
    reusableBuffer?.byteLength === allocationSize
      ? reusableBuffer
      : new ArrayBuffer(allocationSize);
  const copiedLayout = await frame.copyTo(buffer, copyOptions);
  const layout = copiedLayout.map((plane) => ({
    offset: plane.offset,
    stride: plane.stride,
  }));
  validatePlaneLayouts(
    frame.format,
    codedRect.width,
    codedRect.height,
    buffer.byteLength,
    layout,
  );
  const visible = frame.visibleRect ?? codedRect;
  return {
    format: frame.format,
    buffer,
    layout,
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    codedRect,
    visibleRect: {
      x: visible.x,
      y: visible.y,
      width: visible.width,
      height: visible.height,
    },
    timestampUs: frame.timestamp,
    durationUs: frame.duration,
    color,
    chromaLocation,
  };
};
