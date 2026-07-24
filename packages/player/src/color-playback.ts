import type { ColorPlaybackMode, PlayerColorContract } from "./options.js";

export const COLOR_PLAYBACK_MODE_KEY = "onelight.color-playback-mode";

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const recordOrNull = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const colorContractFrom = (
  value: unknown,
): PlayerColorContract | null => {
  const record = recordOrNull(value);
  if (!record) return null;
  const contract = {
    primaries: stringOrNull(record.primaries),
    transfer: stringOrNull(record.transfer),
    matrix: stringOrNull(record.matrix),
    range: stringOrNull(record.range),
    assumed: record.assumed === true,
    assumption: stringOrNull(record.assumption),
  };
  return contract.primaries ||
    contract.transfer ||
    contract.matrix ||
    contract.range ||
    contract.assumption
    ? contract
    : null;
};

export const renditionColorContracts = (
  meta: Record<string, unknown> | undefined,
): {
  source: PlayerColorContract | null;
  output: PlayerColorContract | null;
} => ({
  source: colorContractFrom(meta?.source_color),
  output: colorContractFrom(meta?.output_color),
});

export const readColorPlaybackMode = (
  storage: Pick<Storage, "getItem"> | null,
): ColorPlaybackMode => {
  if (!storage) return "automatic";
  try {
    const value = storage.getItem(COLOR_PLAYBACK_MODE_KEY);
    return value === "native" || value === "reference" ? value : "automatic";
  } catch {
    return "automatic";
  }
};

export const writeColorPlaybackMode = (
  storage: Pick<Storage, "setItem"> | null,
  mode: ColorPlaybackMode,
): void => {
  if (!storage) return;
  try {
    storage.setItem(COLOR_PLAYBACK_MODE_KEY, mode);
  } catch {
    // The selected mode remains active for this page when storage is blocked.
  }
};

export const colorContractValue = (value: string | null): string =>
  value ?? "Not reported";

export const colorMaximumDelta = (
  value: readonly [number, number, number] | null,
): string =>
  value
    ? `${String(value[0])} R, ${String(value[1])} G, ${String(value[2])} B`
    : "Not measured";
