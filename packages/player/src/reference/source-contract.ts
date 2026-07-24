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

export const referenceSourceContract = (
  rendition: PlayerRendition | null,
  rate: ReferenceRate,
  durationFrames: number | null,
): SourceContract | null => {
  if (!rendition?.url || !rendition.kind.startsWith("proxy_")) return null;
  const meta = rendition.meta;
  if (!meta) return null;
  const frameRateNum = positiveIntegerOrNull(meta.frame_rate_num);
  const frameRateDen = positiveIntegerOrNull(meta.frame_rate_den);
  const codedWidth = positiveIntegerOrNull(meta.coded_width ?? meta.width);
  const codedHeight = positiveIntegerOrNull(meta.coded_height ?? meta.height);
  if (
    frameRateNum !== rate.num ||
    frameRateDen !== rate.den ||
    !codedWidth ||
    !codedHeight ||
    codedWidth > MAX_REFERENCE_WIDTH ||
    codedHeight > MAX_REFERENCE_HEIGHT ||
    frameRateNum / frameRateDen > MAX_REFERENCE_FRAMES_PER_SECOND ||
    !Number.isSafeInteger(durationFrames) ||
    durationFrames === null ||
    durationFrames <= 0
  )
    return null;
  const output = outputColorContract(meta.output_color);
  if (
    !output ||
    output.primaries !== "bt709" ||
    output.transfer !== "bt709" ||
    output.matrix !== "bt709" ||
    output.range !== "tv"
  )
    return null;
  return {
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
  };
};
