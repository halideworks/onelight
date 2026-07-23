/* Option types for the Player component that hosts construct from API
   responses. */

/* One rung of the proxy ladder from GET /versions/:id/renditions. Only the
   video proxy kinds are meaningful here (proxy_540, proxy_1080, proxy_2160). */
export type PlayerRendition = {
  kind: string;
  url: string;
};

/* Time-compressed audio generated for accelerated forward shuttle. Each file
   plays at 1x while the picture plays at the matching rate. */
export type ShuttleAudioSources = {
  x2?: string | null;
  x4?: string | null;
};

export type ShuttleAudioDiagnostic = {
  reason: string;
  rate: 2 | 4 | 0;
  main_ready_state: number | null;
  main_network_state: number | null;
  main_playback_rate: number | null;
  main_current_time: number | null;
  main_paused: boolean | null;
  main_muted: boolean | null;
  main_volume: number | null;
  sidecar_ready_state: number | null;
  sidecar_network_state: number | null;
  sidecar_current_time: number | null;
  sidecar_duration: number | null;
  sidecar_paused: boolean | null;
  sidecar_muted: boolean | null;
  sidecar_volume: number | null;
  sidecar_source_present: boolean;
  sidecar_media_error: number | null;
  document_visibility: "hidden" | "visible" | "prerender" | null;
  online: boolean | null;
  failure: string | null;
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
