import type {
  DecodedTrack,
  ExpectedTrack,
  PlaneTransfer,
} from "./reference/protocol.js";

export type PicturePlaybackRate = 1 | 2 | 4;

export type SourceContract = {
  url: string;
  expected: ExpectedTrack;
};

export interface PictureBackend {
  load(source: SourceContract, frame: number): Promise<void>;
  seek(frame: number, discontinuity?: boolean): void;
  play(frame: number, rate: PicturePlaybackRate): void;
  pause(): void;
  close(): void;
}

export type ReferenceFailureClass =
  | "decoder_unsupported"
  | "demux"
  | "decode"
  | "metadata_conflict"
  | "raw_format"
  | "renderer"
  | "context_lost"
  | "allocation"
  | "starvation"
  | "timestamp"
  | "output_order"
  | "unknown";

export type ReferenceFailure = {
  failureClass: ReferenceFailureClass;
  reason: string;
  frame: number;
  playing: boolean;
};

export type ReferenceBackendCallbacks = {
  render(planes: PlaneTransfer, frame: number): void;
  onReady?(track: DecodedTrack): void;
  onFrame?(frame: number): void;
  onFailure?(failure: ReferenceFailure): void;
};

const includesAny = (value: string, candidates: readonly string[]): boolean =>
  candidates.some((candidate) => value.includes(candidate));

export const classifyReferenceFailure = (
  reason: string,
  unsupported: boolean,
): ReferenceFailureClass => {
  const value = reason.toLowerCase();
  if (includesAny(value, ["presentation order", "output order"]))
    return "output_order";
  if (value.includes("timestamp")) return "timestamp";
  if (
    includesAny(value, ["color metadata", "decoder contract", "does not match"])
  )
    return "metadata_conflict";
  if (includesAny(value, ["i420", "nv12", "raw frame", "pixel format"]))
    return "raw_format";
  if (value.includes("context") && value.includes("lost"))
    return "context_lost";
  if (includesAny(value, ["webgl", "renderer", "shader", "texture"]))
    return "renderer";
  if (includesAny(value, ["allocation", "out of memory", "buffer"]))
    return "allocation";
  if (includesAny(value, ["starved", "stalled", "starvation"]))
    return "starvation";
  if (includesAny(value, ["demux", "packet", "keyframe", "container"]))
    return "demux";
  if (unsupported || includesAny(value, ["videodecoder", "not support"]))
    return "decoder_unsupported";
  if (includesAny(value, ["decode", "decoder"])) return "decode";
  return "unknown";
};

export const boundedReferenceReason = (reason: unknown): string => {
  const value = reason instanceof Error ? reason.message : String(reason);
  return value.slice(0, 500);
};
