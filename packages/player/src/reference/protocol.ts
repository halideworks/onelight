export const FRAME_WINDOW_BEHIND = 2;
export const FRAME_WINDOW_AHEAD = 3;
export const MAX_OPEN_FRAMES = FRAME_WINDOW_BEHIND + 1 + FRAME_WINDOW_AHEAD;
export const MAX_DECODE_QUEUE = 6;
export const MAX_PLANE_BUFFERS = 8;

export type ReferenceRate = {
  num: number;
  den: number;
};

export type ReferenceColorContract = {
  primaries: string;
  transfer: string;
  matrix: string;
  range: "tv" | "pc";
};

export type ReferenceHardwareAcceleration =
  "no-preference" | "prefer-hardware" | "prefer-software";

export type ReferenceChromaLocation = "left" | "center" | "topleft";

export type ReferenceOpenStage =
  | "fetching rendition metadata"
  | "reading track contract"
  | "qualifying WebCodecs";

export type ExpectedTrack = {
  frameRate: ReferenceRate;
  durationFrames: number | null;
  codedWidth: number | null;
  codedHeight: number | null;
  codec: string | null;
  outputColor: ReferenceColorContract;
  outputChromaLocation: ReferenceChromaLocation;
};

export type DecodedTrack = {
  frameRate: ReferenceRate;
  durationFrames: number | null;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  codec: string;
  decoderPreference: ReferenceHardwareAcceleration;
  firstTimestampUs: number;
  color: ReferenceColorContract;
  chromaLocation: ReferenceChromaLocation;
};

export type PlaneLayoutTransfer = {
  offset: number;
  stride: number;
};

export type PlaneTransfer = {
  format: "I420" | "NV12";
  buffer: ArrayBuffer;
  layout: PlaneLayoutTransfer[];
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  codedRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  visibleRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  timestampUs: number;
  durationUs: number | null;
  color: ReferenceColorContract;
  chromaLocation: ReferenceChromaLocation;
};

export type DecoderCommand =
  | {
      type: "open";
      generation: number;
      url: string;
      expected: ExpectedTrack;
      hardwareAcceleration?: ReferenceHardwareAcceleration;
    }
  | { type: "seek"; generation: number; frame: number }
  | {
      type: "play";
      generation: number;
      frame: number;
      rate: 1 | 2 | 4;
    }
  | { type: "release"; generation: number; buffer: ArrayBuffer }
  | { type: "pause"; generation: number }
  | { type: "close"; generation: number };

export type DecoderEvent =
  | {
      type: "opening";
      generation: number;
      stage: ReferenceOpenStage;
      detail?: string;
    }
  | { type: "ready"; generation: number; track: DecodedTrack }
  | {
      type: "frame";
      generation: number;
      frame: number;
      planes: PlaneTransfer;
    }
  | { type: "window"; generation: number; target: number }
  | { type: "stalled"; generation: number; frame: number }
  | { type: "unsupported"; generation: number; reason: string }
  | { type: "error"; generation: number; reason: string };

const validInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export const assertReferenceRate = (rate: ReferenceRate): void => {
  if (
    !Number.isSafeInteger(rate.num) ||
    rate.num <= 0 ||
    !Number.isSafeInteger(rate.den) ||
    rate.den <= 0
  )
    throw new RangeError("Reference frame rate must be a positive rational.");
};

const roundedDivision = (numerator: bigint, denominator: bigint): bigint => {
  if (numerator >= 0n) return (numerator + denominator / 2n) / denominator;
  return -((-numerator + denominator / 2n) / denominator);
};

export const timestampForReferenceFrame = (
  frame: number,
  firstTimestampUs: number,
  rate: ReferenceRate,
): number => {
  assertReferenceRate(rate);
  if (!validInteger(frame))
    throw new RangeError("Reference frame must be a non-negative integer.");
  if (!Number.isSafeInteger(firstTimestampUs))
    throw new RangeError(
      "First timestamp must be an integer number of microseconds.",
    );
  const offset = roundedDivision(
    BigInt(frame) * 1_000_000n * BigInt(rate.den),
    BigInt(rate.num),
  );
  const timestamp = BigInt(firstTimestampUs) + offset;
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value))
    throw new RangeError(
      "Reference frame timestamp exceeds the safe integer range.",
    );
  return value;
};

export const referenceFrameAtTimestamp = (
  timestampUs: number,
  firstTimestampUs: number,
  rate: ReferenceRate,
): number => {
  assertReferenceRate(rate);
  if (
    !Number.isSafeInteger(timestampUs) ||
    !Number.isSafeInteger(firstTimestampUs)
  )
    throw new RangeError("Reference timestamps must be integer microseconds.");
  const frame = roundedDivision(
    BigInt(timestampUs - firstTimestampUs) * BigInt(rate.num),
    1_000_000n * BigInt(rate.den),
  );
  const value = Number(frame);
  if (!Number.isSafeInteger(value))
    throw new RangeError("Reference frame exceeds the safe integer range.");
  return value;
};

export const referenceTimestampIsExact = (
  timestampUs: number,
  frame: number,
  firstTimestampUs: number,
  rate: ReferenceRate,
): boolean => {
  const expected = timestampForReferenceFrame(frame, firstTimestampUs, rate);
  const frameDurationUs = (1_000_000 * rate.den) / rate.num;
  return Math.abs(timestampUs - expected) <= Math.max(1, frameDurationUs / 4);
};
