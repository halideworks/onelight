import type { ColorPlaybackMode } from "./options.js";

export type ReferenceSelectionInput = {
  mode: ColorPlaybackMode;
  selfCheckOutcome: "pass" | "warning" | "unsupported" | null;
  available: boolean;
  automaticQualified: boolean;
};

export const shouldRequestReferencePlayback = ({
  mode,
  selfCheckOutcome,
  available,
  automaticQualified,
}: ReferenceSelectionInput): boolean =>
  available &&
  (mode === "reference" ||
    (mode === "automatic" &&
      automaticQualified &&
      selfCheckOutcome === "warning"));
