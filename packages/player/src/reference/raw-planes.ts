import {
  isHdrTransfer,
  isSdrGammaTransfer,
  referenceSourceTransfer,
} from "./color-math.js";
import type {
  ReferencePlaneFormat,
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

/*
 * Decide whether a decoded frame is the picture the rendition promised, and
 * return what the renderer must interpret its code values as.
 *
 * Primaries and matrix must match: those are the choices a decoder has no
 * business changing, and disagreement means the frame is not the picture the
 * contract describes. Range is different. It is a property of the samples the
 * decoder actually produced, and the decoder is the authority on its own
 * output: macOS returns limited-range BT.709 as an expanded full-range
 * surface and says so truthfully. Re-expanding those samples because the
 * container said "tv" would crush blacks and clip highlights, so the frame's
 * own range wins, and the transport reports the deviation from the frame it
 * carries. Transfer is only a label here (see isSdrGammaTransfer), so any SDR
 * BT.709-family tag is accepted.
 */
export const reconcileDecodedColor = (
  actual: ReferenceColorContract,
  expected: ReferenceColorContract,
): ReferenceColorContract => {
  if (actual.primaries !== expected.primaries)
    throw new UnsupportedRawPlaneError(
      `Decoded frame color metadata conflicts with rendition metadata: primaries ${actual.primaries} against ${expected.primaries}.`,
    );
  if (actual.matrix !== expected.matrix)
    throw new UnsupportedRawPlaneError(
      `Decoded frame color metadata conflicts with rendition metadata: matrix ${actual.matrix} against ${expected.matrix}.`,
    );
  /* An SDR tag is a label the renderer ignores, so any of the family is
     accepted; PQ and HLG are NOT labels -- they describe genuinely different
     code values and the renderer decodes them differently -- so they are
     accepted only when the container declared them too. A frame claiming PQ
     against an SDR contract is a decoder disagreeing about the picture. */
  if (!isSdrGammaTransfer(actual.transfer)) {
    if (!isHdrTransfer(actual.transfer))
      throw new UnsupportedRawPlaneError(
        `Decoded frame color metadata is outside the SDR BT.709 family: transfer ${actual.transfer}.`,
      );
    if (
      referenceSourceTransfer(actual.transfer) !==
      referenceSourceTransfer(expected.transfer)
    )
      throw new UnsupportedRawPlaneError(
        `Decoded frame transfer ${actual.transfer} conflicts with the rendition's ${expected.transfer}.`,
      );
  }
  return actual;
};

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

/* 10-bit samples occupy two bytes each, so every row is twice as wide in
   bytes while holding the same number of samples. Everything downstream
   reasons in samples; only this function knows about bytes. */
const bytesPerSample = (format: ReferencePlaneFormat): 1 | 2 =>
  format === "I420P10" ? 2 : 1;

const planeGeometry = (
  format: ReferencePlaneFormat,
  width: number,
  height: number,
): Array<{ rowBytes: number; rows: number }> => {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const size = bytesPerSample(format);
  if (format === "I420" || format === "I420P10")
    return [
      { rowBytes: width * size, rows: height },
      { rowBytes: chromaWidth * size, rows: chromaHeight },
      { rowBytes: chromaWidth * size, rows: chromaHeight },
    ];
  return [
    { rowBytes: width, rows: height },
    { rowBytes: chromaWidth * 2, rows: chromaHeight },
  ];
};

const validatePlaneLayouts = (
  format: ReferencePlaneFormat,
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
  /* The DOM lib's VideoPixelFormat predates the 10-bit members the spec now
     carries, so the tag is read as a string and narrowed here rather than
     trusted to the ambient type. */
  const decodedFormat = frame.format as string | null;
  if (
    decodedFormat !== "I420" &&
    decodedFormat !== "NV12" &&
    decodedFormat !== "I420P10"
  )
    throw new UnsupportedRawPlaneError(
      `Decoded pixel format ${decodedFormat ?? "unknown"} is not I420, NV12 or I420P10.`,
    );
  const format: ReferencePlaneFormat = decodedFormat;
  const color = referenceColorFrom(frame.colorSpace);
  if (!color)
    throw new UnsupportedRawPlaneError(
      "Decoded frame color metadata is incomplete.",
    );
  const renderColor = reconcileDecodedColor(color, expectedColor);

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
    format,
    codedRect.width,
    codedRect.height,
    buffer.byteLength,
    layout,
  );
  const visible = frame.visibleRect ?? codedRect;
  return {
    format,
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
    color: renderColor,
    chromaLocation,
  };
};
