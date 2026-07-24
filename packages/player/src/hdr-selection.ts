import type { PlayerRendition } from "./options.js";

type UnknownRecord = Record<string, unknown>;

export type HdrMetadataType =
  "smpteSt2086" | "smpteSt2094-10" | "smpteSt2094-40";

export type HdrRenditionContract = {
  rendition: PlayerRendition;
  contentType: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  transferFunction: "pq" | "hlg";
  colorGamut: "rec2020";
  hdrMetadataType: HdrMetadataType | null;
};

export type HdrQualification = {
  qualified: boolean;
  reason: string;
  contract: HdrRenditionContract | null;
};

export type HdrCapabilityEnvironment = {
  decodingInfo: (
    configuration: MediaDecodingConfiguration,
  ) => Promise<MediaCapabilitiesDecodingInfo>;
  matches: (query: string) => boolean;
};

const recordOrNull = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const positiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

const positiveInteger = (value: unknown): number | null => {
  const result = positiveNumber(value);
  return result !== null && Number.isSafeInteger(result) ? result : null;
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const normalized = (value: unknown): string | null =>
  stringValue(value)
    ?.toLowerCase()
    .replace(/[._\s-]/g, "") ?? null;

const transferFunction = (value: unknown): "pq" | "hlg" | null => {
  const name = normalized(value);
  if (name === "smpte2084" || name === "pq") return "pq";
  if (name === "aribstdb67" || name === "hlg") return "hlg";
  return null;
};

const hdrMetadataType = (value: unknown): HdrMetadataType | null =>
  value === "smpteSt2086" ||
  value === "smpteSt2094-10" ||
  value === "smpteSt2094-40"
    ? value
    : null;

const contractsAgree = (
  source: UnknownRecord,
  output: UnknownRecord,
): boolean =>
  ["primaries", "transfer", "matrix", "range"].every(
    (field) => normalized(source[field]) === normalized(output[field]),
  );

export const hdrRenditionContract = (
  rendition: PlayerRendition,
): HdrRenditionContract | null => {
  if (rendition.kind !== "hdr_av1" && rendition.kind !== "hdr_hevc")
    return null;
  const meta = rendition.meta;
  const source = recordOrNull(meta?.source_color);
  const output = recordOrNull(meta?.output_color);
  const codec = stringValue(meta?.codec);
  const width = positiveInteger(meta?.coded_width);
  const height = positiveInteger(meta?.coded_height);
  const bitrate = positiveInteger(meta?.bit_rate);
  const frameRateNum = positiveInteger(meta?.frame_rate_num);
  const frameRateDen = positiveInteger(meta?.frame_rate_den);
  const transfer = transferFunction(output?.transfer);
  const metadataType = hdrMetadataType(meta?.hdr_metadata_type);
  if (
    !source ||
    !output ||
    source.assumed === true ||
    !codec ||
    !width ||
    !height ||
    !bitrate ||
    !frameRateNum ||
    !frameRateDen ||
    normalized(output.primaries) !== "bt2020" ||
    !transfer ||
    !contractsAgree(source, output)
  )
    return null;
  if (transfer === "pq" && !metadataType) return null;
  return {
    rendition,
    contentType: `video/mp4; codecs="${codec}"`,
    width,
    height,
    bitrate,
    framerate: frameRateNum / frameRateDen,
    transferFunction: transfer,
    colorGamut: "rec2020",
    hdrMetadataType: metadataType,
  };
};

const defaultEnvironment = (): HdrCapabilityEnvironment | null => {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaCapabilities?.decodingInfo ||
    typeof matchMedia === "undefined"
  )
    return null;
  return {
    decodingInfo: (configuration) =>
      navigator.mediaCapabilities.decodingInfo(configuration),
    matches: (query) => matchMedia(query).matches,
  };
};

export const qualifyNativeHdr = async (
  rendition: PlayerRendition,
  environment: HdrCapabilityEnvironment | null = defaultEnvironment(),
): Promise<HdrQualification> => {
  const contract = hdrRenditionContract(rendition);
  if (!contract)
    return {
      qualified: false,
      reason:
        "HDR rendition metadata is incomplete or conflicts with the source.",
      contract: null,
    };
  if (!environment)
    return {
      qualified: false,
      reason: "The browser does not expose HDR decode capability checks.",
      contract,
    };
  if (!environment.matches("(video-dynamic-range: high)"))
    return {
      qualified: false,
      reason: "The current display path does not report high dynamic range.",
      contract,
    };
  if (!environment.matches("(video-color-gamut: rec2020)"))
    return {
      qualified: false,
      reason: "The current display path does not report a Rec.2020 gamut.",
      contract,
    };
  const video = {
    contentType: contract.contentType,
    width: contract.width,
    height: contract.height,
    bitrate: contract.bitrate,
    framerate: contract.framerate,
    transferFunction: contract.transferFunction,
    colorGamut: contract.colorGamut,
    ...(contract.hdrMetadataType
      ? { hdrMetadataType: contract.hdrMetadataType }
      : {}),
  };
  try {
    const result = await environment.decodingInfo({
      type: "file",
      video,
    });
    if (!result.supported || !result.smooth)
      return {
        qualified: false,
        reason:
          "The exact HDR codec and display contract is not both supported and smooth.",
        contract,
      };
    return {
      qualified: true,
      reason: "The exact native HDR path reports supported and smooth.",
      contract,
    };
  } catch {
    return {
      qualified: false,
      reason: "The browser rejected the exact HDR capability query.",
      contract,
    };
  }
};
