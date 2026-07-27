import type { ColorPlaybackMode } from "./options.js";

export type ReferenceSelectionInput = {
  mode: ColorPlaybackMode;
  selfCheckOutcome: "pass" | "warning" | "unsupported" | null;
  available: boolean;
  automaticQualified: boolean;
  /* The rendition on screen is HDR AND this display can show that grade
     natively. Both halves matter: an HDR rendition on an SDR display is not
     handled natively in any useful sense, and an SDR proxy on an HDR display
     has no grade at stake. */
  hdrHandledNatively?: boolean;
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
 *
 * Nothing may take an HDR grade away from a display that can show it, and
 * that includes asking for reference by name. The reference renderer tone-maps
 * HDR onto an SDR canvas because no browser will give it anything else:
 * measured on shipped Chrome 150 and Safari 26.5.2, WebGL cannot output HDR by
 * any route, and the one canvas that can (WebGPU extended range) needs the
 * display's headroom, which is unqueryable, slides with the brightness slider
 * and is misreported by the only media query there is. So on an HDR display
 * the choice is a real HDR picture from the native path or a tone-mapped one
 * from reference, and offering a reviewer the second is offering them a worse
 * picture with a better label. Native wins there until a PQ canvas ships.
 *
 * On an SDR display the same tone map is exactly right -- better than the
 * browser's, and frame-accurate with it -- so reference keeps HDR there.
 */
export const shouldRequestReferencePlayback = ({
  mode,
  available,
  automaticQualified,
  hdrHandledNatively = false,
}: ReferenceSelectionInput): boolean =>
  available &&
  !hdrHandledNatively &&
  (mode === "reference" || (mode === "automatic" && automaticQualified));
