import type { ColorSelfCheckResult } from "./color-self-check.js";
import type { PlayerColorContract } from "./options.js";

export const COLOR_CHECK_SCOPE =
  "Digital scope only. This checks tagged BT.709 decode through sRGB canvas readback. It does not test native video composition, ColorSync or ICC transforms, the GPU output path, or the display. A pass is not display calibration.";

export type ColorCheckState = "checking" | "passed" | "warning" | "unavailable";

export type ColorCheckPresentation = {
  label: string;
  state: ColorCheckState;
  summary: string;
  detail: string;
};

type ColorCheckResultSummary = Pick<
  ColorSelfCheckResult,
  "outcome" | "stage" | "deviation" | "failure"
>;

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

export const colorCheckPresentation = (
  result: ColorCheckResultSummary | null,
): ColorCheckPresentation => {
  if (!result)
    return {
      label: "Checking decode",
      state: "checking",
      summary: "Running",
      detail: "The decode-to-canvas check is still running.",
    };
  if (result.outcome === "pass")
    return {
      label: "Decode check passed",
      state: "passed",
      summary: "Passed at canvas readback",
      detail: "No decode-to-canvas discrepancy was measured.",
    };
  if (result.outcome === "warning")
    return {
      label: "Decode check warning",
      state: "warning",
      summary: `Warning: ${result.deviation} deviation`,
      detail:
        result.failure ??
        `Decoded BT.709 test pixels exceeded the readback tolerance with a ${result.deviation} deviation.`,
    };
  return {
    label: "Decode check unavailable",
    state: "unavailable",
    summary: `Unavailable at ${result.stage}`,
    detail:
      result.failure ??
      "The browser could not complete the decode-to-canvas check.",
  };
};

export const colorContractValue = (value: string | null): string =>
  value ?? "Not reported";

export const colorMaximumDelta = (
  value: readonly [number, number, number] | null,
): string =>
  value
    ? `${String(value[0])} R, ${String(value[1])} G, ${String(value[2])} B`
    : "Not measured";
