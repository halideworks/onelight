/* Option types for the Player component that hosts construct from API
   responses. */

/* One rung of the proxy ladder from GET /versions/:id/renditions. Only the
   video proxy kinds are meaningful here (proxy_540, proxy_1080, proxy_2160). */
export type PlayerRendition = {
  kind: string;
  url: string;
};

/* Viewing-environment surround (design doc 24.1): the stage background
   around the footage. Dark is the review-room default, grey18 is the 18%
   reflectance grey, black is true black. All three are R=G=B. */
export type SurroundMode = "dark" | "grey18" | "black";

/* Session watermark overlay. This is deterrent-grade only: it is a DOM
   overlay a viewer can remove with DevTools (the design doc documents this
   honestly); the tamper-resistant path is the burned per-link rendition. */
export type WatermarkOverlay = {
  lines: string[];
  mode?: "tile" | "corner";
  position?:
    "top_left" | "top_right" | "bottom_left" | "bottom_right" | "center";
  opacity?: number;
};
