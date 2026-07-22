/* Zoom and pan maths for the still viewer. Pure, so the behaviour that is
   easy to get subtly wrong -- keeping the point under the pointer still while
   zooming, and never letting the picture be thrown off the table -- is tested
   directly rather than by eye. */

export interface Size {
  width: number;
  height: number;
}

export interface ViewState {
  /** Displayed pixels per image pixel. 1 is one-to-one. */
  scale: number;
  /** Offset of the picture's centre from the box's centre, in displayed px. */
  x: number;
  y: number;
}

export const IDENTITY: ViewState = { scale: 1, x: 0, y: 0 };

/* A colourist zooms in steps, not smoothly, when they are checking a detail
   against a reference: the same magnifications every time means the same
   comparison every time. The wheel is continuous; these are what the buttons
   and the keyboard use. */
export const ZOOM_STEPS = [
  0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16,
] as const;

export const MIN_SCALE: number = ZOOM_STEPS[0];
export const MAX_SCALE: number = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;

/* The floor is a parameter because a very large picture in a small box fits
   BELOW the smallest zoom step: a 4096 wide still in a 390 wide phone stage
   fits at 9.5%, and clamping that up to 12.5% made "Fit" not fit. Callers
   pass the fit scale as the floor when they know it. */
export const clampScale = (scale: number, floor = MIN_SCALE): number =>
  Math.min(MAX_SCALE, Math.max(Math.min(floor, MIN_SCALE), scale));

/** The scale at which the whole picture is visible inside the box. */
export const fitScale = (image: Size, box: Size): number => {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    box.width <= 0 ||
    box.height <= 0
  )
    return 1;
  return Math.min(box.width / image.width, box.height / image.height);
};

/**
 * Keep the picture reachable. While it is smaller than the box in an axis it
 * stays centred on that axis (there is nothing to pan to); once it overflows,
 * panning is bounded by its own edges, so the picture can never be dragged
 * into empty space and lost.
 */
export const clampPan = (
  state: ViewState,
  image: Size,
  box: Size,
): ViewState => {
  const shown = {
    width: image.width * state.scale,
    height: image.height * state.scale,
  };
  const limitX = Math.max(0, (shown.width - box.width) / 2);
  const limitY = Math.max(0, (shown.height - box.height) / 2);
  /* The `|| 0` is not decoration: clamping a negative offset against a zero
     limit yields -0, which reaches the DOM as "translate(-0px)". */
  return {
    scale: state.scale,
    x: Math.min(limitX, Math.max(-limitX, state.x)) || 0,
    y: Math.min(limitY, Math.max(-limitY, state.y)) || 0,
  };
};

/**
 * Zoom about a point in the box (measured from its centre), so whatever is
 * under the pointer stays under the pointer. Without this, zooming walks the
 * detail you were looking at off the screen and you chase it with the mouse.
 */
export const zoomAbout = (
  state: ViewState,
  factor: number,
  pointer: { x: number; y: number },
  image: Size,
  box: Size,
  floor = MIN_SCALE,
): ViewState => {
  const scale = clampScale(state.scale * factor, floor);
  const applied = scale / state.scale;
  return clampPan(
    {
      scale,
      x: pointer.x - (pointer.x - state.x) * applied,
      y: pointer.y - (pointer.y - state.y) * applied,
    },
    image,
    box,
  );
};

/** The next step up or down from where the view is now. */
export const steppedScale = (
  scale: number,
  direction: 1 | -1,
  floor = MIN_SCALE,
): number => {
  if (direction === 1)
    return ZOOM_STEPS.find((step) => step > scale + 1e-6) ?? MAX_SCALE;
  const below = ZOOM_STEPS.filter((step) => step < scale - 1e-6);
  return below[below.length - 1] ?? Math.min(floor, MIN_SCALE);
};

/**
 * Where a point on the picture (normalized 0..1) lands inside the box, in
 * displayed pixels from the box's top left. This is what puts an annotation
 * on the same pixels it was drawn on at a different zoom.
 */
export const pointToBox = (
  point: readonly [number, number],
  state: ViewState,
  image: Size,
  box: Size,
): { x: number; y: number } => ({
  x: box.width / 2 + state.x + (point[0] - 0.5) * image.width * state.scale,
  y: box.height / 2 + state.y + (point[1] - 0.5) * image.height * state.scale,
});

/** The inverse: a position in the box, as a normalized point on the picture. */
export const boxToPoint = (
  position: { x: number; y: number },
  state: ViewState,
  image: Size,
  box: Size,
): [number, number] => [
  (position.x - box.width / 2 - state.x) / (image.width * state.scale) + 0.5,
  (position.y - box.height / 2 - state.y) / (image.height * state.scale) + 0.5,
];

/** Percentage, the way a viewer writes it: 100%, 250%, 12.5%. */
export const zoomLabel = (scale: number): string => {
  const percent = scale * 100;
  return `${percent >= 100 ? Math.round(percent) : Number(percent.toFixed(1))}%`;
};
