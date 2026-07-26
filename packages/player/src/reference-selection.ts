import type { ColorPlaybackMode } from "./options.js";

export type ReferenceSelectionInput = {
  mode: ColorPlaybackMode;
  selfCheckOutcome: "pass" | "warning" | "unsupported" | null;
  available: boolean;
  automaticQualified: boolean;
};

/*
 * Automatic means the best renderer this machine can actually run, not the
 * browser's renderer with a rescue attached. It used to ask for reference
 * only where the decode self-check had already come back suspect, which made
 * the accurate path something a reviewer had to know about and choose; the
 * product's whole claim is that what you see is the file.
 *
 * `available` is not a preference, it is the fail-closed contract: the
 * rendition must carry complete, agreeing colour metadata and the runtime
 * must pass its capability checks before it is ever true. Hardware nobody has
 * measured is caught by the recovery ladder, which escalates to a software
 * decoder and then surrenders to native at the same frame, rather than by
 * refusing to try.
 *
 * `selfCheckOutcome` no longer decides anything and stays for the diagnostic
 * record; `automaticQualified` remains the switch for turning the default
 * back off per platform class if a real one ever needs it.
 */
export const shouldRequestReferencePlayback = ({
  mode,
  available,
  automaticQualified,
}: ReferenceSelectionInput): boolean =>
  available &&
  (mode === "reference" || (mode === "automatic" && automaticQualified));
