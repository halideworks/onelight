import {
  isHdrTransfer,
  isSdrGammaTransfer,
  referenceMatrixFromMetadata,
  referencePrimariesFromMetadata,
} from "./color-math.js";
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
  /* Separator-stripping is what lets "BT.709" and "bt709" agree, but it also
     flattens the one canonical name that contains a separator. WebCodecs says
     "bt2020-ncl" and the decoded frame is reconciled against this contract by
     string equality, so the canonical spelling has to come back out.

     Both spellings arrive in practice and they are not the same string.
     ffprobe -- and therefore every rendition's stored metadata -- writes
     "bt2020nc"; WebCodecs writes "bt2020-ncl". Mapping only the latter left
     the former unrecognised, so referenceMatrixFromMetadata returned null and
     reference playback was refused for EVERY BT.2020 rendition, HDR included.
     Tested against the decoder's spelling and not the pipeline's, which is
     exactly the half that was wrong. */
  if (result === "bt2020ncl" || result === "bt2020nc") return "bt2020-ncl";
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
  /* The HDR renditions carry the grade at its own transfer and gamut, which
     the renderer can now decode, so they are eligible where before only the
     tonemapped SDR proxies were. Everything else about the contract still
     has to hold: complete colour metadata, a derivable gamut, an implemented
     matrix, exact frame timing. */
  if (
    !rendition.kind.startsWith("proxy_") &&
    rendition.kind !== "watermarked" &&
    rendition.kind !== "hdr_hevc" &&
    rendition.kind !== "hdr_av1"
  )
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
  /* What the renderer can actually put on screen correctly, which is no
     longer only BT.709. The gamut transform handles any primaries it can
     derive a matrix for, and the YUV stage handles the matrices it
     implements, so the gate asks those two questions directly instead of
     naming one space. Anything outside them is refused rather than
     approximated -- that is the fail-closed contract the whole reference path
     rests on.

     The transfer stays SDR-only: PQ and HLG describe genuinely different code
     values and need the output-path work before they can be offered. */
  if (!referencePrimariesFromMetadata(output.primaries))
    return {
      contract: null,
      reason: `Reference playback cannot render ${output.primaries} primaries.`,
    };
  if (!referenceMatrixFromMetadata(output.matrix))
    return {
      contract: null,
      reason: `Reference playback cannot render the ${output.matrix} matrix.`,
    };
  /* SDR or one of the HDR curves the shader implements. Anything else --
     linear, a log encoding, an unknown tag -- is refused rather than guessed
     at, exactly as an unplaceable gamut is. */
  if (!isSdrGammaTransfer(output.transfer) && !isHdrTransfer(output.transfer))
    return {
      contract: null,
      reason: `Reference playback cannot render the ${output.transfer} transfer.`,
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
