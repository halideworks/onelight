export const FRAME_WINDOW_BEHIND = 2;
export const FRAME_WINDOW_AHEAD = 3;
export const MAX_OPEN_FRAMES = FRAME_WINDOW_BEHIND + 1 + FRAME_WINDOW_AHEAD;
export const MAX_DECODE_QUEUE = 6;
export const MAX_PLANE_BUFFERS = 8;

/*
 * Playback spends its budget asymmetrically: one frame behind instead of two,
 * buying a fourth frame of forward runway. Nobody back-steps while playing,
 * and the extra runway is what keeps Safari's one-frame-per-packet delivery
 * ahead of the clock (180/180 frames presented against 123 with the symmetric
 * shape, measured on an M3 Ultra). The shape once lost a frame per window
 * jump -- it does not tile with the seek window that precedes it, and a
 * refused continuation used to wipe the emission frontier -- so the worker
 * now carries the frontier across window boundaries and backfills any hole
 * between it and the new window's first from the keyframe walk.
 */
export const PLAY_WINDOW_BEHIND = 1;
export const PLAY_WINDOW_AHEAD = 4;

/*
 * Decode-order delivery.
 *
 * WebCodecs specifies presentation-order output and Chromium delivers it, but
 * WebKit emits one frame per fed packet in the order fed, so a stream with
 * B-frames arrives shuffled by the codec's reorder depth. Both constants below
 * exist to absorb that without weakening what they guard.
 *
 * MAX_DECODE_REORDER: how far below the highest frame produced so far a later
 * output may legally sit. H.264's own ceiling on reordering is the bound past
 * which an output is a fault rather than a reorder.
 *
 * RETAIN_REORDER_SLACK: how far past the window's end a decoded frame is still
 * worth keeping. Completing a window that ends at frame L means feeding every
 * packet whose frame is at or below L; on our own proxies a packet's frame
 * runs up to three ahead and two behind its position in the stream, so the
 * last packet worth feeding still produces frames as far out as L+5. Those
 * frames are the next window's work and their packets are consumed once.
 */
export const MAX_DECODE_REORDER = 16;
export const RETAIN_REORDER_SLACK = 8;

/* A decoder that reorders within its codec's limits is doing its job; one that
   hands back a frame from far behind has lost the thread. */
export const decodeOutputIsOutOfOrder = (
  frame: number,
  maxOutputFrame: number | null,
): boolean =>
  maxOutputFrame !== null && frame < maxOutputFrame - MAX_DECODE_REORDER;

/* Every frame of the window accounted for. A high-water mark cannot answer
   this where the decoder emits in decode order, since a frame past the
   window's end can arrive while earlier ones are still to come. */
export const decodeWindowIsComplete = (
  first: number,
  last: number,
  accountedFor: (frame: number) => boolean,
): boolean => {
  for (let frame = first; frame <= last; frame += 1)
    if (!accountedFor(frame)) return false;
  return true;
};

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

/* The pixel layouts the reference path accepts. I420P10 is 10-bit samples in
   the low bits of 16-bit words, which is what a WebCodecs decoder hands back
   for HDR; everything else here is 8-bit. */
export type ReferencePlaneFormat = "I420" | "NV12" | "I420P10";

export type PlaneTransfer = {
  format: ReferencePlaneFormat;
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
      type: "scrub";
      generation: number;
      frame: number;
      /* A fast-moving pointer wants picture updates, not exactness: coarse
         decodes only the keyframe at or before the target (one decode per
         sample instead of a GOP walk) and presents it at its true index.
         The release gesture still runs an exact seek. */
      coarse?: boolean;
    }
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
