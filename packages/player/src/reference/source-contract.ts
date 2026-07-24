import type { PlayerRendition } from "../options.js";
import type { SourceContract } from "../picture-backend.js";
import type {
  ReferenceChromaLocation,
  ReferenceColorContract,
  ReferenceRate,
} from "./protocol.js";

type UnknownRecord = Record<string, unknown>;

const recordOrNull = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const positiveIntegerOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const normalizedColorName = (value: unknown): string | null => {
  const result = stringOrNull(value)
    ?.toLowerCase()
    .replace(/[._\s-]/g, "");
  if (!result) return null;
  if (result === "bt709" || result === "rec709") return "bt709";
  return result;
};

const normalizedRange = (value: unknown): "tv" | "pc" | null => {
  const result = stringOrNull(value)?.toLowerCase();
  if (result === "tv" || result === "limited" || result === "mpeg") return "tv";
  if (result === "pc" || result === "full" || result === "jpeg") return "pc";
  return null;
};

const MAX_REFERENCE_WIDTH = 4096;
const MAX_REFERENCE_HEIGHT = 2160;
const MAX_REFERENCE_FRAMES_PER_SECOND = 30;

const chromaLocation = (value: unknown): ReferenceChromaLocation | null => {
  const result = stringOrNull(value)?.toLowerCase();
  return result === "left" || result === "center" || result === "topleft"
    ? result
    : null;
};

const outputColorContract = (
  value: unknown,
):
  | (ReferenceColorContract & { chromaLocation: ReferenceChromaLocation })
  | null => {
  const record = recordOrNull(value);
  if (!record) return null;
  const primaries = normalizedColorName(record.primaries);
  const transfer = normalizedColorName(record.transfer);
  const matrix = normalizedColorName(record.matrix);
  const range = normalizedRange(record.range);
  const location = chromaLocation(
    record.chroma_location ?? record.chromaLocation,
  );
  if (!primaries || !transfer || !matrix || !range || !location) return null;
  return {
    primaries,
    transfer,
    matrix,
    range,
    chromaLocation: location,
  };
};

export interface ReferenceSourceAvailability {
  contract: SourceContract | null;
  reason: string | null;
}

export const referenceSourceAvailability = (
  rendition: PlayerRendition | null,
  rate: ReferenceRate,
  durationFrames: number | null,
): ReferenceSourceAvailability => {
  if (!rendition?.url)
    return {
      contract: null,
      reason: "No playable rendition is active.",
    };
  if (!rendition.kind.startsWith("proxy_") && rendition.kind !== "watermarked")
    return {
      contract: null,
      reason:
        "Reference playback supports SDR review and watermarked renditions only.",
    };
  const meta = rendition.meta;
  if (!meta)
    return {
      contract: null,
      reason: "This rendition is missing its decode metadata.",
    };
  const frameRateNum = positiveIntegerOrNull(meta.frame_rate_num);
  const frameRateDen = positiveIntegerOrNull(meta.frame_rate_den);
  const codedWidth = positiveIntegerOrNull(meta.coded_width ?? meta.width);
  const codedHeight = positiveIntegerOrNull(meta.coded_height ?? meta.height);
  if (frameRateNum !== rate.num || frameRateDen !== rate.den)
    return {
      contract: null,
      reason: "The rendition frame rate does not match the asset timeline.",
    };
  if (!codedWidth || !codedHeight)
    return {
      contract: null,
      reason: "The rendition dimensions were not reported.",
    };
  if (
    codedWidth > MAX_REFERENCE_WIDTH ||
    codedHeight > MAX_REFERENCE_HEIGHT ||
    frameRateNum / frameRateDen > MAX_REFERENCE_FRAMES_PER_SECOND
  )
    return {
      contract: null,
      reason: "Reference playback currently supports up to 4K at 30 fps.",
    };
  if (
    !Number.isSafeInteger(durationFrames) ||
    durationFrames === null ||
    durationFrames <= 0
  )
    return {
      contract: null,
      reason: "The exact frame duration was not reported.",
    };
  const output = outputColorContract(meta.output_color);
  if (!output)
    return {
      contract: null,
      reason: "The rendition is missing its complete output color contract.",
    };
  if (
    output.primaries !== "bt709" ||
    output.transfer !== "bt709" ||
    output.matrix !== "bt709" ||
    output.range !== "tv"
  )
    return {
      contract: null,
      reason: "Reference playback requires a limited-range BT.709 rendition.",
    };
  return {
    contract: {
      url: rendition.url,
      expected: {
        frameRate: rate,
        durationFrames,
        codedWidth,
        codedHeight,
        codec: stringOrNull(meta.codec),
        outputColor: {
          primaries: output.primaries,
          transfer: output.transfer,
          matrix: output.matrix,
          range: output.range,
        },
        outputChromaLocation: output.chromaLocation,
      },
    },
    reason: null,
  };
};

export const referenceSourceContract = (
  rendition: PlayerRendition | null,
  rate: ReferenceRate,
  durationFrames: number | null,
): SourceContract | null =>
  referenceSourceAvailability(rendition, rate, durationFrames).contract;
