import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  boxToPoint,
  clampPan,
  clampScale,
  fitScale,
  pointToBox,
  steppedScale,
  zoomAbout,
  zoomLabel,
} from "./image-view.js";

const image = { width: 4000, height: 3000 };
const box = { width: 1000, height: 600 };

describe("still viewer zoom and pan", () => {
  it("fits by the tighter axis", () => {
    /* Height is the constraint here: 600/3000 is smaller than 1000/4000. */
    expect(fitScale(image, box)).toBeCloseTo(0.2, 6);
    expect(fitScale({ width: 100, height: 100 }, box)).toBeCloseTo(6, 6);
    /* A picture with no size yet must not divide by zero. */
    expect(fitScale({ width: 0, height: 0 }, box)).toBe(1);
  });

  it("centres the picture in any axis where it is smaller than the box", () => {
    const panned = clampPan({ scale: 0.2, x: 400, y: -300 }, image, box);
    /* At 0.2 the picture is 800x600: narrower than the box, exactly as tall. */
    expect(panned.x).toBe(0);
    expect(panned.y).toBe(0);
  });

  it("bounds panning by the picture's own edges once it overflows", () => {
    /* At 1:1 the picture is 4000x3000 inside a 1000x600 box. */
    const limitX = (4000 - 1000) / 2;
    const limitY = (3000 - 600) / 2;
    expect(clampPan({ scale: 1, x: 99999, y: 0 }, image, box).x).toBe(limitX);
    expect(clampPan({ scale: 1, x: -99999, y: 0 }, image, box).x).toBe(-limitX);
    expect(clampPan({ scale: 1, x: 0, y: 99999 }, image, box).y).toBe(limitY);
    /* Inside the bounds nothing is moved. */
    expect(clampPan({ scale: 1, x: 120, y: -80 }, image, box)).toEqual({
      scale: 1,
      x: 120,
      y: -80,
    });
  });

  it("keeps the point under the pointer still while zooming", () => {
    const start = { scale: 1, x: 0, y: 0 };
    /* A point 300px right and 100px down from the box centre. */
    const pointer = { x: 300, y: 100 };
    const before = boxToPoint(
      { x: box.width / 2 + pointer.x, y: box.height / 2 + pointer.y },
      start,
      image,
      box,
    );
    const zoomed = zoomAbout(start, 2, pointer, image, box);
    const after = pointToBox(before, zoomed, image, box);
    expect(after.x).toBeCloseTo(box.width / 2 + pointer.x, 6);
    expect(after.y).toBeCloseTo(box.height / 2 + pointer.y, 6);
    expect(zoomed.scale).toBe(2);
  });

  it("lets a picture larger than the smallest step still fit", () => {
    /* A 4096 wide still in a 390 wide phone stage fits at 9.5 percent, which
       is below the smallest zoom step. Clamping to the step made "Fit" not
       fit: the picture overflowed the stage and the page had to be scrolled
       to see the right of it. */
    const phone = { width: 390, height: 600 };
    const big = { width: 4096, height: 2730 };
    const fit = fitScale(big, phone);
    expect(fit).toBeLessThan(MIN_SCALE);
    expect(clampScale(fit, fit)).toBeCloseTo(fit, 9);
    expect(big.width * clampScale(fit, fit)).toBeLessThanOrEqual(phone.width);
    /* Without a floor the old behaviour is unchanged. */
    expect(clampScale(fit)).toBe(MIN_SCALE);
  });

  it("refuses to zoom past the ends", () => {
    const huge = zoomAbout(
      { scale: MAX_SCALE, x: 0, y: 0 },
      4,
      { x: 0, y: 0 },
      image,
      box,
    );
    expect(huge.scale).toBe(MAX_SCALE);
    const tiny = zoomAbout(
      { scale: MIN_SCALE, x: 0, y: 0 },
      0.1,
      { x: 0, y: 0 },
      image,
      box,
    );
    expect(tiny.scale).toBe(MIN_SCALE);
  });

  it("steps between the fixed magnifications, from anywhere in between", () => {
    expect(steppedScale(1, 1)).toBe(1.5);
    expect(steppedScale(1, -1)).toBe(0.75);
    /* An odd fit scale steps to the neighbouring stops, not to itself. */
    expect(steppedScale(0.2, 1)).toBe(0.25);
    expect(steppedScale(0.2, -1)).toBe(0.125);
    expect(steppedScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(steppedScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });

  it("maps normalized points to the box and back", () => {
    const state = { scale: 2, x: -140, y: 60 };
    for (const point of [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
      [0.23, 0.81],
    ] as Array<[number, number]>) {
      const at = pointToBox(point, state, image, box);
      const round = boxToPoint(at, state, image, box);
      expect(round[0]).toBeCloseTo(point[0], 9);
      expect(round[1]).toBeCloseTo(point[1], 9);
    }
    /* The centre of the picture sits at the box centre plus the offset. */
    const centre = pointToBox([0.5, 0.5], state, image, box);
    expect(centre.x).toBeCloseTo(box.width / 2 - 140, 6);
    expect(centre.y).toBeCloseTo(box.height / 2 + 60, 6);
  });

  it("writes zoom the way a viewer reads it", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(2.5)).toBe("250%");
    expect(zoomLabel(0.125)).toBe("12.5%");
    expect(zoomLabel(0.2)).toBe("20%");
  });
});
